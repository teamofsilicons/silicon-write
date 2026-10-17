//! Relative text ranges with a history-backed recovery path. A new copy of the same words is
//! not the original passage: recovery follows node identity and the change that replaced it.
use base64::Engine;
use serde::{Deserialize, Serialize};
use write_doc::history::{StoredUpdate, changes::Changes};
use write_doc::model::{Suggestion, SuggestionKind};
use write_doc::ydoc;
use yrs::updates::decoder::Decode;
use yrs::{ID, ReadTxn, Text, Transact, Update, XmlFragment, XmlOut};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[cfg(test)]
mod tests;

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
    suggestion: Option<Suggestion>,
}

fn blocks<T: ReadTxn>(txn: &T, fragment: &yrs::XmlFragmentRef, map: &ydoc::TextMap) -> Vec<Block> {
    fragment
        .children(txn)
        .enumerate()
        .filter_map(|(i, node)| {
            let XmlOut::Element(el) = node else {
                return None;
            };
            let suggestion = ydoc::node_suggestion(txn, &el);
            let yrs::BranchID::Nested(id) = XmlOut::Element(el).id() else {
                return None;
            };
            let &(from, to, _) = map.blocks.iter().find(|(_, _, index)| *index == i)?;
            Some(Block {
                id,
                from,
                to,
                text: map.slice(from, to),
                suggestion,
            })
        })
        .collect()
}

/// A structural review keeps the already-created Insert nodes and removes the Delete nodes.
/// Follow only that exact proposal's identities, and only when its text is unchanged. Joining
/// the block text without separators permits a paragraph split/join while preserving offsets.
fn accepted_ranges(
    old: &Source,
    before: &[Block],
    after: &[Block],
    changes: &Changes,
    seq: i64,
) -> Option<Vec<(usize, usize)>> {
    let original = before.iter().find(|b| b.id == old.id)?;
    // An unresolved selection may describe text deleted earlier within this same node.
    // A later review must not apply those stale offsets to the surviving words.
    if original.text != old.text || old.to > original.to - original.from {
        return None;
    }
    let suggestion = original.suggestion.as_ref()?;
    if suggestion.kind != SuggestionKind::Delete {
        return None;
    }
    let same = |b: &&Block| {
        b.suggestion
            .as_ref()
            .is_some_and(|s| s.id == suggestion.id && s.author == suggestion.author)
    };
    let group: Vec<_> = before.iter().filter(same).collect();
    let first = before.iter().position(|b| same(&b))?;
    let last = before.iter().rposition(|b| same(&b))?;
    if last - first + 1 != group.len() {
        return None;
    }
    let deleted: Vec<_> = group
        .iter()
        .copied()
        .filter(|b| b.suggestion.as_ref().unwrap().kind == SuggestionKind::Delete)
        .collect();
    let inserted: Vec<_> = group
        .iter()
        .copied()
        .filter(|b| b.suggestion.as_ref().unwrap().kind == SuggestionKind::Insert)
        .collect();
    if inserted.is_empty()
        || deleted.iter().any(|b| {
            after.iter().any(|a| a.id == b.id)
                || !changes
                    .deleter(&b.id)
                    .is_some_and(|i| changes.list[i].seq == seq)
        })
        || after.iter().any(|b| same(&b))
    {
        return None;
    }
    let targets: Vec<_> = inserted
        .iter()
        .map(|b| {
            after
                .iter()
                .find(|a| a.id == b.id && a.suggestion.is_none() && a.text == b.text)
        })
        .collect::<Option<_>>()?;
    // The same nodes must still occur in proposal order.
    if targets.windows(2).any(|pair| {
        let left = after.iter().position(|b| b.id == pair[0].id).unwrap();
        after.get(left + 1).is_none_or(|b| b.id != pair[1].id)
    }) || deleted.iter().map(|b| b.text.as_str()).collect::<String>()
        != targets.iter().map(|b| b.text.as_str()).collect::<String>()
    {
        return None;
    }
    let prefix: usize = deleted
        .iter()
        .take_while(|b| b.id != old.id)
        .map(|b| b.to - b.from)
        .sum();
    let (start, end) = (prefix + old.from, prefix + old.to);
    let mut offset = 0;
    let mut result = Vec::new();
    for target in targets {
        let length = target.to - target.from;
        let (a, b) = (start.max(offset), end.min(offset + length));
        if a < b {
            result.push((target.from + a - offset, target.from + b - offset));
        }
        offset += length;
    }
    (!result.is_empty()).then_some(result)
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
/// Review decisions additionally follow the same proposal's retained nodes across block splits.
/// None of these paths use a global quote match.
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
    let (mut tracked, mut previous) = {
        let txn = y.transact();
        let map = ydoc::text_map(&txn, &fragment);
        let blocks = blocks(&txn, &fragment, &map);
        let tracked = ranges
            .iter()
            .map(|range| {
                (
                    range.clone(),
                    resolve(&txn, &map, range).and_then(|(a, b)| source(&blocks, a, b)),
                )
            })
            .collect::<Vec<_>>();
        (tracked, blocks)
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
        let mut next = Vec::new();
        for (mut range, mut origin) in tracked {
            if let Some((a, b)) = resolve(&txn, &map, &range) {
                next.push((range, source(&blocks, a, b)));
                continue;
            }
            let Some(old) = origin.as_ref() else {
                next.push((range, origin));
                continue;
            };
            if let Some(positions) = accepted_ranges(old, &previous, &blocks, &changes, update.seq)
            {
                for (a, b) in positions {
                    for part in capture(&txn, &map, a, b) {
                        let origin =
                            resolve(&txn, &map, &part).and_then(|(a, b)| source(&blocks, a, b));
                        next.push((part, origin));
                    }
                }
                continue;
            }
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
                next.push((range, origin));
                continue;
            }
            let candidates: Vec<_> = blocks[lower..upper]
                .iter()
                .filter(|b| {
                    let inserted_here = changes
                        .inserter(&b.id)
                        .is_some_and(|i| changes.list[i].seq == update.seq);
                    b.text == old.text
                        && ((inserted_here && changes.replaced(&old.id, &b.id))
                            || (restoring.contains(&update.seq)
                                && (inserted_here || old.id == b.id)))
                })
                .collect();
            // A reconstructed proposal contains two equal passages. The Delete side is the
            // current text; the Insert side is its alternative, not another original passage.
            let mut candidates = candidates.iter().copied().filter(|b| {
                !b.suggestion.as_ref().is_some_and(|s| {
                    s.kind == SuggestionKind::Insert
                        && candidates.iter().any(|other| {
                            other.suggestion.as_ref().is_some_and(|d| {
                                d.kind == SuggestionKind::Delete
                                    && d.id == s.id
                                    && d.author == s.author
                            })
                        })
                })
            });
            let Some(block) = candidates.next() else {
                next.push((range, origin));
                continue;
            };
            if candidates.next().is_some() {
                next.push((range, origin));
                continue;
            }
            let (a, b) = (block.from + old.from, block.from + old.to);
            if b > block.to {
                next.push((range, origin));
                continue;
            }
            let (Some(start), Some(end)) = (
                ydoc::position_at(&txn, &map, a, false),
                ydoc::position_at(&txn, &map, b, true),
            ) else {
                next.push((range, origin));
                continue;
            };
            range = Range {
                start: B64.encode(start),
                end: B64.encode(end),
            };
            origin = source(&blocks, a, b);
            next.push((range, origin));
        }
        tracked = next;
        previous = blocks;
    }
    Ok(tracked.into_iter().map(|(range, _)| range).collect())
}

/// Section comments are points, but formatting may recreate the entire containing block.
/// Recover its original text through the same causal history as a text comment, then keep a
/// point inside the one surviving section. Never turn a section into a text-range comment or
/// guess between multiple sections after a split.
pub(super) fn recover_section(
    updates: &[StoredUpdate],
    restoring: &std::collections::HashSet<i64>,
    seq: i64,
    start: &str,
) -> Result<Option<String>, write_doc::history::HistoryError> {
    let y = write_doc::history::replay(
        updates
            .iter()
            .filter(|u| u.seq <= seq)
            .map(|u| u.update.as_slice()),
    )?;
    let fragment = ydoc::fragment(&y);
    let ranges = {
        let txn = y.transact();
        let map = ydoc::text_map(&txn, &fragment);
        let Some(at) = B64
            .decode(start)
            .ok()
            .and_then(|position| ydoc::resolve_position(&txn, &map, &position))
        else {
            return Ok(None);
        };
        let Some(&(from, to, _)) = map
            .blocks
            .iter()
            .find(|&&(from, to, _)| at >= from && at <= to)
        else {
            return Ok(None);
        };
        capture(&txn, &map, from, to)
    };
    let recovered = recover(updates, restoring, seq, &ranges)?;
    let current = write_doc::history::replay(updates.iter().map(|u| u.update.as_slice()))?;
    let fragment = ydoc::fragment(&current);
    let txn = current.transact();
    let map = ydoc::text_map(&txn, &fragment);
    let surviving: Vec<_> = recovered
        .iter()
        .filter_map(|range| resolve(&txn, &map, range).map(|(from, to)| (range, from, to)))
        .collect();
    let Some((first, from, _)) = surviving.iter().min_by_key(|(_, from, _)| *from) else {
        return Ok(None);
    };
    let Some(block) = map.block_at(*from) else {
        return Ok(None);
    };
    if surviving.iter().any(|(_, from, to)| {
        map.block_at(*from) != Some(block) || map.block_at(to.saturating_sub(1)) != Some(block)
    }) {
        return Ok(None);
    }
    Ok(Some(first.start.clone()))
}
