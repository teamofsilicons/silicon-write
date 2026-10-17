//! Characters with their Yjs ids, the ids of elements and texts, and docs with chosen parts of
//! their history shown.

use yrs::branch::Branch;
use yrs::types::Attrs;
use yrs::types::text::YChange;
use yrs::{Any, BranchID, ID, IdSet, Out, Snapshot, StateVector, Text, TransactionMut, XmlTextRef};

use crate::model::SuggestionKind;
use crate::ydoc;

/// The client id the history's own scratch edits are made with: outside the range Yjs clients
/// use, so it is never one of the doc's.
pub(crate) const SCRATCH_CLIENT: u64 = 1 << 40;

/// The Yjs id of an element or text: the id of the item that holds it.
pub(crate) fn branch_id<B: AsRef<Branch>>(branch: &B) -> Option<ID> {
    match branch.as_ref().id() {
        BranchID::Nested(id) => Some(id),
        BranchID::Root(_) => None,
    }
}

/// The characters one item holds, as a version shows them: the first one's id, the text, and its
/// formatting in that version.
#[derive(Debug, Clone)]
pub(crate) struct Run {
    pub id: ID,
    pub text: String,
    pub attrs: Option<Box<Attrs>>,
}

impl Run {
    /// Each character with its id (ids count UTF-16 units, as Yjs clocks do).
    pub fn chars(&self) -> impl Iterator<Item = (ID, char)> + '_ {
        let mut clock = self.id.clock;
        self.text.chars().map(move |ch| {
            let id = ID::new(self.id.client, clock);
            clock += ch.len_utf16() as u32;
            (id, ch)
        })
    }

    /// Whether the run is text suggested for insertion and not yet accepted: not part of the doc
    /// as it reads.
    pub fn is_pending_insertion(&self) -> bool {
        let marks = ydoc::attrs_to_marks(self.attrs.as_deref());
        marks
            .suggestion
            .is_some_and(|s| s.kind == SuggestionKind::Insert)
    }
}

/// The characters of `text` that `shown` shows, in order, one run per item.
pub(crate) fn runs(txn: &mut TransactionMut, text: &XmlTextRef, shown: &Snapshot) -> Vec<Run> {
    text.diff_range(txn, Some(shown), Some(&nothing()), YChange::identity)
        .into_iter()
        .filter_map(|d| {
            let id = d.ychange?.id;
            match d.insert {
                Out::Any(Any::String(s)) => Some(Run {
                    id,
                    text: s.to_string(),
                    attrs: d.attributes,
                }),
                _ => None,
            }
        })
        .collect()
}

/// A snapshot that shows nothing.
pub(crate) fn nothing() -> Snapshot {
    Snapshot::new(StateVector::default(), IdSet::default())
}

/// The ids a state vector covers: everything inserted up to it.
pub(crate) fn covered(sv: &StateVector) -> IdSet {
    let mut set = IdSet::default();
    for (client, clock) in sv.iter() {
        if *clock > 0 {
            set.insert(ID::new(*client, 0), *clock);
        }
    }
    set
}

/// A snapshot that shows what either of two snapshots of the same doc shows (`later` taken after
/// `earlier`).
pub(crate) fn either(earlier: &Snapshot, later: &Snapshot) -> Snapshot {
    // Live in the earlier one: inserted by then and not deleted by then.
    let live_earlier = covered(&earlier.state_map).diff(&earlier.delete_set);
    Snapshot::new(
        later.state_map.clone(),
        later.delete_set.diff(&live_earlier),
    )
}
