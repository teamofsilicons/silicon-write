//! Editing a text block's content in place: the smallest change that makes it read as the new
//! content, keeping every character and inline node nobody changed.
//!
//! A block's characters and inline nodes are compared as one sequence ([`super::textdiff`]), so a
//! change to a footnote, a line break, maths or a doc link touches only that node, and the text
//! around it keeps every character that stayed: what someone typed there meanwhile, the comments
//! anchored there and who wrote what all stay. A node whose content changed (a footnote's note, a
//! formula, a link's title) keeps its place and gets the new content.
//!
//! The editor's Yjs binding keeps one XML text between two inline nodes. A node added inside a text
//! splits it: the side with more of the old characters keeps them, and the other side's characters
//! move to a new text next to it. Texts that end up next to each other (the node between them went)
//! join the first of them, as the editor joins them. An XML text is never removed, only emptied, so
//! what someone typed into it meanwhile still shows up when it arrives.

use std::collections::BTreeMap;

use yrs::types::Attrs;
use yrs::{ReadTxn, Text, TransactionMut, XmlElementPrelim, XmlElementRef, XmlFragment, XmlOut, XmlTextPrelim, XmlTextRef};

use super::textdiff::{self, Op, Sym};
use super::{TextOp, mark_change, marks_to_attrs, read_atom, text_runs, utf16_len, write_atom_attrs};
use crate::model::*;

/// A character as it is in the live doc: where it is in its text (UTF-16), and its marks.
struct Visible {
    at: u32,
    ch: char,
    marks: Marks,
}

/// The visible characters of an XML text, and the text's whole length. Text suggested for
/// insertion isn't visible (the Markdown leaves it out), so a patch keeps it as it is.
fn visible(runs: &[(String, Marks)]) -> (Vec<Visible>, u32) {
    let mut out = vec![];
    let mut at = 0u32;
    for (text, marks) in runs {
        let hidden = matches!(&marks.suggestion, Some(s) if s.kind == SuggestionKind::Insert);
        for ch in text.chars() {
            if !hidden {
                out.push(Visible { at, ch, marks: marks.clone() });
            }
            at += ch.len_utf16() as u32;
        }
    }
    (out, at)
}

/// A child of a text block, as the patch sees it.
enum Child {
    Text { text: XmlTextRef, chars: Vec<Visible>, len: u32 },
    Node { el: XmlElementRef, inline: Inline },
    /// An element the doc model doesn't know: it stays where it is.
    Other { el: XmlElementRef },
}

fn children<T: ReadTxn>(txn: &T, el: &XmlElementRef) -> Vec<Child> {
    el.children(txn)
        .filter_map(|child| match child {
            XmlOut::Text(text) => {
                let (chars, len) = visible(&text_runs(txn, &text));
                Some(Child::Text { text, chars, len })
            }
            XmlOut::Element(e) => Some(match read_atom(txn, &e) {
                Some(Inline::Suggested { suggestion, .. }) if suggestion.kind == SuggestionKind::Insert => Child::Other { el: e },
                Some(inline) => Child::Node { el: e, inline },
                None => Child::Other { el: e },
            }),
            _ => None,
        })
        .collect()
}

fn node_sym(inline: &Inline) -> Sym {
    match inline {
        Inline::Suggested { inline, .. } => node_sym(inline),
        Inline::HardBreak => Sym::Break,
        Inline::Text { .. } => Sym::Node(0),
        Inline::InlineMath { .. } => Sym::Node(1),
        Inline::Footnote { .. } => Sym::Node(2),
        Inline::DocLink { .. } => Sym::Node(3),
        Inline::Image { .. } => Sym::Node(4),
    }
}

/// A unit of the new content.
enum Unit<'a> {
    Char(char, &'a Marks),
    Node(&'a Inline),
}

/// The new content, laid out: characters, inline nodes, and the elements the model doesn't know,
/// kept in place. `from` is the old unit a character or node stays (by index into the old units).
enum Item<'a> {
    Char { ch: char, marks: &'a Marks, from: Option<usize> },
    Node { inline: &'a Inline, from: Option<usize> },
    Keep { child: usize },
}

/// What a text block's children become, in order.
#[derive(Clone, Copy)]
enum Entry {
    /// A child that is there already (by index into the children).
    Old(usize),
    /// A new text for a stretch of the new content (by stretch).
    Text(usize),
    /// A new inline node (by item).
    Node(usize),
}

/// Edits a text block (`el`) so its content reads as `target`.
pub(super) fn patch(txn: &mut TransactionMut, el: &XmlElementRef, target: &[Inline]) {
    let children = children(txn, el);

    // The old content as one sequence: each text's visible characters and each inline node, as
    // (child, character in it).
    let mut old: Vec<(usize, Option<usize>)> = vec![];
    let mut old_syms: Vec<Sym> = vec![];
    for (c, child) in children.iter().enumerate() {
        match child {
            Child::Text { chars, .. } => {
                for (k, v) in chars.iter().enumerate() {
                    old.push((c, Some(k)));
                    old_syms.push(Sym::Char(v.ch));
                }
            }
            Child::Node { inline, .. } => {
                old.push((c, None));
                old_syms.push(node_sym(inline));
            }
            Child::Other { .. } => {}
        }
    }
    let mut new: Vec<Unit> = vec![];
    let mut new_syms: Vec<Sym> = vec![];
    for inline in target {
        match inline {
            Inline::Text { text, marks } => {
                for ch in text.chars() {
                    new.push(Unit::Char(ch, marks));
                    new_syms.push(Sym::Char(ch));
                }
            }
            node => {
                new.push(Unit::Node(node));
                new_syms.push(node_sym(node));
            }
        }
    }

    // Which old units stay, and as which new ones.
    let mut kept_as: Vec<Option<usize>> = vec![None; old.len()];
    let mut from: Vec<Option<usize>> = vec![None; new.len()];
    let (mut o, mut n) = (0, 0);
    for op in textdiff::diff(&old_syms, &new_syms) {
        match op {
            Op::Equal(k) => {
                for _ in 0..k {
                    kept_as[o] = Some(n);
                    from[n] = Some(o);
                    o += 1;
                    n += 1;
                }
            }
            Op::Delete(k) => o += k,
            Op::Insert(k) => n += k,
        }
    }

    // The new layout. An element the model doesn't know goes right after the last thing before it
    // that stays.
    let mut keeps: Vec<(usize, usize)> = vec![]; // (new position, child)
    {
        let mut after = 0;
        let mut unit = 0;
        for (c, child) in children.iter().enumerate() {
            let count = match child {
                Child::Text { chars, .. } => chars.len(),
                Child::Node { .. } => 1,
                Child::Other { .. } => {
                    keeps.push((after, c));
                    0
                }
            };
            for &kept in &kept_as[unit..unit + count] {
                if let Some(n) = kept {
                    after = n + 1;
                }
            }
            unit += count;
        }
    }
    let mut items: Vec<Item> = Vec::with_capacity(new.len() + keeps.len());
    let mut item_of_new: Vec<usize> = Vec::with_capacity(new.len());
    let mut item_of_keep: BTreeMap<usize, usize> = BTreeMap::new();
    let mut pending = keeps.iter().peekable();
    for (n, unit) in new.iter().enumerate() {
        while let Some(&&(at, child)) = pending.peek()
            && at <= n
        {
            item_of_keep.insert(child, items.len());
            items.push(Item::Keep { child });
            pending.next();
        }
        item_of_new.push(items.len());
        items.push(match *unit {
            Unit::Char(ch, marks) => Item::Char { ch, marks, from: from[n] },
            Unit::Node(inline) => Item::Node { inline, from: from[n] },
        });
    }
    for &(_, child) in pending {
        item_of_keep.insert(child, items.len());
        items.push(Item::Keep { child });
    }

    // The new content in stretches of text between nodes (and kept elements). A node's stretch is
    // the one after it.
    let mut stretches: Vec<Vec<usize>> = vec![vec![]];
    let mut separators: Vec<usize> = vec![];
    let mut stretch_of: Vec<usize> = vec![0; items.len()];
    for (i, item) in items.iter().enumerate() {
        if let Item::Char { .. } = item {
            stretches.last_mut().unwrap().push(i);
        } else {
            separators.push(i);
            stretches.push(vec![]);
        }
        stretch_of[i] = stretches.len() - 1;
    }

    // Which stretches each old text keeps characters in (and how many), or else where it would sit.
    let mut kept_in: Vec<BTreeMap<usize, usize>> = vec![BTreeMap::new(); children.len()];
    for (i, item) in items.iter().enumerate() {
        if let Item::Char { from: Some(u), .. } = item {
            *kept_in[old[*u].0].entry(stretch_of[i]).or_default() += 1;
        }
    }
    let mut place = vec![0usize; children.len()];
    {
        let mut anchor = 0;
        let mut unit = 0;
        for (c, child) in children.iter().enumerate() {
            place[c] = anchor;
            let count = match child {
                Child::Text { chars, .. } => chars.len(),
                Child::Node { .. } => 1,
                Child::Other { .. } => {
                    anchor = stretch_of[item_of_keep[&c]];
                    0
                }
            };
            for &kept in &kept_as[unit..unit + count] {
                if let Some(n) = kept {
                    anchor = stretch_of[item_of_new[n]];
                }
            }
            unit += count;
        }
    }
    let touches = |c: usize, j: usize| if kept_in[c].is_empty() { place[c] == j } else { kept_in[c].contains_key(&j) };
    // Where a text that splits keeps its characters: the side with more of them.
    let best = |c: usize| -> usize {
        let mut best: Option<(usize, usize)> = None;
        for (&j, &count) in &kept_in[c] {
            if best.is_none_or(|(_, most)| count > most) {
                best = Some((j, count));
            }
        }
        best.map_or(place[c], |(j, _)| j)
    };

    // Each stretch with text gets one XML text: the first old text there that is free, unless that
    // one keeps more of its characters in a later stretch; else a new one.
    let mut home: Vec<Option<usize>> = vec![None; stretches.len()];
    let mut home_of: Vec<Option<usize>> = vec![None; children.len()];
    for j in 0..stretches.len() {
        if stretches[j].is_empty() {
            continue;
        }
        let found = (0..children.len()).find(|&c| {
            matches!(children[c], Child::Text { .. })
                && home_of[c].is_none()
                && touches(c, j)
                && !(kept_in[c].len() > 1 && best(c) > j)
        });
        if let Some(c) = found {
            home[j] = Some(c);
            home_of[c] = Some(j);
        }
    }

    // Text: each old text keeps the characters its stretch keeps of it and takes in the rest;
    // characters that went, or moved to another text, go.
    for (c, child) in children.iter().enumerate() {
        let Child::Text { text, chars, len } = child else {
            continue;
        };
        let wanted: Vec<&Item> = match home_of[c] {
            Some(j) => stretches[j].iter().map(|&i| &items[i]).collect(),
            None => vec![],
        };
        let ops = script(c, chars, &wanted, &old);
        apply(txn, text, chars, *len, ops);
    }
    // Nodes that stay get their new content.
    for item in &items {
        if let Item::Node { inline, from: Some(u) } = item
            && let Child::Node { el: node, inline: was } = &children[old[*u].0]
            && was != *inline
        {
            write_atom_attrs(txn, node, inline);
        }
    }
    // Nodes that went.
    for (u, &(c, k)) in old.iter().enumerate() {
        if k.is_none()
            && kept_as[u].is_none()
            && let Child::Node { el: node, .. } = &children[c]
            && let Some(at) = index_of(txn, el, |x| matches!(x, XmlOut::Element(e) if e == node))
        {
            el.remove_range(txn, at, 1);
        }
    }

    // The children in their new order: what stays keeps its order; a new text goes right after
    // what comes before it, a new node right before what comes after it, so an emptied text never
    // ends up just before another text (the editor would join them, moving that text).
    let mut layout: Vec<Entry> = vec![];
    for (j, stretch) in stretches.iter().enumerate() {
        if !stretch.is_empty() {
            layout.push(match home[j] {
                Some(c) => Entry::Old(c),
                None => Entry::Text(j),
            });
        }
        if let Some(&i) = separators.get(j) {
            layout.push(match &items[i] {
                Item::Node { from: Some(u), .. } => Entry::Old(old[*u].0),
                Item::Node { from: None, .. } => Entry::Node(i),
                Item::Keep { child } => Entry::Old(*child),
                Item::Char { .. } => unreachable!("a separator isn't a character"),
            });
        }
    }
    let placed: Vec<bool> = {
        let mut placed = vec![false; children.len()];
        for entry in &layout {
            if let Entry::Old(c) = entry {
                placed[*c] = true;
            }
        }
        placed
    };
    let leftover = |c: usize| !placed[c] && matches!(children[c], Child::Text { .. });
    let mut order: Vec<Entry> = vec![];
    let mut next = 0;
    for (e, entry) in layout.iter().enumerate() {
        let until = match entry {
            Entry::Old(c) => Some(*c),
            Entry::Text(_) => None,
            Entry::Node(_) => Some(
                layout[e + 1..]
                    .iter()
                    .find_map(|later| if let Entry::Old(c) = later { Some(*c) } else { None })
                    .unwrap_or(children.len()),
            ),
        };
        if let Some(until) = until {
            order.extend((next..until).filter(|&c| leftover(c)).map(Entry::Old));
            next = next.max(until);
        }
        order.push(*entry);
        if let Entry::Old(c) = entry {
            next = next.max(c + 1);
        }
    }
    order.extend((next..children.len()).filter(|&c| leftover(c)).map(Entry::Old));

    let mut at = 0u32;
    for entry in order {
        match entry {
            Entry::Old(c) => {
                let found = match &children[c] {
                    Child::Text { text, .. } => index_of(txn, el, |x| matches!(x, XmlOut::Text(t) if t == text)),
                    Child::Node { el: e, .. } | Child::Other { el: e } => {
                        index_of(txn, el, |x| matches!(x, XmlOut::Element(other) if other == e))
                    }
                };
                if let Some(index) = found {
                    at = index + 1;
                }
            }
            Entry::Text(j) => {
                let text = el.insert(txn, at, XmlTextPrelim::new(""));
                let mut p = 0;
                for (s, marks) in runs(stretches[j].iter().map(|&i| &items[i])) {
                    text.insert_with_attributes(txn, p, &s, marks_to_attrs(&marks));
                    p += utf16_len(&s);
                }
                at += 1;
            }
            Entry::Node(i) => {
                if let Item::Node { inline, .. } = &items[i]
                    && let Some(name) = inline.atom_name()
                {
                    let node = el.insert(txn, at, XmlElementPrelim::empty(name));
                    write_atom_attrs(txn, &node, inline);
                    at += 1;
                }
            }
        }
    }
}

/// Edits one XML text so its visible content reads as `target`, changing only what changed.
pub(super) fn patch_text(txn: &mut TransactionMut, text: &XmlTextRef, old_runs: &[(String, Marks)], target: &[(String, Marks)]) {
    let (chars, len) = visible(old_runs);
    let old_syms: Vec<Sym> = chars.iter().map(|v| Sym::Char(v.ch)).collect();
    let mut new: Vec<(char, &Marks)> = vec![];
    for (s, marks) in target {
        for ch in s.chars() {
            new.push((ch, marks));
        }
    }
    let new_syms: Vec<Sym> = new.iter().map(|(ch, _)| Sym::Char(*ch)).collect();
    let mut items: Vec<Item> = Vec::with_capacity(new.len());
    let (mut o, mut n) = (0, 0);
    for op in textdiff::diff(&old_syms, &new_syms) {
        match op {
            Op::Equal(k) => {
                for _ in 0..k {
                    items.push(Item::Char { ch: new[n].0, marks: new[n].1, from: Some(o) });
                    o += 1;
                    n += 1;
                }
            }
            Op::Delete(k) => o += k,
            Op::Insert(k) => {
                for _ in 0..k {
                    items.push(Item::Char { ch: new[n].0, marks: new[n].1, from: None });
                    n += 1;
                }
            }
        }
    }
    let old: Vec<(usize, Option<usize>)> = (0..chars.len()).map(|k| (0, Some(k))).collect();
    let wanted: Vec<&Item> = items.iter().collect();
    let ops = script(0, &chars, &wanted, &old);
    apply(txn, text, &chars, len, ops);
}

/// Text runs for new characters, joined where their marks are the same.
fn runs<'a, 'b: 'a>(items: impl IntoIterator<Item = &'a Item<'b>>) -> Vec<(String, Marks)> {
    let mut out: Vec<(String, Marks)> = vec![];
    for item in items {
        if let Item::Char { ch, marks, .. } = *item {
            match out.last_mut() {
                Some((s, m)) if m == marks => s.push(ch),
                _ => out.push((ch.to_string(), marks.clone())),
            }
        }
    }
    out
}

/// The edits that make text `c` (its visible characters `chars`) read as `wanted`: the characters
/// `wanted` keeps of it stay (with their new formatting), the others go, and everything else in
/// `wanted` comes in where it belongs.
fn script(c: usize, chars: &[Visible], wanted: &[&Item], old: &[(usize, Option<usize>)]) -> Vec<TextOp> {
    let mut ops = vec![];
    let mut next = 0;
    let mut incoming: Vec<&Item> = vec![];
    let mut format: Option<(usize, usize, Attrs)> = None;
    let flush = |ops: &mut Vec<TextOp>, format: &mut Option<(usize, usize, Attrs)>| {
        if let Some((from, to, attrs)) = format.take() {
            ops.push(TextOp::Format { from, to, attrs });
        }
    };
    for &item in wanted {
        let Item::Char { marks, from, .. } = *item else {
            continue;
        };
        let own = from.map(|u| old[u]).and_then(|(child, k)| if child == c { k } else { None });
        let Some(k) = own else {
            incoming.push(item);
            continue;
        };
        if k > next || !incoming.is_empty() {
            flush(&mut ops, &mut format);
        }
        if k > next {
            ops.push(TextOp::Delete { from: next, to: k });
        }
        if !incoming.is_empty() {
            ops.push(TextOp::Insert { at: k, runs: runs(incoming.drain(..)) });
        }
        let change = mark_change(&chars[k].marks, marks);
        match &mut format {
            Some((_, to, attrs)) if *to == k && *attrs == change => *to = k + 1,
            _ => {
                flush(&mut ops, &mut format);
                if !change.is_empty() {
                    format = Some((k, k + 1, change));
                }
            }
        }
        next = k + 1;
    }
    flush(&mut ops, &mut format);
    if next < chars.len() {
        ops.push(TextOp::Delete { from: next, to: chars.len() });
    }
    if !incoming.is_empty() {
        ops.push(TextOp::Insert { at: chars.len(), runs: runs(incoming) });
    }
    ops
}

/// Applies edits (in visible characters) to an XML text, from its end so earlier positions hold.
fn apply(txn: &mut TransactionMut, text: &XmlTextRef, chars: &[Visible], len: u32, ops: Vec<TextOp>) {
    let y_at = |v: usize| chars.get(v).map_or(len, |c| c.at);
    // The live stretches (start, length) of visible characters `from..to`: text suggested for
    // insertion between them stays.
    let stretches = |from: usize, to: usize| {
        let mut out: Vec<(u32, u32)> = vec![];
        for v in &chars[from..to] {
            let n = v.ch.len_utf16() as u32;
            match out.last_mut() {
                Some((start, l)) if *start + *l == v.at => *l += n,
                _ => out.push((v.at, n)),
            }
        }
        out
    };
    for op in ops.into_iter().rev() {
        match op {
            TextOp::Delete { from, to } => {
                for (start, n) in stretches(from, to).into_iter().rev() {
                    text.remove_range(txn, start, n);
                }
            }
            TextOp::Insert { at, runs } => {
                let mut p = y_at(at);
                for (s, marks) in runs {
                    text.insert_with_attributes(txn, p, &s, marks_to_attrs(&marks));
                    p += utf16_len(&s);
                }
            }
            TextOp::Format { from, to, attrs } => {
                for (start, n) in stretches(from, to).into_iter().rev() {
                    text.format(txn, start, n, attrs.clone());
                }
            }
        }
    }
}

/// Where a child is among an element's children now.
fn index_of<T: ReadTxn>(txn: &T, el: &XmlElementRef, is: impl Fn(&XmlOut) -> bool) -> Option<u32> {
    el.children(txn).position(|child| is(&child)).map(|i| i as u32)
}
