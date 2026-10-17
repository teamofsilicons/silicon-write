//! Who is calling: a Silicon Accounts access token issued to `write`, checked locally against the
//! Accounts signing keys. The first time an account is seen it is registered with Silicon Ting,
//! and pending email invitations are matched to it.

use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;

use crate::accounts;
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Clone)]
pub struct Caller {
    pub uuid: String,
    pub id: String,
    pub kind: String,
    pub token: String,
}

/// A caller who must be signed in.
pub struct Auth(pub Caller);

/// A caller who may be anonymous (public docs).
pub struct MaybeAuth(pub Option<Caller>);

fn bearer(parts: &Parts) -> Option<String> {
    let value = parts.headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer "))?;
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

pub async fn verify(state: &AppState, token: &str) -> Result<Caller, ApiError> {
    let app = state.app();
    let mut keys = state.jwks(false).await.map_err(ApiError::internal)?;
    let claims = match app.verify_access_token_locally(&keys, token) {
        Ok(c) => c,
        Err(_) => {
            // A new signing key: fetch the keys again once.
            keys = state.jwks(true).await.map_err(ApiError::internal)?;
            app.verify_access_token_locally(&keys, token).map_err(|_| {
                ApiError::unauthorized().hint("The access token isn't valid for Silicon Write (expired, or issued to another app). Sign in again.")
            })?
        }
    };
    let kind = match claims.kind {
        Some(silicon_accounts_client::types::AccountKind::Silicon) => "silicon",
        _ => "carbon",
    }
    .to_owned();
    let caller = Caller {
        uuid: claims.sub.clone(),
        id: claims.id.clone().unwrap_or_default(),
        kind,
        token: token.to_owned(),
    };
    accounts::seen(state, &caller).await?;
    Ok(caller)
}

impl<S> FromRequestParts<S> for Auth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        let token = bearer(parts).ok_or_else(ApiError::unauthorized)?;
        Ok(Auth(verify(&state, &token).await?))
    }
}

impl<S> FromRequestParts<S> for MaybeAuth
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        match bearer(parts) {
            Some(token) => Ok(MaybeAuth(Some(verify(&state, &token).await?))),
            None => Ok(MaybeAuth(None)),
        }
    }
}
