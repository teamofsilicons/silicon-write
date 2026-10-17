//! Who made each stored change, and what it inserted and deleted, by Yjs id.
//!
//! Every Yjs item (a run of characters, an element, a formatting mark, an attribute value) is
//! inserted by exactly one change, and deleted by at most one (two only when two editors deleted
//! the same text at the same moment; the first stored counts). That is what says who wrote a
//! passage, who removed a block, or which change replaced one block with another.

use std::collections::{BTreeMap, HashMap};
use std::ops::Range;

use yrs::updates::decoder::Decode;
use yrs::{ID, IdSet, Update};

use super::{HistoryError, StoredUpdate};

/// One stored change: its number, its author, and the Yjs ids it inserted and deleted.
#[derive(Debug, Clone)]
pub struct Change {
    pub seq: i64,
    /// The account (uuid) whose change it was.
    pub author: String,
    pub inserted: IdSet,
    pub deleted: IdSet,
}

/// Clock ranges of one client, each with the change it belongs to.
type Ranges = BTreeMap<u32, (u32, usize)>;

/// A doc's changes, with lookups from a Yjs id to the change that inserted it and the first change
/// that deleted it.
pub struct Changes {
    pub list: Vec<Change>,
    inserters: HashMap<u64, Ranges>,
    deleters: HashMap<u64, Ranges>,
}

impl Changes {
    /// `updates` in the order they were stored.
    pub fn new(updates: &[StoredUpdate]) -> Result<Changes, HistoryError> {
        let mut list = Vec::with_capacity(updates.len());
        let mut inserters: HashMap<u64, Ranges> = HashMap::new();
        let mut deleters: HashMap<u64, Ranges> = HashMap::new();
        for (index, stored) in updates.iter().enumerate() {
            let update = Update::decode_v1(&stored.update)
                .map_err(|e| HistoryError::Decode(e.to_string()))?;
            let inserted = update.insertions(true);
            let deleted = update.delete_set().clone();
            for (client, ranges) in inserted.iter() {
                let map = inserters.entry(client.get()).or_default();
                for range in ranges.iter() {
                    claim(map, range.clone(), index);
                }
            }
            for (client, ranges) in deleted.iter() {
                let map = deleters.entry(client.get()).or_default();
                for range in ranges.iter() {
                    claim(map, range.clone(), index);
                }
            }
            list.push(Change {
                seq: stored.seq,
                author: stored.author.clone(),
                inserted,
                deleted,
            });
        }
        Ok(Changes {
            list,
            inserters,
            deleters,
        })
    }

    /// The change (its index in `list`) that inserted `id`.
    pub fn inserter(&self, id: &ID) -> Option<usize> {
        find(self.inserters.get(&id.client.get())?, id.clock)
    }

    /// The first change (its index in `list`) that deleted `id`.
    pub fn deleter(&self, id: &ID) -> Option<usize> {
        find(self.deleters.get(&id.client.get())?, id.clock)
    }

    /// Who wrote `id`.
    pub fn author_of(&self, id: &ID) -> Option<&str> {
        self.inserter(id).map(|i| self.list[i].author.as_str())
    }

    /// Who deleted `id` first.
    pub fn deleted_by(&self, id: &ID) -> Option<&str> {
        self.deleter(id).map(|i| self.list[i].author.as_str())
    }

    /// Whether `new` was inserted by the very change that deleted `old`: one change replaced one
    /// with the other (a paragraph turned into a heading, a block written again).
    pub fn replaced(&self, old: &ID, new: &ID) -> bool {
        match (self.deleter(old), self.inserter(new)) {
            (Some(d), Some(i)) => d == i,
            _ => false,
        }
    }
}

/// Gives the parts of `range` no earlier change has to `index`.
fn claim(map: &mut Ranges, range: Range<u32>, index: usize) {
    if range.is_empty() {
        return;
    }
    // The ranges already there that overlap it (they don't overlap each other, so their ends grow
    // with their starts).
    let mut taken: Vec<(u32, u32)> = map
        .range(..range.end)
        .rev()
        .map(|(start, (end, _))| (*start, *end))
        .take_while(|(_, end)| *end > range.start)
        .collect();
    taken.reverse();
    let mut at = range.start;
    for (start, end) in taken {
        if start > at {
            map.insert(at, (start, index));
        }
        at = at.max(end);
    }
    if at < range.end {
        map.insert(at, (range.end, index));
    }
}

fn find(map: &Ranges, clock: u32) -> Option<usize> {
    let (_, (end, index)) = map.range(..=clock).next_back()?;
    (clock < *end).then_some(*index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_claim_wins_and_gaps_are_filled() {
        let mut map = Ranges::new();
        claim(&mut map, 5..10, 0);
        claim(&mut map, 0..20, 1);
        claim(&mut map, 8..12, 2);
        assert_eq!(find(&map, 0), Some(1));
        assert_eq!(find(&map, 4), Some(1));
        assert_eq!(find(&map, 5), Some(0));
        assert_eq!(find(&map, 9), Some(0));
        assert_eq!(find(&map, 10), Some(1));
        assert_eq!(find(&map, 19), Some(1));
        assert_eq!(find(&map, 20), None);
    }
}
