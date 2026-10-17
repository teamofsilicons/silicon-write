//! Relative text ranges with a history-backed recovery path. A new copy of the same words is
//! not the original passage: recovery follows node identity and the change that replaced it.
use base64::Engine;
use serde::{Deserialize, Serialize};
use write_doc::history::{StoredUpdate, changes::Changes};
use write_doc::ydoc;
use yrs::updates::decoder::Decode;
use yrs::{ID, ReadTxn, Text, Transact, Update, XmlFragment, XmlOut};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Range {
    pub(super) start: String,
    pub(super) end: String,
}

impl Range {
    pub fn new(start: String, end: String) -> Self {
        Self { start, end }
    }
}

pub(super) fn resolve<T: ReadTxn>(
    txn: &T,
    map: &ydoc::TextMap,
    range: &Range,
) -> Option<(usize, usize)> {
    let from = ydoc::resolve_position(txn, map, &B64.decode(&range.start).ok()?)?;
    let to = ydoc::resolve_position(txn, map, &B64.decode(&range.end).ok()?)?;
    (to > from).then_some((from, to))
}

pub(super) fn capture<T: ReadTxn>(
    txn: &T,
    map: &ydoc::TextMap,
    from: usize,
    to: usize,
) -> Vec<Range> {
    map.texts
        .iter()
        .filter_map(|(start, text)| {
            let a = from.max(*start);
            let b = to.min(start + text.len(txn) as usize);
            if b <= a {
                return None;
            }
            Some(Range {
                start: B64.encode(ydoc::position_at(txn, map, a, false)?),
                end: B64.encode(ydoc::position_at(txn, map, b, true)?),
            })
        })
        .collect()
}

struct Block {
    id: ID,
    from: usize,
    to: usize,
    text: String,
}

fn blocks<T: ReadTxn>(txn: &T, fragment: &yrs::XmlFragmentRef, map: &ydoc::TextMap) -> Vec<Block> {
    fragment
        .children(txn)
        .enumerate()
        .filter_map(|(i, node)| {
            let XmlOut::Element(el) = node else {
                return None;
            };
            let yrs::BranchID::Nested(id) = XmlOut::Element(el).id() else {
                return None;
            };
            let &(from, to, _) = map.blocks.iter().find(|(_, _, index)| *index == i)?;
            Some(Block {
                id,
                from,
                to,
                text: map.slice(from, to),
            })
        })
        .collect()
}

/// The last actual passage, including the surrounding nodes. These identities distinguish it
/// from another paragraph with the same words, even after that other paragraph moves nearby.
struct Source {
    id: ID,
    text: String,
    from: usize,
    to: usize,
    before: Vec<ID>,
    after: Vec<ID>,
}

fn source(blocks: &[Block], from: usize, to: usize) -> Option<Source> {
    let i = blocks.iter().position(|b| from >= b.from && to <= b.to)?;
    let b = &blocks[i];
    Some(Source {
        id: b.id,
        text: b.text.clone(),
        from: from - b.from,
        to: to - b.from,
        before: blocks[..i].iter().rev().map(|b| b.id).collect(),
        after: blocks[i + 1..].iter().map(|b| b.id).collect(),
    })
}

/// Follows each selected text through changes after its creation. A structural replacement must
/// be made by the same update that removed its source. A deleted passage only revives in an
/// explicit restore/undo, and only in the original gap between surviving neighbouring nodes.
/// Both paths require an identical complete source block, never a global quote match.
pub(super) fn recover(
    updates: &[StoredUpdate],
    restoring: &std::collections::HashSet<i64>,
    seq: i64,
    ranges: &[Range],
) -> Result<Vec<Range>, write_doc::history::HistoryError> {
    use write_doc::history::HistoryError;
    let changes = Changes::new(updates)?;
    let y = write_doc::history::replay(
        updates
            .iter()
            .filter(|u| u.seq <= seq)
            .map(|u| u.update.as_slice()),
    )?;
    let fragment = ydoc::fragment(&y);
    let mut ranges = ranges.to_vec();
    let mut sources = {
        let txn = y.transact();
        let map = ydoc::text_map(&txn, &fragment);
        let blocks = blocks(&txn, &fragment, &map);
        ranges
            .iter()
            .map(|range| resolve(&txn, &map, range).and_then(|(a, b)| source(&blocks, a, b)))
            .collect::<Vec<_>>()
    };
    for update in updates.iter().filter(|u| u.seq > seq) {
        y.transact_mut()
            .apply_update(
                Update::decode_v1(&update.update)
                    .map_err(|e| HistoryError::Decode(e.to_string()))?,
            )
            .map_err(|e| HistoryError::Apply(e.to_string()))?;
        let txn = y.transact();
        let map = ydoc::text_map(&txn, &fragment);
        let blocks = blocks(&txn, &fragment, &map);
        for (range, origin) in ranges.iter_mut().zip(&mut sources) {
            if let Some((a, b)) = resolve(&txn, &map, range) {
                *origin = source(&blocks, a, b);
                continue;
            }
            let Some(old) = origin.as_ref() else {
                continue;
            };
            let lower = old
                .before
                .iter()
                .find_map(|id| blocks.iter().position(|b| b.id == *id))
                .map(|i| i + 1)
                .unwrap_or(0);
            let upper = old
                .after
                .iter()
                .find_map(|id| blocks.iter().position(|b| b.id == *id))
                .unwrap_or(blocks.len());
            if lower > upper {
                continue;
            }
            let mut candidates = blocks[lower..upper].iter().filter(|b| {
                let inserted_here = changes
                    .inserter(&b.id)
                    .is_some_and(|i| changes.list[i].seq == update.seq);
                b.text == old.text
                    && ((inserted_here && changes.replaced(&old.id, &b.id))
                        || (restoring.contains(&update.seq) && (inserted_here || old.id == b.id)))
            });
            let Some(block) = candidates.next() else {
                continue;
            };
            if candidates.next().is_some() {
                continue;
            }
            let (a, b) = (block.from + old.from, block.from + old.to);
            if b > block.to {
                continue;
            }
            let (Some(start), Some(end)) = (
                ydoc::position_at(&txn, &map, a, false),
                ydoc::position_at(&txn, &map, b, true),
            ) else {
                continue;
            };
            *range = Range {
                start: B64.encode(start),
                end: B64.encode(end),
            };
            *origin = source(&blocks, a, b);
        }
    }
    Ok(ranges)
}
