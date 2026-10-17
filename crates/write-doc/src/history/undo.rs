//! Selective undo uses the CRDT's undo operation, including its attribute and formatting history.
//! Inserted containers that now hold somebody else's content are retained: undoing their creator
//! removes that creator's text, never the other writer's words inside it.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use yrs::updates::decoder::Decode;
use yrs::{DeepObservable, ID, IdSet, ReadTxn, Transact, UndoManager, Update, XmlFragment, XmlOut};

use super::text;
use super::{HistoryError, StoredUpdate};
use crate::{Doc, ydoc};

pub fn undo_author_since(
    updates: &[StoredUpdate],
    author: &str,
    _clients: &HashSet<u64>,
    since: i64,
) -> Result<Doc, HistoryError> {
    let y = ydoc::new_ydoc(text::SCRATCH_CLIENT);
    let fragment = ydoc::fragment(&y);
    let mut inserted = IdSet::default();
    let mut deleted = IdSet::default();
    let mut already_deleted = IdSet::default();
    // An attribute changed by somebody else also makes a newly created node theirs to keep
    // (for example, a picture whose address they changed). Remember these per stored change.
    let attributes: Arc<Mutex<HashSet<ID>>> = Arc::default();
    let sink = attributes.clone();
    fragment.observe_deep("undo-attributes", move |txn, events| {
        let mut touched = sink.lock().unwrap();
        for event in events.iter() {
            if let yrs::types::Event::XmlFragment(event) = event
                && !event.keys(txn).is_empty()
                && let XmlOut::Element(el) = event.target()
                && let Some(id) = text::branch_id(el)
            {
                touched.insert(id);
            }
        }
    });
    let mut others_attributes = HashSet::new();
    for stored in updates {
        let update =
            Update::decode_v1(&stored.update).map_err(|e| HistoryError::Decode(e.to_string()))?;
        if stored.author == author && stored.seq > since {
            inserted.merge_with(update.insertions(true));
            // An update can repeat old deletion ranges. Only its new deletions are this author's.
            deleted.merge_with(update.delete_set().diff(&already_deleted));
        }
        already_deleted.merge_with(update.delete_set().clone());
        y.transact_mut()
            .apply_update(update)
            .map_err(|e| HistoryError::Apply(e.to_string()))?;
        let touched = std::mem::take(&mut *attributes.lock().unwrap());
        if stored.author != author && stored.seq > since {
            others_attributes.extend(touched);
        }
    }
    fragment.unobserve_deep("undo-attributes");

    // Keep the element/text wrappers around any content that isn't being undone. Without this,
    // deleting a paragraph's element would also erase another account's later additions to it.
    let mut keep = IdSet::default();
    {
        let mut txn = y.transact_mut();
        let shown = txn.snapshot();
        for node in fragment.children(&txn).collect::<Vec<_>>() {
            protect(
                &mut txn,
                &node,
                &shown,
                &inserted,
                &others_attributes,
                &mut keep,
            );
        }
    }
    inserted.diff_with(&keep);
    let mut undo = UndoManager::with_options(yrs::undo::Options {
        init_undo_stack: vec![yrs::undo::StackItem::new(y.guid(), deleted, inserted)],
        ..Default::default()
    });
    undo.expand_scope(&y, &fragment);
    undo.undo_blocking();
    Ok(ydoc::read_doc(&y))
}

fn protect(
    txn: &mut yrs::TransactionMut,
    node: &XmlOut,
    shown: &yrs::Snapshot,
    inserted: &IdSet,
    others_attributes: &HashSet<ID>,
    keep: &mut IdSet,
) -> bool {
    let (id, preserved) = match node {
        XmlOut::Text(t) => {
            let preserved = text::runs(txn, t, shown)
                .iter()
                .any(|r| r.chars().any(|(id, _)| !inserted.contains(&id)));
            (text::branch_id(t), preserved)
        }
        XmlOut::Element(el) => {
            let mut preserved = text::branch_id(el)
                .is_some_and(|id| !inserted.contains(&id) || others_attributes.contains(&id));
            for child in el.children(txn).collect::<Vec<_>>() {
                preserved |= protect(txn, &child, shown, inserted, others_attributes, keep);
            }
            (text::branch_id(el), preserved)
        }
        XmlOut::Fragment(_) => return false,
    };
    if preserved && let Some(id) = id {
        keep.insert(id, 1);
    }
    preserved
}
