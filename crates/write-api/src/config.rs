//! Configuration, read once at start from the environment.

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub database_url: String,
    /// Where the web editor lives (links in notifications and emails).
    pub web_url: String,
    /// This service's own public URL (for asset links and the live connection).
    pub api_url: String,
    pub accounts_url: String,
    pub app_id: String,
    pub app_secret: String,
    /// Signs live-connection tickets.
    pub ticket_secret: Vec<u8>,
    pub data_dir: PathBuf,
    /// Silicon Ting; notifications are kept in the outbox until it is set.
    pub ting_url: Option<String>,
    pub ting_app_id: String,
    pub postmark_token: Option<String>,
    pub mail_from: String,
    pub pandoc: String,
    pub soffice: String,
    pub pdftotext: String,
    pub ffmpeg: String,
    pub deepgram_api_key: Option<String>,
    pub deepgram_url: String,
    pub dev: bool,
    pub accounts_webhook_secret: Option<String>,
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn required(name: &str, problems: &mut Vec<String>) -> String {
    var(name).unwrap_or_else(|| {
        problems.push(format!("{name} is not set."));
        String::new()
    })
}

impl Config {
    pub fn from_env() -> Result<Config, Vec<String>> {
        let mut problems = vec![];
        let database_url = required("WRITE_DATABASE_URL", &mut problems);
        let app_secret = required("WRITE_APP_SECRET", &mut problems);
        let ticket_secret = required("WRITE_TICKET_SECRET", &mut problems);
        if !ticket_secret.is_empty() && ticket_secret.len() < 32 {
            problems.push("WRITE_TICKET_SECRET must be at least 32 characters.".into());
        }
        let bind = var("WRITE_BIND").unwrap_or_else(|| "127.0.0.1:4371".into());
        let config = Config {
            api_url: var("WRITE_API_URL").unwrap_or_else(|| format!("http://{bind}")),
            bind,
            database_url,
            web_url: var("WRITE_WEB_URL").unwrap_or_else(|| "http://localhost:4370".into()),
            accounts_url: var("ACCOUNTS_URL").unwrap_or_else(|| "https://accounts.teamofsilicons.com".into()),
            app_id: var("WRITE_APP_ID").unwrap_or_else(|| "write".into()),
            app_secret,
            ticket_secret: ticket_secret.into_bytes(),
            data_dir: PathBuf::from(var("WRITE_DATA_DIR").unwrap_or_else(|| ".dev/data".into())),
            ting_url: var("WRITE_TING_URL"),
            ting_app_id: var("WRITE_TING_APP_ID").unwrap_or_else(|| "ting".into()),
            postmark_token: var("WRITE_POSTMARK_TOKEN"),
            mail_from: var("WRITE_MAIL_FROM").unwrap_or_else(|| "Silicon Write <write@teamofsilicons.com>".into()),
            pandoc: var("WRITE_PANDOC").unwrap_or_else(|| "pandoc".into()),
            soffice: var("WRITE_SOFFICE").unwrap_or_else(default_soffice),
            pdftotext: var("WRITE_PDFTOTEXT").unwrap_or_else(|| "pdftotext".into()),
            ffmpeg: var("WRITE_FFMPEG").unwrap_or_else(|| "ffmpeg".into()),
            deepgram_api_key: var("WRITE_DEEPGRAM_API_KEY"),
            // A local fake is only available in the explicitly selected development environment.
            deepgram_url: if var("WRITE_ENVIRONMENT").as_deref() == Some("development") {
                var("WRITE_DEEPGRAM_URL").unwrap_or_else(|| "https://api.deepgram.com/v1/listen".into())
            } else { "https://api.deepgram.com/v1/listen".into() },
            // Development extras (the outbox page, plain-HTTP Silicon Accounts) only when asked for by name.
            dev: var("WRITE_ENVIRONMENT").as_deref() == Some("development"),
            accounts_webhook_secret: var("WRITE_ACCOUNTS_WEBHOOK_SECRET"),
        };
        if problems.is_empty() { Ok(config) } else { Err(problems) }
    }

    pub fn doc_url(&self, id: &str) -> String {
        format!("{}/d/{}", self.web_url.trim_end_matches('/'), id)
    }
}

fn default_soffice() -> String {
    let mac = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
    if std::path::Path::new(mac).exists() { mac.into() } else { "soffice".into() }
}
