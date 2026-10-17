//! CLI errors: a stable code, what went wrong, what to do next, and an exit code.

use serde_json::{Value, json};

/// Exit codes (documented in `write --help`).
pub mod exit {
    pub const FAILURE: i32 = 1;
    pub const INVALID: i32 = 2;
    pub const UNAUTHORIZED: i32 = 3;
    pub const NOT_FOUND: i32 = 4;
    pub const CONFLICT: i32 = 5;
}

#[derive(Debug, Clone)]
pub struct CliError {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    pub status: Option<u16>,
    pub details: Option<Value>,
}

impl CliError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        let hint = hint.into();
        Self {
            code: code.into(),
            message: message.into(),
            hint: (!hint.is_empty()).then_some(hint),
            status: None,
            details: None,
        }
    }

    pub fn invalid(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new("invalid", message, hint)
    }

    pub fn not_found(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::new("not_found", message, hint)
    }

    pub fn io(message: impl Into<String>, _source: std::io::Error) -> Self {
        Self::new(
            "io",
            message,
            "Check the path, its permissions and free space, then retry.",
        )
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn exit_code(&self) -> i32 {
        match self.code.as_str() {
            "invalid" | "usage" | "ambiguous" | "no_match" | "not_unique"
            | "unsupported_format" | "too_large" => exit::INVALID,
            "unauthorized" | "forbidden" => exit::UNAUTHORIZED,
            "not_found" => exit::NOT_FOUND,
            "conflict" | "push_failed" | "pull_conflict" => exit::CONFLICT,
            _ => exit::FAILURE,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(hint) = &self.hint {
            error["hint"] = json!(hint);
        }
        if let Some(status) = self.status {
            error["status"] = json!(status);
        }
        if let Some(details) = &self.details {
            error["details"] = details.clone();
        }
        json!({ "error": error })
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<silicon_write_client::Error> for CliError {
    fn from(e: silicon_write_client::Error) -> Self {
        let details = match &e {
            silicon_write_client::Error::Api { details, .. } => details.clone(),
            _ => None,
        };
        Self {
            code: e.code().to_owned(),
            message: e.message().to_owned(),
            hint: e.hint().map(str::to_owned),
            status: e.status(),
            details,
        }
    }
}

impl From<silicon_accounts_client::Error> for CliError {
    fn from(e: silicon_accounts_client::Error) -> Self {
        let code = if e.is_transport() {
            "network".to_owned()
        } else if let Some(oauth) = e.as_oauth() {
            if oauth.error == "invalid_grant" {
                "unauthorized".to_owned()
            } else {
                oauth.error.clone()
            }
        } else {
            e.code().to_owned()
        };
        let mut message = e.message();
        if e.is_transport() {
            message = format!("Could not reach Silicon Accounts: {message}");
        }
        Self {
            code,
            message,
            hint: e.hint(),
            status: e.status(),
            details: None,
        }
    }
}

pub type CliResult<T> = Result<T, CliError>;
