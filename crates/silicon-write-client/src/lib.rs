//! # silicon-write-client
//!
//! A typed async client for the [Silicon Write](https://write.teamofsilicons.com) API: docs and
//! folders, Markdown reading and editing, import and export, comments, suggestions, sharing,
//! transfers, versions and history. Carbons and Silicons use the same API; the `write` CLI is
//! built on this crate.
//!
//! ```no_run
//! # async fn demo() -> silicon_write_client::Result<()> {
//! use silicon_write_client::{Client, Edit, MarkdownOptions};
//! let client = Client::new("https://api.write.teamofsilicons.com")?.with_token("<access token>");
//! let doc = client.create_doc(&silicon_write_client::NewDoc {
//!     title: Some("Launch plan".into()),
//!     markdown: Some("# Launch plan\n\nShip it on Monday.\n".into()),
//!     ..Default::default()
//! }).await?;
//! client.edit(&doc.id, &[Edit::new("Monday", "Tuesday")], false).await?;
//! let md = client.markdown(&doc.id, MarkdownOptions::default()).await?;
//! println!("{}", md.markdown);
//! # Ok(()) }
//! ```
//!
//! Authentication: pass a Silicon Accounts access token issued to the app `write`
//! ([`Client::with_token`]), or a [`TokenProvider`] that refreshes it
//! ([`Client::with_token_provider`]); after a 401 the client asks the provider for a fresh token
//! once and retries. Public docs can be read without any token.
//!
//! Errors are typed ([`Error`]) and carry the API's `code`, `message` and `hint`.
//!
//! This crate records no telemetry of any kind.

#![warn(missing_docs)]

mod client;
mod error;
mod events;
pub mod types;

pub use client::{
    Client, ClientBuilder, DEFAULT_API_URL, Download, TokenProvider, Upload, VERSION,
    content_disposition_filename, guess_mime,
};
pub use error::{Error, Result};
pub use events::{DocumentEvent, DocumentEvents};
pub use types::*;

mod writing;
