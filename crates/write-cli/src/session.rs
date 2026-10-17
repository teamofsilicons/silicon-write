//! The signed-in session: stored in `<home>/.write/session.json` (mode 0600), refreshed
//! automatically before it expires or after a 401. Refreshing is single-flight across every
//! `write` process sharing the home: a lock file serialises it, and the rotated refresh token is
//! written atomically before it is used, so parallel commands never present a used refresh token
//! (which would end the whole sign-in).

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use silicon_accounts_client::{AccountsClient, TokenResponse};
use silicon_write_client::TokenProvider;
use tokio::sync::Mutex;

use crate::error::CliError;

/// The Silicon Accounts app id of Silicon Write.
pub const APP_ID: &str = "write";
/// Refresh this long before the access token expires.
const REFRESH_MARGIN_SECS: i64 = 60;

/// The account a session belongs to.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SessionAccount {
    pub uuid: String,
    pub id: String,
    pub kind: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// What is stored on disk.
#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds.
    pub expires_at: i64,
    /// Unix seconds when the refresh token family ends, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_expires_at: Option<i64>,
    pub account: SessionAccount,
    /// The Silicon Accounts URL the tokens came from (refreshes go there).
    pub accounts_url: String,
    /// The Silicon Write API URL used when signing in.
    #[serde(default)]
    pub api_url: String,
    /// `device` (Carbon) or `slt` (Silicon).
    pub method: String,
    /// Unix seconds.
    pub signed_in_at: i64,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("account", &self.account)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

pub fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

pub fn rfc3339(unix: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(unix)
        .ok()
        .and_then(|t| {
            t.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_default()
}

impl Session {
    /// A session from a token response.
    pub fn from_tokens(
        tokens: &TokenResponse,
        accounts_url: &str,
        api_url: &str,
        method: &str,
    ) -> Self {
        let account = tokens
            .account
            .as_ref()
            .map(|a| SessionAccount {
                uuid: a.uuid.clone(),
                id: a.id.clone(),
                kind: a.kind.as_str().to_owned(),
                display_name: a.display_name.clone(),
                email: a.email.clone(),
            })
            .unwrap_or_default();
        Self {
            access_token: tokens.access_token.expose().to_owned(),
            refresh_token: tokens.refresh_token.as_ref().map(|t| t.expose().to_owned()),
            expires_at: now() + tokens.expires_in as i64,
            refresh_expires_at: tokens.refresh_token_expires_at.map(|t| t.unix_timestamp()),
            account,
            accounts_url: accounts_url.to_owned(),
            api_url: api_url.to_owned(),
            method: method.to_owned(),
            signed_in_at: now(),
        }
    }

    /// Takes the new tokens of a refresh, keeping what they don't say.
    fn apply_refresh(&mut self, tokens: &TokenResponse) {
        self.access_token = tokens.access_token.expose().to_owned();
        if let Some(refresh) = &tokens.refresh_token {
            self.refresh_token = Some(refresh.expose().to_owned());
        }
        self.expires_at = now() + tokens.expires_in as i64;
        if let Some(at) = tokens.refresh_token_expires_at {
            self.refresh_expires_at = Some(at.unix_timestamp());
        }
        if let Some(a) = &tokens.account {
            self.account.id = a.id.clone();
            self.account.display_name = a.display_name.clone();
            if a.email.is_some() {
                self.account.email = a.email.clone();
            }
        }
    }

    fn needs_refresh(&self) -> bool {
        self.expires_at - now() < REFRESH_MARGIN_SECS
    }
}

/// Where the session lives.
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(home: &Path) -> Self {
        Self {
            dir: home.join(".write"),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join("session.json")
    }

    fn ensure_dir(&self) -> Result<(), CliError> {
        fs::create_dir_all(&self.dir).map_err(|e| {
            CliError::io(format!("Could not create {}: {e}.", self.dir.display()), e)
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700));
        }
        Ok(())
    }

    pub fn load(&self) -> Result<Option<Session>, CliError> {
        let path = self.path();
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| {
                CliError::new(
                    "session_unreadable",
                    format!(
                        "The saved sign-in at {} could not be read ({e}).",
                        path.display()
                    ),
                    "Sign in again with `write login`; that replaces the file.",
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(CliError::io(
                format!("Could not read {}: {e}.", path.display()),
                e,
            )),
        }
    }

    /// Writes the session atomically with mode 0600.
    pub fn save(&self, session: &Session) -> Result<(), CliError> {
        self.ensure_dir()?;
        let path = self.path();
        let tmp = self
            .dir
            .join(format!(".session.json.{}.tmp", std::process::id()));
        let json = serde_json::to_vec_pretty(session).expect("sessions serialize");
        let write = || -> std::io::Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&json)?;
            file.sync_all()?;
            fs::rename(&tmp, &path)
        };
        write().map_err(|e| {
            let _ = fs::remove_file(&tmp);
            CliError::io(
                format!("Could not save the sign-in to {}: {e}.", path.display()),
                e,
            )
        })
    }

    pub fn delete(&self) -> Result<bool, CliError> {
        match fs::remove_file(self.path()) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(CliError::io(
                format!("Could not delete {}: {e}.", self.path().display()),
                e,
            )),
        }
    }

    /// Takes the cross-process refresh lock (released when the file is dropped).
    async fn lock(&self) -> Result<File, CliError> {
        self.ensure_dir()?;
        let path = self.dir.join("session.lock");
        tokio::task::spawn_blocking(move || -> std::io::Result<File> {
            let file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)?;
            file.lock()?;
            Ok(file)
        })
        .await
        .map_err(|e| {
            CliError::new(
                "io",
                format!("Could not wait for the sign-in lock: {e}."),
                "Retry the command.",
            )
        })?
        .map_err(|e| CliError::io(format!("Could not lock the sign-in: {e}."), e))
    }
}

/// Builds a Silicon Accounts client for `url`.
pub fn accounts_client(url: &str) -> Result<AccountsClient, CliError> {
    AccountsClient::builder()
        .base_url(url)
        .user_agent(format!("write/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(CliError::from)
}

/// Why the session can't give a token.
pub fn signed_out_error() -> CliError {
    CliError::new(
        "unauthorized",
        "You are not signed in to Silicon Write.",
        "Carbons: run `write login`. Silicons: `silicon-accounts login --app write | write login --token-stdin`.",
    )
}

/// A [`TokenProvider`] backed by the session file.
pub struct SessionProvider {
    store: Store,
    current: Mutex<Option<Session>>,
}

impl SessionProvider {
    pub fn new(store: Store, session: Option<Session>) -> Self {
        Self {
            store,
            current: Mutex::new(session),
        }
    }

    /// The session as it is now (after any refresh).
    pub async fn session(&self) -> Option<Session> {
        self.current.lock().await.clone()
    }

    /// A valid access token, refreshing first when it is about to expire.
    pub async fn valid_token(&self) -> Result<Option<String>, CliError> {
        let mut current = self.current.lock().await;
        let Some(session) = current.as_ref() else {
            return Ok(None);
        };
        if !session.needs_refresh() {
            return Ok(Some(session.access_token.clone()));
        }
        let rejected = session.access_token.clone();
        let fresh = self.refresh_locked(&mut current, &rejected).await?;
        Ok(Some(fresh.access_token))
    }

    /// Refreshes because `rejected` was refused (or expired). Single-flight: in this process
    /// through the mutex, across processes through the lock file; whoever comes second adopts
    /// the tokens the first one saved.
    async fn refresh_locked(
        &self,
        current: &mut Option<Session>,
        rejected: &str,
    ) -> Result<Session, CliError> {
        let _lock = self.store.lock().await?;
        let on_disk = self.store.load()?.ok_or_else(signed_out_error)?;
        if on_disk.access_token != rejected && !on_disk.needs_refresh() {
            *current = Some(on_disk.clone());
            return Ok(on_disk);
        }
        let Some(refresh_token) = on_disk.refresh_token.clone() else {
            return Err(CliError::new(
                "unauthorized",
                "Your Silicon Write sign-in expired and has no refresh token.",
                "Sign in again: `write login` (Carbons) or `write login --token-stdin` with a fresh short-lived token (Silicons).",
            ));
        };
        let accounts = accounts_client(&on_disk.accounts_url)?;
        match accounts
            .refresh_app_public_client(APP_ID, &refresh_token)
            .await
        {
            Ok(tokens) => {
                let mut session = on_disk;
                session.apply_refresh(&tokens);
                self.store.save(&session)?;
                *current = Some(session.clone());
                Ok(session)
            }
            Err(e) if e.as_oauth().is_some_and(|o| o.error == "invalid_grant") => {
                // The sign-in ended (revoked, expired, or signed out elsewhere).
                let _ = self.store.delete();
                *current = None;
                Err(CliError::new(
                    "unauthorized",
                    format!(
                        "Your Silicon Write sign-in as {} ended: Silicon Accounts refused to refresh it.",
                        on_disk.account.id
                    ),
                    "Sign in again: `write login` (Carbons) or `write login --token-stdin` with a fresh short-lived token (Silicons).",
                ))
            }
            Err(e) => Err(CliError::from(e)),
        }
    }
}

fn to_client_error(e: CliError) -> silicon_write_client::Error {
    silicon_write_client::Error::Auth {
        code: e.code,
        message: e.message,
        hint: e.hint.unwrap_or_default(),
    }
}

impl TokenProvider for SessionProvider {
    fn token(&self) -> BoxFuture<'_, silicon_write_client::Result<Option<String>>> {
        Box::pin(async move { self.valid_token().await.map_err(to_client_error) })
    }

    fn refresh<'a>(
        &'a self,
        rejected: &'a str,
    ) -> BoxFuture<'a, silicon_write_client::Result<Option<String>>> {
        Box::pin(async move {
            let mut current = self.current.lock().await;
            match current.as_ref() {
                None => Ok(None),
                Some(s) if s.access_token != rejected => Ok(Some(s.access_token.clone())),
                Some(_) => self
                    .refresh_locked(&mut current, rejected)
                    .await
                    .map(|s| Some(s.access_token))
                    .map_err(to_client_error),
            }
        })
    }
}

/// Ends a sign-in at Silicon Accounts (RFC 7009 revoke with the app's `client_id`).
///
/// `silicon-accounts-client` 0.6's `revoke_public_client` only accepts Silicon Accounts' own
/// client ids, so the revoke request for the `write` public client is sent directly.
pub async fn revoke(accounts_url: &str, token: &str) -> Result<(), CliError> {
    let url = format!("{}/v1/oauth/revoke", accounts_url.trim_end_matches('/'));
    let hint = if token.starts_with("sar_") {
        "refresh_token"
    } else {
        "access_token"
    };
    let response = reqwest::Client::new()
        .post(&url)
        .header("user-agent", format!("write/{}", env!("CARGO_PKG_VERSION")))
        .form(&[("token", token), ("token_type_hint", hint), ("client_id", APP_ID)])
        .send()
        .await
        .map_err(|e| {
            CliError::new(
                "network",
                format!("Could not reach Silicon Accounts at {accounts_url} to end the sign-in: {e}."),
                "Check your connection and the Silicon Accounts URL (--accounts-url / ACCOUNTS_URL).",
            )
        })?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status().as_u16();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    let detail = body
        .pointer("/error_description")
        .or_else(|| body.pointer("/error/message"))
        .or_else(|| body.pointer("/error"))
        .and_then(|v| v.as_str())
        .unwrap_or("no explanation")
        .to_owned();
    Err(CliError::new(
        "revoke_failed",
        format!("Silicon Accounts refused to end the sign-in (HTTP {status}): {detail}."),
        "The local sign-in was removed anyway; you can also end it on the account site under Apps.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Session {
        Session {
            access_token: "at".into(),
            refresh_token: Some("sar_x".into()),
            expires_at: now() + 1800,
            refresh_expires_at: None,
            account: SessionAccount {
                uuid: "u".into(),
                id: "si:writer".into(),
                kind: "silicon".into(),
                ..Default::default()
            },
            accounts_url: "http://localhost:9890".into(),
            api_url: "http://127.0.0.1:4371".into(),
            method: "slt".into(),
            signed_in_at: now(),
        }
    }

    #[test]
    fn saves_atomically_with_private_mode() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        assert!(store.load().unwrap().is_none());
        store.save(&sample()).unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.account.id, "si:writer");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert!(format!("{loaded:?}").contains("si:writer"));
        assert!(
            !format!("{loaded:?}").contains("sar_x"),
            "Debug must never print tokens"
        );
        assert!(store.delete().unwrap());
        assert!(!store.delete().unwrap());
    }

    #[tokio::test]
    async fn adopts_tokens_another_process_already_refreshed() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        let mut stale = sample();
        stale.expires_at = now() - 10;
        // Another process refreshed and saved new tokens.
        let mut fresh = sample();
        fresh.access_token = "at2".into();
        store.save(&fresh).unwrap();
        let provider = SessionProvider::new(store, Some(stale));
        // No network call: the fresh token on disk is adopted.
        assert_eq!(
            provider.valid_token().await.unwrap().as_deref(),
            Some("at2")
        );
        let token = TokenProvider::refresh(&provider, "at").await.unwrap();
        assert_eq!(token.as_deref(), Some("at2"));
    }
}
