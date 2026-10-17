//! Errors as the API reports them: `{"error": {"code", "message", "hint"}}`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub hint: Option<String>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError { status, code, message: message.into(), hint: None }
    }
    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "Sign in to Silicon Write first.")
            .hint("Send a Silicon Accounts access token issued to the app `write` as `Authorization: Bearer …`.")
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }
    pub fn not_found(what: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", format!("{what} doesn't exist, or you don't have access to it."))
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid", message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "conflict", message)
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
    }
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "internal error");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Something went wrong on our side.")
            .hint("Try again in a moment.")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": { "code": self.code, "message": self.message } });
        if let Some(hint) = self.hint {
            body["error"]["hint"] = json!(hint);
        }
        (self.status, axum::Json(body)).into_response()
    }
}

/// A request the router or an extractor refused before any handler ran (a body that isn't the JSON
/// asked for, a missing content type, a bad path): axum answers those in plain text. They get the
/// API's error shape too, `{"error": {"code", "message"}}`, like every other error.
pub async fn plain_rejections(response: Response) -> Response {
    let status = response.status();
    let plain = response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/plain"));
    if !status.is_client_error() || !plain {
        return response;
    }
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024).await.unwrap_or_default();
    let message = String::from_utf8_lossy(&bytes).trim().to_owned();
    let code = match status {
        StatusCode::PAYLOAD_TOO_LARGE => "too_large",
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "unsupported_media_type",
        StatusCode::METHOD_NOT_ALLOWED => "method_not_allowed",
        StatusCode::NOT_FOUND => "not_found",
        _ => "invalid",
    };
    let mut error = ApiError::new(status, code, if message.is_empty() { "The request couldn't be read.".to_owned() } else { message });
    if code == "invalid" {
        error = error.hint("Check the request body against docs/api.md.");
    }
    error.into_response()
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        ApiError::internal(error)
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        ApiError::internal(error)
    }
}

impl From<write_doc::history::HistoryError> for ApiError {
    fn from(error: write_doc::history::HistoryError) -> Self {
        ApiError::internal(error)
    }
}
