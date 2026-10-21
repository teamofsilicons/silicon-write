//! Shared state for every request.

use std::sync::Arc;
use std::time::{Duration, Instant};

use silicon_accounts_client::{AccountsClient, AppClient};
use sqlx::PgPool;
use tokio::sync::RwLock;

use crate::config::Config;
use crate::rooms::Rooms;

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

pub struct Inner {
    pub config: Config,
    pub db: PgPool,
    pub accounts: AccountsClient,
    pub jwks: RwLock<Option<(silicon_accounts_client::types::Jwks, Instant)>>,
    pub rooms: Rooms,
    pub http: reqwest::Client,
    pub voice_slots: tokio::sync::Semaphore,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl Inner {
    /// Silicon Write acting as itself at Silicon Accounts.
    pub fn app(&self) -> AppClient<'_> {
        self.accounts.as_app(self.config.app_id.clone(), self.config.app_secret.clone())
    }

    /// The signing keys, fetched again when older than an hour or when `refresh` is set.
    pub async fn jwks(&self, refresh: bool) -> anyhow::Result<silicon_accounts_client::types::Jwks> {
        if !refresh
            && let Some((keys, at)) = self.jwks.read().await.as_ref()
                && at.elapsed() < Duration::from_secs(3600) {
                    return Ok(keys.clone());
                }
        let keys = self.accounts.jwks().await?;
        *self.jwks.write().await = Some((keys.clone(), Instant::now()));
        Ok(keys)
    }
}
