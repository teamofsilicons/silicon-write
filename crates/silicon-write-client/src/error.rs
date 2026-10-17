//! Typed errors. Every error carries a stable `code`, a `message` saying what went wrong, and a
//! `hint` saying what to do next, exactly like the API's `{"error":{"code","message","hint"}}`.

use serde_json::{Value, json};

/// Result alias used throughout the crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Everything that can go wrong when talking to Silicon Write.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// The service answered with an error status (its `{"error":{…}}` body, or a fitting
    /// default when the body was not JSON).
    #[error("{message}")]
    Api {
        /// HTTP status code.
        status: u16,
        /// Stable code: `unauthorized`, `forbidden`, `not_found`, `conflict`, `invalid`,
        /// `not_unique`, `no_match`, `too_large`, `unsupported_format`, `unavailable`, …
        code: String,
        /// What went wrong.
        message: String,
        /// What to do next.
        hint: Option<String>,
        /// Any other fields of the error body.
        details: Option<Value>,
    },
    /// The request never got a response (connection refused, DNS, TLS, timeout…).
    #[error("{message}")]
    Network {
        /// What failed.
        message: String,
        /// What to do next.
        hint: String,
        /// The transport error.
        #[source]
        source: reqwest::Error,
    },
    /// The service answered, but not with what this client expected.
    #[error("{message}")]
    Decode {
        /// What failed.
        message: String,
        /// What to do next.
        hint: String,
    },
    /// Getting an access token failed (raised by a [`crate::TokenProvider`]).
    #[error("{message}")]
    Auth {
        /// Stable code, usually `unauthorized`.
        code: String,
        /// What failed.
        message: String,
        /// What to do next.
        hint: String,
    },
    /// A value passed to the client was rejected before anything was sent.
    #[error("{message}")]
    InvalidInput {
        /// What is wrong.
        message: String,
        /// How to fix it.
        hint: String,
    },
    /// Reading or writing a local file failed.
    #[error("{message}")]
    Io {
        /// What failed.
        message: String,
        /// What to do next.
        hint: String,
        /// The I/O error.
        #[source]
        source: std::io::Error,
    },
}

impl Error {
    /// An [`Error::InvalidInput`].
    pub fn invalid_input(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::InvalidInput {
            message: message.into(),
            hint: hint.into(),
        }
    }

    /// An [`Error::Auth`] with code `unauthorized`.
    pub fn auth(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::Auth {
            code: "unauthorized".into(),
            message: message.into(),
            hint: hint.into(),
        }
    }

    /// An [`Error::Io`].
    pub fn io(message: impl Into<String>, hint: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            message: message.into(),
            hint: hint.into(),
            source,
        }
    }

    /// The stable machine-readable code.
    pub fn code(&self) -> &str {
        match self {
            Self::Api { code, .. } | Self::Auth { code, .. } => code,
            Self::Network { .. } => "network",
            Self::Decode { .. } => "decode",
            Self::InvalidInput { .. } => "invalid",
            Self::Io { .. } => "io",
        }
    }

    /// What went wrong.
    pub fn message(&self) -> &str {
        match self {
            Self::Api { message, .. }
            | Self::Network { message, .. }
            | Self::Decode { message, .. }
            | Self::Auth { message, .. }
            | Self::InvalidInput { message, .. }
            | Self::Io { message, .. } => message,
        }
    }

    /// What to do next, when known.
    pub fn hint(&self) -> Option<&str> {
        match self {
            Self::Api { hint, .. } => hint.as_deref(),
            Self::Network { hint, .. }
            | Self::Decode { hint, .. }
            | Self::Auth { hint, .. }
            | Self::InvalidInput { hint, .. }
            | Self::Io { hint, .. } => Some(hint),
        }
    }

    /// The HTTP status, for errors the service answered.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Api { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// True when the error has this code.
    pub fn is_code(&self, code: &str) -> bool {
        self.code() == code
    }

    /// True for `not_found`.
    pub fn is_not_found(&self) -> bool {
        self.is_code("not_found")
    }

    /// True when the service refused the credentials (401) or there were none to send.
    pub fn is_unauthorized(&self) -> bool {
        self.is_code("unauthorized")
    }

    /// True when no response was received at all.
    pub fn is_network(&self) -> bool {
        matches!(self, Self::Network { .. })
    }

    /// The error as the API writes it: `{"error":{"code","message","hint"}}`.
    pub fn to_json(&self) -> Value {
        let mut error = json!({ "code": self.code(), "message": self.message() });
        if let Some(hint) = self.hint() {
            error["hint"] = json!(hint);
        }
        if let Some(status) = self.status() {
            error["status"] = json!(status);
        }
        if let Self::Api {
            details: Some(details),
            ..
        } = self
        {
            error["details"] = details.clone();
        }
        json!({ "error": error })
    }

    /// Builds the error for a non-success response from its status and body.
    pub(crate) fn from_response(status: u16, body: &[u8]) -> Self {
        let parsed: Option<Value> = serde_json::from_slice(body).ok();
        let error = parsed.as_ref().and_then(|v| v.get("error"));
        let text = |key: &str| {
            error
                .and_then(|e| e.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let code = text("code").unwrap_or_else(|| default_code(status).to_owned());
        let message = text("message").unwrap_or_else(|| {
            let snippet: String = String::from_utf8_lossy(body)
                .trim()
                .chars()
                .take(200)
                .collect();
            if snippet.is_empty() {
                format!("Silicon Write answered HTTP {status} with no explanation.")
            } else {
                format!("Silicon Write answered HTTP {status}: {snippet}")
            }
        });
        let hint = text("hint").or_else(|| default_hint(&code).map(str::to_owned));
        let details = error.and_then(Value::as_object).and_then(|e| {
            let rest: serde_json::Map<String, Value> = e
                .iter()
                .filter(|(k, _)| !matches!(k.as_str(), "code" | "message" | "hint"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            (!rest.is_empty()).then_some(Value::Object(rest))
        });
        Self::Api {
            status,
            code,
            message,
            hint,
            details,
        }
    }
}

fn default_code(status: u16) -> &'static str {
    match status {
        400 | 422 => "invalid",
        401 => "unauthorized",
        403 => "forbidden",
        404 => "not_found",
        409 => "conflict",
        413 => "too_large",
        415 => "unsupported_format",
        429 => "rate_limited",
        503 => "unavailable",
        _ if status >= 500 => "server_error",
        _ => "http_error",
    }
}

fn default_hint(code: &str) -> Option<&'static str> {
    Some(match code {
        "unauthorized" => "Sign in again (`write login`), then retry.",
        "forbidden" => "Ask the owner or an editor for a role that allows this.",
        "not_found" => "Check the id; it may have been deleted, or it is not shared with you.",
        "unavailable" | "server_error" => {
            "Silicon Write is having trouble; wait a moment and retry."
        }
        "rate_limited" => "Wait a moment and retry.",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_api_error_body() {
        let body = br#"{"error":{"code":"no_match","message":"The text isn't there.","hint":"Read the doc first.","matches":0}}"#;
        let err = Error::from_response(422, body);
        assert_eq!(err.code(), "no_match");
        assert_eq!(err.message(), "The text isn't there.");
        assert_eq!(err.hint(), Some("Read the doc first."));
        assert_eq!(err.status(), Some(422));
        assert_eq!(err.to_json()["error"]["details"]["matches"], 0);
    }

    #[test]
    fn falls_back_for_bodies_that_are_not_json() {
        let err = Error::from_response(502, b"<html>bad gateway</html>");
        assert_eq!(err.code(), "server_error");
        assert!(err.message().contains("502"));
        assert!(err.hint().is_some());
        let err = Error::from_response(404, b"");
        assert!(err.is_not_found());
    }
}
