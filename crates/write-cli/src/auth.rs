//! `login`, `login status`, `logout`, `whoami` and `accounts`.

use std::io::{IsTerminal, Read};
use std::time::Duration;

use serde_json::{Value, json};
use silicon_accounts_client::{DevicePoll, TokenResponse};

use crate::ctx::{Ctx, DOCS_URL, WEB_URL};
use crate::error::{CliError, CliResult};
use crate::session::{APP_ID, Session, accounts_client, revoke, rfc3339};

pub struct LoginOptions {
    pub slt: Option<String>,
    pub token_stdin: bool,
    pub force: bool,
    pub label: Option<String>,
}

fn session_json(session: &Session, api_url: &str) -> Value {
    let mut value = json!({
        "authenticated": true,
        "app_id": APP_ID,
        "id": session.account.id,
        "uuid": session.account.uuid,
        "kind": session.account.kind,
        "display_name": session.account.display_name,
        "method": session.method,
        "accounts_url": session.accounts_url,
        "api_url": api_url,
        "expires_at": rfc3339(session.expires_at),
    });
    if let Some(email) = &session.account.email {
        value["email"] = json!(email);
    }
    value
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "this machine".into())
}

pub async fn login(ctx: &Ctx, options: LoginOptions) -> CliResult<()> {
    if let Some(existing) = ctx.store.load()?
        && !options.force
    {
        return Err(CliError::new(
            "conflict",
            format!(
                "You are already signed in to Silicon Write as {}.",
                existing.account.id
            ),
            "Run `write logout` first, or pass --force to sign in again.",
        ));
    }
    let slt = if options.token_stdin {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf).map_err(|e| {
            CliError::io(
                format!("Could not read the short-lived token from stdin: {e}."),
                e,
            )
        })?;
        Some(buf)
    } else {
        options.slt.clone()
    };
    let accounts = accounts_client(&ctx.accounts_url)?;
    let (tokens, method) = match slt {
        Some(slt) => {
            let slt = slt.trim().to_owned();
            if slt.is_empty() {
                return Err(CliError::invalid(
                    "The short-lived token is empty.",
                    "Get one with `silicon-accounts login --app write` and pass it with --slt or on stdin.",
                ));
            }
            let tokens = accounts.exchange_slt_public_client(APP_ID, &slt).await.map_err(|e| {
                let mut err = CliError::from(e);
                if err.code == "unauthorized" {
                    err.message = "Silicon Accounts refused the short-lived token: it was already used, expired (they live 2 minutes), or was made for another app.".into();
                    err.hint = Some("Get a fresh one with `silicon-accounts login --app write` and sign in straight away.".into());
                }
                err
            })?;
            (tokens, "slt")
        }
        None => (
            device_flow(ctx, &accounts, options.label.as_deref()).await?,
            "device",
        ),
    };
    let mut session = Session::from_tokens(&tokens, &ctx.accounts_url, &ctx.api_url, method);
    if session.account.uuid.is_empty() {
        // The token response had no account; ask Silicon Write who this is.
        let client = ctx.client.clone().with_token(session.access_token.clone());
        let me = client.me().await?;
        session.account.uuid = me.uuid;
        session.account.id = me.id;
        session.account.kind = me.kind;
        session.account.display_name = me.display_name;
    }
    if let Some(old) = ctx.store.load()?
        && let Some(refresh) = old.refresh_token
    {
        // Replacing a sign-in: end the old one.
        let _ = revoke(&old.accounts_url, &refresh).await;
    }
    ctx.store.save(&session)?;
    let value = session_json(&session, &ctx.api_url);
    ctx.emit(&value, || {
        format!(
            "Signed in to Silicon Write as {} ({}).\nNext: `write ls` lists your docs; `write docs` is the guide.",
            session.account.id, session.account.kind
        )
    });
    Ok(())
}

async fn device_flow(
    ctx: &Ctx,
    accounts: &silicon_accounts_client::AccountsClient,
    label: Option<&str>,
) -> CliResult<TokenResponse> {
    let label = label
        .map(str::to_owned)
        .unwrap_or_else(|| format!("write CLI on {} ({})", hostname(), std::env::consts::OS));
    let auth = accounts
        .app_device_authorize(APP_ID, Some("email"), Some(&label))
        .await?;
    let link = auth
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| auth.verification_uri.clone());
    if ctx.json {
        eprintln!(
            "{}",
            json!({
                "status": "pending",
                "user_code": auth.user_code,
                "verification_uri": auth.verification_uri,
                "verification_uri_complete": auth.verification_uri_complete,
                "expires_in": auth.expires_in,
            })
        );
    } else {
        eprintln!("To sign in to Silicon Write, open {link}");
        eprintln!(
            "and confirm the code {} (it expires in {} minutes).",
            auth.user_code,
            auth.expires_in.div_ceil(60)
        );
        if std::io::stderr().is_terminal() {
            eprintln!("Waiting for approval…");
        }
    }
    let started = std::time::Instant::now();
    let mut interval = Duration::from_secs(auth.interval.max(1));
    loop {
        tokio::time::sleep(interval).await;
        match accounts
            .app_device_poll(APP_ID, auth.device_code.expose())
            .await
        {
            Ok(DevicePoll::Tokens(tokens)) => return Ok(*tokens),
            Ok(DevicePoll::Pending) => {}
            Ok(DevicePoll::SlowDown) => interval += Duration::from_secs(5),
            Ok(DevicePoll::Denied) => {
                return Err(CliError::new(
                    "unauthorized",
                    format!(
                        "The sign-in code {} was denied on the account site.",
                        auth.user_code
                    ),
                    "Run `write login` again if that was a mistake.",
                ));
            }
            Ok(DevicePoll::Expired) => return Err(expired(&auth.user_code)),
            Ok(_) => {}
            Err(e) if e.is_transport() || e.status().is_some_and(|s| s >= 500 || s == 429) => {}
            Err(e) => return Err(e.into()),
        }
        if started.elapsed() + interval > Duration::from_secs(auth.expires_in.max(1)) {
            return Err(expired(&auth.user_code));
        }
    }
}

fn expired(code: &str) -> CliError {
    CliError::new(
        "expired",
        format!("The sign-in code {code} expired before it was approved."),
        "Run `write login` again and approve the new code within 10 minutes.",
    )
}

/// `login status`: `{"authenticated": false}` (exit 0 with --json) when signed out; a network
/// error stays an error.
pub async fn status(ctx: &Ctx) -> CliResult<()> {
    let Some(_) = ctx.store.load()? else {
        return signed_out(ctx, None);
    };
    // Make sure the tokens still work: refresh when due, then ask Silicon Write.
    match ctx.provider.valid_token().await {
        Ok(_) => {}
        Err(e) if e.code == "unauthorized" => return signed_out(ctx, Some(e.message)),
        Err(e) => return Err(e),
    }
    match ctx.client.me().await {
        Ok(me) => {
            let session = ctx
                .provider
                .session()
                .await
                .ok_or_else(crate::session::signed_out_error)?;
            let mut value = session_json(&session, &ctx.api_url);
            value["id"] = json!(me.id);
            value["display_name"] = json!(me.display_name);
            ctx.emit(&value, || {
                format!(
                    "Signed in to Silicon Write as {} ({}, {}).\nAPI: {}\nSilicon Accounts: {}",
                    me.label(),
                    me.kind,
                    if session.method == "slt" {
                        "short-lived token"
                    } else {
                        "device sign-in"
                    },
                    ctx.api_url,
                    session.accounts_url
                )
            });
            Ok(())
        }
        Err(e) if e.is_unauthorized() => signed_out(ctx, Some(e.message().to_owned())),
        Err(e) => Err(e.into()),
    }
}

fn signed_out(ctx: &Ctx, reason: Option<String>) -> CliResult<()> {
    if ctx.json {
        let mut value = json!({ "authenticated": false, "app_id": APP_ID });
        if let Some(reason) = reason {
            value["reason"] = json!(reason);
        }
        ctx.emit(&value, String::new);
        return Ok(());
    }
    let mut err = CliError::new(
        "unauthorized",
        "You are not signed in to Silicon Write.",
        "Carbons: `write login`. Silicons: `silicon-accounts login --app write | write login --token-stdin`.",
    );
    if let Some(reason) = reason {
        err.message = format!("You are not signed in to Silicon Write: {reason}");
    }
    Err(err)
}

pub async fn logout(ctx: &Ctx) -> CliResult<()> {
    let Some(session) = ctx.store.load()? else {
        ctx.emit(
            &json!({ "signed_out": false, "reason": "not signed in" }),
            || "You were not signed in.".into(),
        );
        return Ok(());
    };
    let token = session
        .refresh_token
        .clone()
        .unwrap_or_else(|| session.access_token.clone());
    let revoked = revoke(&session.accounts_url, &token).await;
    ctx.store.delete()?;
    let value = json!({
        "signed_out": true,
        "id": session.account.id,
        "revoked": revoked.is_ok(),
        "warning": revoked.as_ref().err().map(|e| e.message.clone()),
    });
    ctx.emit(&value, || match &revoked {
        Ok(()) => format!(
            "Signed out {} and ended the sign-in at Silicon Accounts.",
            session.account.id
        ),
        Err(e) => format!(
            "Signed out {} on this machine. {}",
            session.account.id, e.message
        ),
    });
    Ok(())
}

pub async fn whoami(ctx: &Ctx) -> CliResult<()> {
    ctx.require_session()?;
    let me = ctx.client.me().await?;
    ctx.emit(&me, || {
        format!(
            "{} · {} · {}\nuuid {}",
            me.label(),
            me.display_name,
            me.kind,
            me.uuid
        )
    });
    Ok(())
}

pub fn accounts(ctx: &Ctx) -> CliResult<()> {
    let value = json!({
        "app_id": APP_ID,
        "name": "Silicon Write",
        "version": env!("CARGO_PKG_VERSION"),
        "accounts_url": ctx.accounts_url,
        "api_url": ctx.api_url,
        "web_url": WEB_URL,
        "docs_url": DOCS_URL,
        "client": "silicon-accounts-client",
        "rust_package": "silicon-write-client",
        "sign_in": { "carbon": "device", "silicon": "slt", "scope": "email" },
        "repository_url": "https://github.com/teamofsilicons/silicon-write",
    });
    ctx.emit(&value, || {
        format!(
            "Silicon Write (app id `write`), version {}\nSilicon Accounts: {}\nAPI: {}\nDocs: {DOCS_URL}",
            env!("CARGO_PKG_VERSION"),
            ctx.accounts_url,
            ctx.api_url
        )
    });
    Ok(())
}
