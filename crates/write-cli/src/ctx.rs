//! What every command needs: URLs, the session, the API client and output.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use silicon_write_client::Client;

use crate::error::{CliError, CliResult};
use crate::session::{SessionProvider, Store};

pub const DEFAULT_API_URL: &str = "https://api.write.teamofsilicons.com";
pub const DEFAULT_ACCOUNTS_URL: &str = "https://accounts.teamofsilicons.com";
pub const WEB_URL: &str = "https://write.teamofsilicons.com";
pub const DOCS_URL: &str = "https://write.teamofsilicons.com/docs";

pub struct Ctx {
    pub json: bool,
    pub api_url: String,
    pub accounts_url: String,
    pub store: Store,
    pub provider: Arc<SessionProvider>,
    pub client: Client,
    pub signed_in: bool,
}

pub struct Options {
    pub json: bool,
    pub api_url: Option<String>,
    pub accounts_url: Option<String>,
    pub home: Option<PathBuf>,
}

pub fn home_dir(explicit: Option<PathBuf>) -> CliResult<PathBuf> {
    if let Some(home) = explicit.filter(|h| !h.as_os_str().is_empty()) {
        return Ok(home);
    }
    std::env::home_dir().ok_or_else(|| {
        CliError::invalid(
            "Could not find your home directory.",
            "Pass --home DIR or set SILICON_HOME.",
        )
    })
}

impl Ctx {
    pub fn new(options: Options) -> CliResult<Self> {
        let home = home_dir(options.home)?;
        let store = Store::new(&home);
        let session = store.load()?;
        // A flag or environment variable wins; then the URLs the session was made with.
        let api_url = options
            .api_url
            .filter(|u| !u.trim().is_empty())
            .or_else(|| {
                session
                    .as_ref()
                    .map(|s| s.api_url.clone())
                    .filter(|u| !u.is_empty())
            })
            .unwrap_or_else(|| DEFAULT_API_URL.to_owned());
        let accounts_url = options
            .accounts_url
            .filter(|u| !u.trim().is_empty())
            .or_else(|| {
                session
                    .as_ref()
                    .map(|s| s.accounts_url.clone())
                    .filter(|u| !u.is_empty())
            })
            .unwrap_or_else(|| DEFAULT_ACCOUNTS_URL.to_owned());
        let api_url = api_url.trim().trim_end_matches('/').to_owned();
        let accounts_url = accounts_url.trim().trim_end_matches('/').to_owned();
        let signed_in = session.is_some();
        let provider = Arc::new(SessionProvider::new(store.clone(), session));
        let client = Client::builder()
            .base_url(&api_url)
            .user_agent(format!("write/{}", env!("CARGO_PKG_VERSION")))
            .build()?
            .with_token_provider(provider.clone());
        Ok(Self {
            json: options.json,
            api_url,
            accounts_url,
            store,
            provider,
            client,
            signed_in,
        })
    }

    /// Prints the result: JSON on stdout with `--json`, otherwise the readable text.
    pub fn emit<T: Serialize + ?Sized>(&self, value: &T, readable: impl FnOnce() -> String) {
        let mut out = std::io::stdout().lock();
        if self.json {
            let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into());
            let _ = writeln!(out, "{text}");
        } else {
            let text = readable();
            if !text.is_empty() {
                let _ = if text.ends_with('\n') {
                    write!(out, "{text}")
                } else {
                    writeln!(out, "{text}")
                };
            }
        }
    }

    pub fn require_session(&self) -> CliResult<()> {
        if self.signed_in {
            Ok(())
        } else {
            Err(crate::session::signed_out_error())
        }
    }
}
