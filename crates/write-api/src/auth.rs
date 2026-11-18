//! Who is calling: a Silicon Accounts access token issued to `write`, checked locally against the
//! Accounts signing keys. The first time an account is seen it is registered with Silicon Ting,
//! and pending email invitations are matched to it.

use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;

use crate::accounts;
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Debug, Clone, Default)]
pub struct Caller {
    pub uuid: String,
    pub id: String,
    pub kind: String,
    pub token: String,
    pub organizations: std::sync::Arc<tokio::sync::OnceCell<crate::organizations::Context>>,
}

/// A caller who must be signed in.
pub struct Auth(pub Caller);

/// A caller who may be anonymous (public docs).
pub struct MaybeAuth(pub Option<Caller>);

fn bearer(parts: &Parts) -> Result<Option<String>, ApiError> {
    let Some(value) = parts.headers.get(axum::http::header::AUTHORIZATION) else { return Ok(None) };
    let (scheme, token) = value.to_str().ok().and_then(|v| v.split_once(' ')).ok_or_else(ApiError::unauthorized)?;
    if !scheme.eq_ignore_ascii_case("Bearer") || token.trim().is_empty() {
        return Err(ApiError::unauthorized());
    }
    Ok(Some(token.trim().to_owned()))
}

pub async fn active(state: &AppState, token: &str, uuid: &str) -> Result<(), ApiError> {
    let info = state.app().introspect(token).await
        .map_err(|_| ApiError::unavailable("Silicon Accounts could not verify this session. Try again shortly."))?;
    if !info.active || info.token_type.as_deref() != Some("access_token")
        || info.client_id.as_deref() != Some(&state.config.app_id) || info.sub.as_deref() != Some(uuid)
        || info.exp.is_none_or(|exp| exp <= time::OffsetDateTime::now_utc().unix_timestamp()) {
        return Err(ApiError::unauthorized());
    }
    Ok(())
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
    active(state, token, &claims.sub).await?;
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
        ..Default::default()
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
        let token = bearer(parts)?.ok_or_else(ApiError::unauthorized)?;
        let caller = verify(&state, &token).await?;
        crate::visitors::guard(&state, Some(&caller), parts.uri.path(), &parts.headers, &parts.method).await?;
        Ok(Auth(caller))
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
        let caller = match bearer(parts)? {
            Some(token) => Some(verify(&state, &token).await?),
            None => None,
        };
        crate::visitors::guard(&state, caller.as_ref(), parts.uri.path(), &parts.headers, &parts.method).await?;
        Ok(MaybeAuth(caller))
    }
}
