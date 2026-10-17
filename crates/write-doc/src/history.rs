//! History: every change to a doc is stored as the Yjs update it made, in order. Any version of a
//! doc is those updates replayed up to a point, and nothing is ever thinned out.
//!
//! - [`changes`]: who made each change, and which Yjs ids it inserted and deleted.
//! - [`blocks`]: a doc's top-level blocks with the elements that hold them, matched between two
//!   versions, and bringing some blocks of an older version back.
//! - [`compare`]: two versions side by side, block by block, with who added and removed what.
//! - [`undo`]: undoing everything one Carbon or Silicon changed since a version, leaving everyone
//!   else's changes in place.

pub mod blocks;
pub mod changes;
pub mod compare;
mod text;
pub mod undo;

use std::collections::HashSet;

use yrs::encoding::write::Write;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{Doc as YDoc, IdSet, ReadTxn, StateVector, Transact, Update};

use crate::model::Doc;
use crate::ydoc;

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("a stored change could not be read: {0}")]
    Decode(String),
    #[error("a stored change could not be applied: {0}")]
    Apply(String),
}

/// One stored change.
#[derive(Debug, Clone)]
pub struct StoredUpdate {
    pub seq: i64,
    /// The account (uuid) whose change this was.
    pub author: String,
    pub update: Vec<u8>,
}

/// A live doc built from stored updates.
pub fn replay<'a>(updates: impl IntoIterator<Item = &'a [u8]>) -> Result<YDoc, HistoryError> {
    let doc = ydoc::new_ydoc(1);
    {
        let mut txn = doc.transact_mut();
        for bytes in updates {
            let update =
                Update::decode_v1(bytes).map_err(|e| HistoryError::Decode(e.to_string()))?;
            txn.apply_update(update)
                .map_err(|e| HistoryError::Apply(e.to_string()))?;
        }
    }
    Ok(doc)
}

/// The doc as it read after the update with sequence number `seq`.
pub fn doc_at(updates: &[StoredUpdate], seq: i64) -> Result<Doc, HistoryError> {
    let ydoc = replay(
        updates
            .iter()
            .filter(|u| u.seq <= seq)
            .map(|u| u.update.as_slice()),
    )?;
    Ok(ydoc::read_doc(&ydoc))
}

/// The update without its deletions: only what it inserted.
pub fn without_deletions(update: &[u8]) -> Result<Vec<u8>, HistoryError> {
    let decoded = Update::decode_v1(update).map_err(|e| HistoryError::Decode(e.to_string()))?;
    let canonical = decoded.encode_v1();
    let mut ds = EncoderV1::new();
    decoded.delete_set().encode(&mut ds);
    let ds = ds.to_vec();
    // An encoded update is its inserted structures followed by its delete set.
    if canonical.len() >= ds.len() && canonical.ends_with(&ds) {
        let mut stripped = canonical[..canonical.len() - ds.len()].to_vec();
        let mut empty = EncoderV1::new();
        IdSet::default().encode(&mut empty);
        stripped.extend(empty.to_vec());
        Ok(stripped)
    } else {
        Err(HistoryError::Decode(
            "the update's delete set isn't where it was expected".into(),
        ))
    }
}

/// An update that only deletes the given ranges.
pub fn deletion_update(ids: &IdSet) -> Vec<u8> {
    let mut encoder = EncoderV1::new();
    // No inserted structures.
    encoder.write_var(0u32);
    ids.encode(&mut encoder);
    encoder.to_vec()
}

/// The state vector after replaying updates up to `seq`.
pub fn state_vector_at(updates: &[StoredUpdate], seq: i64) -> Result<StateVector, HistoryError> {
    let ydoc = replay(
        updates
            .iter()
            .filter(|u| u.seq <= seq)
            .map(|u| u.update.as_slice()),
    )?;
    let txn = ydoc.transact();
    Ok(txn.state_vector())
}

/// The doc as it would read if everything `author` changed after `since_seq` were undone, with
/// everyone else's changes kept ([`undo`]).
///
/// `clients` are the Yjs client ids that belong to the author.
pub fn undo_author_since(
    updates: &[StoredUpdate],
    author: &str,
    clients: &HashSet<u64>,
    since_seq: i64,
) -> Result<Doc, HistoryError> {
    undo::undo_author_since(updates, author, clients, since_seq)
}

/// Applies an update to a doc, in a transaction of its own.
pub(crate) fn apply(doc: &YDoc, update: &[u8]) -> Result<(), HistoryError> {
    let update = Update::decode_v1(update).map_err(|e| HistoryError::Decode(e.to_string()))?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(|e| HistoryError::Apply(e.to_string()))
}

/// The doc a full state describes, without the text of anything deleted: what someone who may not
/// read its history (a viewer, a commenter, someone with a public link) is given. Deleted items keep
/// their place (so later changes still land right), only their content goes.
pub fn without_history(full_state: &[u8]) -> Result<yrs::Doc, yrs::encoding::read::Error> {
    let doc = yrs::Doc::with_options(yrs::Options {
        skip_gc: false,
        offset_kind: yrs::OffsetKind::Utf16,
        ..yrs::Options::default()
    });
    let update = Update::decode_v1(full_state)?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(|_| yrs::encoding::read::Error::UnexpectedValue)?;
    Ok(doc)
}

/// For each client that inserted anything in an update: the clock just past its last insertion.
/// (`Update::state_vector` only counts updates that start at clock 0, i.e. whole documents.)
pub fn inserted_upper(update: &Update) -> Vec<(u64, u32)> {
    let mut out: Vec<(u64, u32)> = vec![];
    for (client, ranges) in update.insertions(true).iter() {
        let end = ranges.iter().map(|r| r.end).max().unwrap_or(0);
        if end > 0 {
            out.push((client.get(), end));
        }
    }
    out
}

/// The client ids that inserted anything in an update.
pub fn update_clients(update: &[u8]) -> Result<Vec<u64>, HistoryError> {
    let decoded = Update::decode_v1(update).map_err(|e| HistoryError::Decode(e.to_string()))?;
    Ok(inserted_upper(&decoded)
        .into_iter()
        .map(|(client, _)| client)
        .collect())
}

/// For each update: who it deleted text of. Used to say who removed something in a comparison.
pub fn deletions(update: &[u8]) -> Result<IdSet, HistoryError> {
    let decoded = Update::decode_v1(update).map_err(|e| HistoryError::Decode(e.to_string()))?;
    Ok(decoded.delete_set().clone())
}

/// The clients whose insertions in `update` go beyond `known` (what the live doc already has).
pub fn new_insertions(update: &[u8], known: &StateVector) -> Result<Vec<u64>, HistoryError> {
    let decoded = Update::decode_v1(update).map_err(|e| HistoryError::Decode(e.to_string()))?;
    Ok(inserted_upper(&decoded)
        .into_iter()
        .filter(|(client, end)| *end > known.get(&yrs::ClientID::new(*client)))
        .map(|(client, _)| client)
        .collect())
}
