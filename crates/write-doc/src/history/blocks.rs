//! A doc's top-level blocks with the elements that hold them, matched between two versions of the
//! doc, and some blocks of an older version brought back into the doc as it is now.
//!
//! A block keeps its element for as long as it lives: edited in place, it is still the same
//! element, and Yjs never moves an element, so the elements two versions share are in the same
//! order in both. Matching by element tells blocks apart that position or text alone can't: a
//! removed paragraph next to an edited one, or a paragraph removed where another was added.
//! Between the shared elements, blocks that read the same are the same block, and a block one
//! change replaced with another (a paragraph turned into a heading is written as a new element)
//! is that block, changed.

use std::collections::HashMap;
use std::ops::{Range, RangeInclusive};

use yrs::{ID, ReadTxn, XmlElementRef, XmlFragment, XmlFragmentRef, XmlOut};

use super::text::branch_id;
use crate::model::{Block, Doc};
use crate::ydoc;

/// A top-level block of a doc and the element that holds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Placed {
    /// Where the block is among the doc's blocks, as [`ydoc::read`] lists them (what a restore of
    /// some blocks names).
    pub index: usize,
    /// The element's Yjs id.
    pub id: ID,
    /// The block as it reads: without pending suggestions.
    pub reading: Block,
}

/// The doc's blocks (as [`ydoc::read`] gives them), and the ones that show when it is read, each
/// with its element. An empty paragraph doesn't show (Markdown has none), nor does a paragraph that
/// is only a pending suggestion; an empty doc has no blocks at all.
pub fn placed<T: ReadTxn>(txn: &T, frag: &XmlFragmentRef) -> (Doc, Vec<Placed>) {
    let (doc, placed) = placed_elements(txn, frag);
    (doc, placed.into_iter().map(|(p, _)| p).collect())
}

/// [`placed`], with each block's element.
pub fn placed_elements<T: ReadTxn>(
    txn: &T,
    frag: &XmlFragmentRef,
) -> (Doc, Vec<(Placed, XmlElementRef)>) {
    let doc = ydoc::read(txn, frag);
    let mut out = vec![];
    let mut index = 0;
    for child in frag.children(txn) {
        let XmlOut::Element(el) = child else { continue };
        // `read` skips elements it doesn't know; the ones it knows are its blocks, in order.
        let Some(block) = doc.blocks.get(index) else {
            break;
        };
        if el.tag().as_ref() != block.type_name() {
            continue;
        }
        if !block.is_empty_paragraph()
            && !block.is_suggested_only()
            && let Some(id) = branch_id(&el)
        {
            out.push((
                Placed {
                    index,
                    id,
                    reading: reading(block),
                },
                el,
            ));
        }
        index += 1;
    }
    (doc, out)
}

/// A block as it reads: pending suggested insertions left out, everything else as it is.
pub fn reading(block: &Block) -> Block {
    Doc {
        blocks: vec![block.clone()],
    }
    .without_suggestions()
    .blocks
    .into_iter()
    .next()
    .unwrap_or_else(Block::empty_paragraph)
}

/// How a block of one version matches a block of another (indexes into the two lists given to
/// [`align`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pair {
    /// The same block, reading the same.
    Same(usize, usize),
    /// The same block, changed.
    Changed(usize, usize),
    /// Only in the earlier version.
    Removed(usize),
    /// Only in the later version.
    Added(usize),
}

/// Matches the blocks of an earlier version of a doc with those of a later one, in document order.
/// `replaced(old, new)` says whether one change replaced element `old` with element `new`.
pub fn align(
    before: &[Placed],
    after: &[Placed],
    replaced: impl Fn(&ID, &ID) -> bool,
) -> Vec<Pair> {
    let position: HashMap<ID, usize> = after.iter().enumerate().map(|(j, p)| (p.id, j)).collect();
    // The elements both versions have, which are in the same order in both.
    let mut shared: Vec<(usize, usize)> = vec![];
    for (i, p) in before.iter().enumerate() {
        if let Some(&j) = position.get(&p.id)
            && shared.last().is_none_or(|&(_, last)| j > last)
        {
            shared.push((i, j));
        }
    }
    let mut out = vec![];
    let (mut i0, mut j0) = (0, 0);
    for (i, j) in shared {
        between(before, after, i0..i, j0..j, &replaced, &mut out);
        out.push(if before[i].reading == after[j].reading {
            Pair::Same(i, j)
        } else {
            Pair::Changed(i, j)
        });
        (i0, j0) = (i + 1, j + 1);
    }
    between(
        before,
        after,
        i0..before.len(),
        j0..after.len(),
        &replaced,
        &mut out,
    );
    out
}

/// The blocks between two shared elements: those that read the same are the same block; of the
/// rest, a block replaced with another is that block changed.
fn between(
    before: &[Placed],
    after: &[Placed],
    old: Range<usize>,
    new: Range<usize>,
    replaced: &impl Fn(&ID, &ID) -> bool,
    out: &mut Vec<Pair>,
) {
    let old_reading: Vec<&Block> = before[old.clone()].iter().map(|p| &p.reading).collect();
    let new_reading: Vec<&Block> = after[new.clone()].iter().map(|p| &p.reading).collect();
    for op in similar::capture_diff_slices(similar::Algorithm::Myers, &old_reading, &new_reading) {
        let (tag, o, n) = op.as_tag_tuple();
        let (o, n) = (
            old.start + o.start..old.start + o.end,
            new.start + n.start..new.start + n.end,
        );
        if tag == similar::DiffTag::Equal {
            out.extend(o.zip(n).map(|(i, j)| Pair::Same(i, j)));
            continue;
        }
        let mut removed = vec![];
        let mut next = n.start;
        for i in o {
            match (next..n.end).find(|&j| replaced(&before[i].id, &after[j].id)) {
                Some(j) => {
                    out.extend(removed.drain(..).map(Pair::Removed));
                    out.extend((next..j).map(Pair::Added));
                    out.push(Pair::Changed(i, j));
                    next = j + 1;
                }
                None => removed.push(i),
            }
        }
        out.extend(removed.into_iter().map(Pair::Removed));
        out.extend((next..n.end).map(Pair::Added));
    }
}

/// The doc as it is now (`current`), with the blocks of an older version (`old`) whose indexes are
/// in `range` brought back: each in place of what it became, or where it was if it was removed.
/// Every other block, including ones added since, stays as it is.
pub fn bring_back(
    old: &Doc,
    old_placed: &[Placed],
    current: &Doc,
    current_placed: &[Placed],
    range: RangeInclusive<usize>,
    replaced: impl Fn(&ID, &ID) -> bool,
) -> Doc {
    let wanted = |i: usize| range.contains(&old_placed[i].index);
    let mut blocks: Vec<Block> = Vec::with_capacity(current.blocks.len() + 1);
    // Current blocks before this index are in `blocks` already.
    let mut next = 0;
    for pair in align(old_placed, current_placed, replaced) {
        match pair {
            Pair::Removed(i) => {
                if wanted(i) {
                    blocks.push(old.blocks[old_placed[i].index].clone());
                }
            }
            Pair::Same(_, j) | Pair::Added(j) => {
                let at = current_placed[j].index;
                blocks.extend_from_slice(&current.blocks[next..=at]);
                next = at + 1;
            }
            Pair::Changed(i, j) => {
                let at = current_placed[j].index;
                blocks.extend_from_slice(&current.blocks[next..at]);
                blocks.push(if wanted(i) {
                    old.blocks[old_placed[i].index].clone()
                } else {
                    current.blocks[at].clone()
                });
                next = at + 1;
            }
        }
    }
    blocks.extend_from_slice(&current.blocks[next.min(current.blocks.len())..]);
    Doc { blocks }
}
