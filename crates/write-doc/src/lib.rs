//! Silicon Write's document engine.
//!
//! - [`model`]: the doc model, node for node the web editor's schema.
//! - [`markdown`]: Markdown in and out, exact both ways.
//! - [`pandoc`]: every other format, through Pandoc's document tree.
//! - [`ydoc`]: the live Yjs form, as the editor's Yjs binding stores it, and turning a new
//!   version of a doc into the smallest set of edits.
//! - [`history`]: replaying stored updates, versions and per-author undo.

pub mod history;
pub mod markdown;
pub mod model;
pub mod pandoc;
pub mod ydoc;

pub use markdown::{SuggestionView, WriteOptions, from_markdown, to_markdown, to_markdown_with};
pub use model::*;
