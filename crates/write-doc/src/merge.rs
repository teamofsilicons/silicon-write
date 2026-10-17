//! Merging a whole version written from an older one with everything changed since.
//!
//! A Silicon reads a doc as Markdown, works on it, and writes the whole doc back with the version
//! it read (`PUT /v1/docs/{id}/markdown` with `base_seq`, which `write push` uses). Meanwhile
//! others kept editing. [`plan`] compares the three versions (UNDERSTANDING.md, "Never
//! overwritten"):
//!
//! - what only one side changed is merged as usual;
//! - a change both sides made the same way is made once, not twice;
//! - where both changed the same text differently, the merge can't be clean: the doc keeps the
//!   text as it is now, and the incoming version of that passage becomes a suggestion on it
//!   ([`place`]). The conflict shows in the doc, can be accepted or rejected, and both sides stay
//!   in the history.
//!
//! Blocks are compared whole. A block both sides changed is merged character by character (in its
//! Markdown) when their changes don't touch.

use std::ops::Range;

use crate::markdown::{from_markdown, to_markdown};
use crate::model::{Block, Doc};

/// A passage both sides changed differently.
#[derive(Debug, Clone, PartialEq)]
pub struct Conflict {
    /// The passage as the version the incoming one was written from had it.
    pub base: Vec<Block>,
    /// The passage as the doc has it now.
    pub theirs: Vec<Block>,
    /// Where `theirs` is among the doc's blocks now.
    pub theirs_at: Range<usize>,
    /// The passage as the incoming version has it.
    pub yours: Vec<Block>,
    /// What the suggestion turns `theirs` into: `yours`, keeping the changes made since wherever
    /// the incoming version left that text alone.
    pub target: Vec<Block>,
}

/// How to merge an incoming version.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// The incoming version less its conflicting changes, and less the changes the doc already
    /// has: changing the base version into this, and merging that into the doc, is clean.
    pub direct: Doc,
    /// Where the merge can't be clean, in the order they appear in the doc.
    pub conflicts: Vec<Conflict>,
}

/// Plans merging `yours`, written from `base`, into the doc, which has become `theirs` since. All
/// three as read from Markdown (`from_markdown(&to_markdown(..))`), the form edits are made in.
pub fn plan(base: &Doc, theirs: &Doc, yours: &Doc) -> Plan {
    let (b, t, y) = (&base.blocks[..], &theirs.blocks[..], &yours.blocks[..]);
    let mut direct: Vec<Block> = vec![];
    let mut conflicts: Vec<Conflict> = vec![];
    let mut copied = 0; // base blocks up to here are in `direct`
    let (mut t_shift, mut y_shift) = (0isize, 0isize); // what earlier hunks did to the sides' indices
    for cluster in clusters(&hunks(b, t), &hunks(b, y)) {
        let range = cluster.base.clone();
        direct.extend_from_slice(&b[copied..range.start]);
        copied = range.end;
        let t_range = shifted(&range, t_shift, cluster.theirs_growth);
        let y_range = shifted(&range, y_shift, cluster.yours_growth);
        t_shift += cluster.theirs_growth;
        y_shift += cluster.yours_growth;
        let (bp, tp, yp) = (&b[range.clone()], &t[t_range.clone()], &y[y_range.clone()]);
        match (cluster.theirs, cluster.yours) {
            // Only the incoming version changed this: take it.
            (false, true) => direct.extend_from_slice(yp),
            // Only the doc changed: it already has it.
            (true, false) => direct.extend_from_slice(bp),
            (true, true) | (false, false) => resolve(bp, tp, yp, t_range, &mut direct, &mut conflicts),
        }
    }
    direct.extend_from_slice(&b[copied..]);
    Plan { direct: Doc { blocks: direct }, conflicts }
}

/// `now` (the doc once the clean part of the merge is in) with the conflict's passage replaced by
/// its target: what the suggestion makes of it. `theirs` is the doc as [`plan`] saw it. When the
/// passage can't be found whole in `now`, the target goes after the nearest block before it that
/// can be found, and nothing is taken out.
pub fn place(theirs: &Doc, now: &Doc, conflict: &Conflict) -> Doc {
    let map = block_map(&theirs.blocks, &now.blocks);
    let at = &conflict.theirs_at;
    // Just after the nearest block before `index` that is still there.
    let after_previous = |index: usize| -> usize {
        (0..index.min(map.len())).rev().find_map(|i| map[i]).map(|d| d + 1).unwrap_or(0)
    };
    let found: Option<Range<usize>> = if at.is_empty() {
        Some(after_previous(at.start)..after_previous(at.start))
    } else {
        let mapped: Option<Vec<usize>> = at.clone().map(|i| map.get(i).copied().flatten()).collect();
        mapped
            .filter(|ds| ds.windows(2).all(|w| w[1] == w[0] + 1))
            .map(|ds| ds[0]..ds[ds.len() - 1] + 1)
    };
    let range = found.unwrap_or_else(|| after_previous(at.start)..after_previous(at.start));
    let mut blocks = now.blocks.clone();
    blocks.splice(range, conflict.target.iter().cloned());
    Doc { blocks }
}

/// Where each of `from`'s blocks is in `to`, for the blocks that are still there unchanged.
fn block_map(from: &[Block], to: &[Block]) -> Vec<Option<usize>> {
    let mut map = vec![None; from.len()];
    for op in similar::capture_diff_slices(similar::Algorithm::Myers, from, to) {
        if let similar::DiffOp::Equal { old_index, new_index, len } = op {
            for k in 0..len {
                map[old_index + k] = Some(new_index + k);
            }
        }
    }
    map
}

fn shifted(range: &Range<usize>, shift: isize, growth: isize) -> Range<usize> {
    let start = (range.start as isize + shift) as usize;
    let end = (range.end as isize + shift + growth) as usize;
    start..end
}

/// A stretch of the base one side changed, and what that side has there instead.
#[derive(Debug, Clone)]
struct Hunk {
    base: Range<usize>,
    side: Range<usize>,
}

fn hunks(base: &[Block], side: &[Block]) -> Vec<Hunk> {
    let mut out: Vec<Hunk> = vec![];
    for op in similar::capture_diff_slices(similar::Algorithm::Myers, base, side) {
        let (tag, old, new) = op.as_tag_tuple();
        if tag == similar::DiffTag::Equal {
            continue;
        }
        match out.last_mut() {
            Some(h) if h.base.end == old.start && h.side.end == new.start => {
                h.base.end = old.end;
                h.side.end = new.end;
            }
            _ => out.push(Hunk { base: old, side: new }),
        }
    }
    out
}

/// Hunks of either side whose base stretches overlap, merged into one stretch.
#[derive(Debug, Clone)]
struct Cluster {
    base: Range<usize>,
    theirs: bool,
    yours: bool,
    /// How many blocks each side's hunks here added (or, negative, removed).
    theirs_growth: isize,
    yours_growth: isize,
}

fn clusters(theirs: &[Hunk], yours: &[Hunk]) -> Vec<Cluster> {
    let mut all: Vec<(&Hunk, bool)> = theirs.iter().map(|h| (h, true)).chain(yours.iter().map(|h| (h, false))).collect();
    all.sort_by_key(|(h, _)| (h.base.start, h.base.end));
    let mut out: Vec<Cluster> = vec![];
    for (hunk, is_theirs) in all {
        let growth = hunk.side.len() as isize - hunk.base.len() as isize;
        let joins = out.last().is_some_and(|c| blocks_overlap(&c.base, &hunk.base));
        if !joins {
            out.push(Cluster { base: hunk.base.clone(), theirs: false, yours: false, theirs_growth: 0, yours_growth: 0 });
        }
        let cluster = out.last_mut().expect("a cluster");
        cluster.base = cluster.base.start.min(hunk.base.start)..cluster.base.end.max(hunk.base.end);
        if is_theirs {
            cluster.theirs = true;
            cluster.theirs_growth += growth;
        } else {
            cluster.yours = true;
            cluster.yours_growth += growth;
        }
    }
    out
}

/// Whether two changes to stretches of blocks overlap. Blocks next to each other are separate: a
/// new block added beside a changed one, or two changes to neighbouring blocks, merge cleanly. Two
/// new blocks added at the same place belong together.
fn blocks_overlap(a: &Range<usize>, b: &Range<usize>) -> bool {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => a.start == b.start,
        (true, false) => b.start < a.start && a.start < b.end,
        (false, true) => a.start < b.start && b.start < a.end,
        (false, false) => a.start < b.end && b.start < a.end,
    }
}

/// A stretch of the base both sides changed.
fn resolve(base: &[Block], theirs: &[Block], yours: &[Block], theirs_at: Range<usize>, direct: &mut Vec<Block>, conflicts: &mut Vec<Conflict>) {
    if theirs == yours {
        // The same change on both sides: the doc already has it.
        direct.extend_from_slice(base);
        return;
    }
    if base.is_empty() {
        // Both added blocks at the same place: keep both, without the ones the doc already has.
        for op in similar::capture_diff_slices(similar::Algorithm::Myers, theirs, yours) {
            if let similar::DiffOp::Insert { new_index, new_len, .. } | similar::DiffOp::Replace { new_index, new_len, .. } = op {
                direct.extend_from_slice(&yours[new_index..new_index + new_len]);
            }
        }
        return;
    }
    if base.len() != theirs.len() || base.len() != yours.len() {
        // Blocks added or removed on top of the changes: the whole stretch is the conflict.
        direct.extend_from_slice(base);
        conflicts.push(Conflict { base: base.to_vec(), theirs: theirs.to_vec(), theirs_at, yours: yours.to_vec(), target: yours.to_vec() });
        return;
    }
    // Block by block; neighbouring conflicting blocks make one conflict.
    let mut open: Option<Conflict> = None;
    for (i, ((b, t), y)) in base.iter().zip(theirs).zip(yours).enumerate() {
        let outcome = if t == y || y == b {
            Outcome::Clean(b.clone())
        } else if t == b {
            Outcome::Clean(y.clone())
        } else {
            match merge_block(b, t, y) {
                // The doc already reads the way the incoming version wants it.
                Outcome::Conflict(target) if target == *t => Outcome::Clean(b.clone()),
                outcome => outcome,
            }
        };
        match outcome {
            Outcome::Clean(block) => {
                conflicts.extend(open.take());
                direct.push(block);
            }
            Outcome::Conflict(target) => {
                direct.push(b.clone());
                let at = theirs_at.start + i;
                match open.as_mut() {
                    Some(c) => {
                        c.base.push(b.clone());
                        c.theirs.push(t.clone());
                        c.theirs_at.end = at + 1;
                        c.yours.push(y.clone());
                        c.target.push(target);
                    }
                    None => {
                        open = Some(Conflict { base: vec![b.clone()], theirs: vec![t.clone()], theirs_at: at..at + 1, yours: vec![y.clone()], target: vec![target] });
                    }
                }
            }
        }
    }
    conflicts.extend(open);
}

enum Outcome {
    /// What `direct` gets for the block.
    Clean(Block),
    /// The block conflicts; the suggestion makes it this.
    Conflict(Block),
}

/// A block both sides changed, merged character by character in its Markdown.
fn merge_block(base: &Block, theirs: &Block, yours: &Block) -> Outcome {
    let same_kind = std::mem::discriminant(base) == std::mem::discriminant(theirs) && std::mem::discriminant(base) == std::mem::discriminant(yours);
    if !same_kind {
        return Outcome::Conflict(yours.clone());
    }
    let markdown = |block: &Block| to_markdown(&Doc { blocks: vec![block.clone()] });
    let base_md: Vec<char> = markdown(base).chars().collect();
    let base_text: String = base_md.iter().collect();
    let theirs_hunks = text_hunks(&base_text, &markdown(theirs));
    let yours_hunks = text_hunks(&base_text, &markdown(yours));

    let common = |h: &TextHunk| theirs_hunks.contains(h);
    let clashes = |h: &TextHunk, others: &[TextHunk]| others.iter().any(|o| o != h && text_touches(&h.base, &o.base));
    let clash = yours_hunks.iter().any(|h| !common(h) && clashes(h, &theirs_hunks));
    let parse_one = |text: &str| -> Option<Block> {
        let doc = from_markdown(text);
        match &doc.blocks[..] {
            [block] if std::mem::discriminant(block) == std::mem::discriminant(base) => Some(block.clone()),
            _ => None,
        }
    };
    if !clash {
        if !yours_hunks.iter().any(common) {
            // Separate changes: merged as they are.
            return Outcome::Clean(yours.clone());
        }
        // Some of the same changes on both sides: make the rest only.
        let rest: Vec<&TextHunk> = yours_hunks.iter().filter(|h| !common(h)).collect();
        return match parse_one(&apply(&base_md, &rest)) {
            Some(block) => Outcome::Clean(block),
            None => Outcome::Conflict(yours.clone()),
        };
    }
    // The target: every incoming change, and the doc's changes that don't clash with them.
    let mut chosen: Vec<&TextHunk> = yours_hunks.iter().collect();
    chosen.extend(theirs_hunks.iter().filter(|h| !yours_hunks.contains(h) && !clashes(h, &yours_hunks)));
    Outcome::Conflict(parse_one(&apply(&base_md, &chosen)).unwrap_or_else(|| yours.clone()))
}

/// A stretch of a block's Markdown one side changed (in characters), and what it put there.
#[derive(Debug, Clone, PartialEq)]
struct TextHunk {
    base: Range<usize>,
    text: String,
}

fn text_hunks(base: &str, side: &str) -> Vec<TextHunk> {
    let mut out: Vec<TextHunk> = vec![];
    let mut at = 0;
    let mut open: Option<TextHunk> = None;
    for chunk in dissimilar::diff(base, side) {
        match chunk {
            dissimilar::Chunk::Equal(s) => {
                out.extend(open.take());
                at += s.chars().count();
            }
            dissimilar::Chunk::Delete(s) => {
                let n = s.chars().count();
                let hunk = open.get_or_insert(TextHunk { base: at..at, text: String::new() });
                hunk.base.end = at + n;
                at += n;
            }
            dissimilar::Chunk::Insert(s) => {
                open.get_or_insert(TextHunk { base: at..at, text: String::new() }).text.push_str(s);
            }
        }
    }
    out.extend(open);
    out
}

/// Whether two changes to a block's text touch: they overlap, or an insertion is at the edge of (or
/// inside) the other change. Changes that touch can't both be made without guessing.
fn text_touches(a: &Range<usize>, b: &Range<usize>) -> bool {
    if a.is_empty() || b.is_empty() {
        a.start <= b.end && b.start <= a.end
    } else {
        a.start < b.end && b.start < a.end
    }
}

/// The base text with the hunks made (in base order; one that would overlap an earlier one is left
/// out).
fn apply(base: &[char], hunks: &[&TextHunk]) -> String {
    let mut sorted: Vec<&TextHunk> = hunks.to_vec();
    sorted.sort_by_key(|h| (h.base.start, h.base.end));
    let mut out = String::new();
    let mut at = 0;
    for hunk in sorted {
        if hunk.base.start < at {
            continue;
        }
        out.extend(&base[at..hunk.base.start]);
        out.push_str(&hunk.text);
        at = hunk.base.end;
    }
    out.extend(&base[at..]);
    out
}
