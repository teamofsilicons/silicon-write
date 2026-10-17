//! Two versions of a doc side by side (UNDERSTANDING.md, "Going back": "compare any two versions,
//! seeing what was added and removed, and by whom").
//!
//! Blocks are matched by the elements that hold them ([`super::blocks::align`]). Both versions are
//! compared as they read: a pending suggestion isn't text the doc has yet.
//!
//! - A block only the later version has was added by whoever made its element (and anyone who
//!   wrote in it since); one only the earlier version has was removed by whoever deleted its
//!   element, whatever happened to its text before.
//! - A changed block comes with its parts: every character either version reads, the same in
//!   both, added (by whoever wrote it) or removed (by whoever deleted it). Lists, tables and
//!   quotes keep their items, cells and paragraphs apart, with a line break between items and
//!   paragraphs and a tab between cells, as their plain text does.
//! - A change that isn't typed text (bold, a link, a heading's level, a checkbox, a code block's
//!   language) is credited to whoever made it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use yrs::types::{Change, Delta, Event};
use yrs::updates::decoder::Decode;
use yrs::{
    DeepObservable, ID, ReadTxn, Snapshot, Transact, Xml, XmlElementRef, XmlFragment, XmlOut,
    XmlTextRef,
};

use super::blocks::{self, Pair, Placed};
use super::changes::Changes;
use super::text::{self, Run, branch_id};
use super::{HistoryError, StoredUpdate, apply};
use crate::model::Block;
use crate::model::names::*;
use crate::ydoc;

/// How a block changed between the two versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Same,
    Added,
    Removed,
    Changed,
}

/// What became of one part of a changed block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Same,
    Added,
    Removed,
}

/// A stretch of a changed block's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub op: Op,
    pub text: String,
    /// Who wrote it (added) or deleted it (removed), by account uuid.
    pub by: Option<String>,
}

/// One top-level block in the comparison.
#[derive(Debug, Clone, PartialEq)]
pub struct Compared {
    pub kind: Kind,
    /// The block as the earlier version reads it.
    pub before: Option<Block>,
    /// The block as the later version reads it.
    pub after: Option<Block>,
    /// Where the block is among the earlier version's blocks (what a restore of some blocks names).
    pub before_index: Option<usize>,
    /// Where the block is among the later version's blocks.
    pub after_index: Option<usize>,
    /// Who changed it (account uuids), in the order they first show up.
    pub by: Vec<String>,
    /// For a changed block, its text part by part.
    pub parts: Vec<Part>,
}

/// Compares version `from` of a doc with the later version `to`. `updates` are the doc's stored
/// changes up to `to`, in order.
pub fn compare(
    updates: &[StoredUpdate],
    from: i64,
    to: i64,
) -> Result<Vec<Compared>, HistoryError> {
    let updates = &updates[..updates.iter().take_while(|u| u.seq <= to).count()];
    let changes = Changes::new(updates)?;
    let y = ydoc::new_ydoc(text::SCRATCH_CLIENT);
    let frag = ydoc::fragment(&y);
    let earlier = updates.iter().take_while(|u| u.seq <= from).count();
    {
        let mut txn = y.transact_mut();
        for u in &updates[..earlier] {
            let update = yrs::Update::decode_v1(&u.update)
                .map_err(|e| HistoryError::Decode(e.to_string()))?;
            txn.apply_update(update)
                .map_err(|e| HistoryError::Apply(e.to_string()))?;
        }
    }
    let (_, before) = {
        let txn = y.transact();
        let (doc, placed) = blocks::placed_elements(&txn, &frag);
        let trees: Vec<(Placed, Node)> = placed
            .into_iter()
            .map(|(p, el)| {
                let node = Node::of_element(&txn, &el);
                (p, node)
            })
            .collect();
        (doc, trees)
    };
    let from_snapshot = y.transact().snapshot();

    // The later changes one at a time, noting which elements each changed other than by typing.
    let touched: Arc<Mutex<HashMap<ID, Vec<usize>>>> = Arc::default();
    let current: Arc<Mutex<usize>> = Arc::default();
    {
        let (touched, current) = (touched.clone(), current.clone());
        frag.observe_deep("compare", move |txn, events| {
            let change = *current.lock().unwrap();
            let mut touched = touched.lock().unwrap();
            for event in events.iter() {
                let target: Option<XmlOut> = match event {
                    Event::XmlFragment(e) => {
                        let structure =
                            e.delta(txn).iter().any(|c| !matches!(c, Change::Retain(_)));
                        match e.target() {
                            XmlOut::Element(el) if structure || !e.keys(txn).is_empty() => {
                                Some(XmlOut::Element(el.clone()))
                            }
                            _ => None,
                        }
                    }
                    Event::XmlText(e) => {
                        let formatted = e
                            .delta(txn)
                            .iter()
                            .any(|d| matches!(d, Delta::Retain(_, Some(_))));
                        formatted.then(|| XmlOut::Text(e.target().clone()))
                    }
                    _ => None,
                };
                // The element changed and every element around it.
                let mut node = target;
                while let Some(n) = node {
                    let (id, parent) = match &n {
                        XmlOut::Element(el) => (branch_id(el), el.parent()),
                        XmlOut::Text(t) => (branch_id(t), t.parent()),
                        XmlOut::Fragment(_) => (None, None),
                    };
                    if let Some(id) = id {
                        let by = touched.entry(id).or_default();
                        if !by.contains(&change) {
                            by.push(change);
                        }
                    }
                    node = parent;
                }
            }
        });
    }
    for (k, u) in updates.iter().enumerate().skip(earlier) {
        *current.lock().unwrap() = k;
        apply(&y, &u.update)?;
    }
    frag.unobserve_deep("compare");
    let touched = std::mem::take(&mut *touched.lock().unwrap());

    let after: Vec<(Placed, Node)> = {
        let txn = y.transact();
        let (_, placed) = blocks::placed_elements(&txn, &frag);
        placed
            .into_iter()
            .map(|(p, el)| {
                let node = Node::of_element(&txn, &el);
                (p, node)
            })
            .collect()
    };
    let to_snapshot = y.transact().snapshot();
    let shown = Shown {
        either: text::either(&from_snapshot, &to_snapshot),
        from: from_snapshot,
        to: to_snapshot,
    };

    let before_placed: Vec<Placed> = before.iter().map(|(p, _)| p.clone()).collect();
    let after_placed: Vec<Placed> = after.iter().map(|(p, _)| p.clone()).collect();
    let pairs = blocks::align(&before_placed, &after_placed, |old, new| {
        changes.replaced(old, new)
    });

    let mut txn = y.transact_mut();
    let mut walk = Walk {
        txn: &mut txn,
        changes: &changes,
        touched: &touched,
        shown: &shown,
        parts: vec![],
    };
    let mut out = Vec::with_capacity(pairs.len());
    for pair in pairs {
        out.push(match pair {
            Pair::Same(i, j) => Compared {
                kind: Kind::Same,
                before: Some(before[i].0.reading.clone()),
                after: Some(after[j].0.reading.clone()),
                before_index: Some(before[i].0.index),
                after_index: Some(after[j].0.index),
                by: vec![],
                parts: vec![],
            },
            Pair::Removed(i) => {
                let (placed, _) = &before[i];
                Compared {
                    kind: Kind::Removed,
                    before: Some(placed.reading.clone()),
                    after: None,
                    before_index: Some(placed.index),
                    after_index: None,
                    by: changes
                        .deleted_by(&placed.id)
                        .map(str::to_owned)
                        .into_iter()
                        .collect(),
                    parts: vec![],
                }
            }
            Pair::Added(j) => {
                let (placed, node) = &after[j];
                let mut by = Authors::default();
                by.add(changes.author_of(&placed.id));
                walk.node(None, Some(node));
                by.add_parts(&walk.take());
                by.add_touched(&changes, touched.get(&placed.id));
                Compared {
                    kind: Kind::Added,
                    before: None,
                    after: Some(placed.reading.clone()),
                    before_index: None,
                    after_index: Some(placed.index),
                    by: by.0,
                    parts: vec![],
                }
            }
            Pair::Changed(i, j) => {
                let ((old, old_node), (new, new_node)) = (&before[i], &after[j]);
                let mut by = Authors::default();
                if old.id == new.id {
                    walk.node(Some(old_node), Some(new_node));
                } else {
                    // One change replaced the block with another: all of it went, all of the new one came.
                    by.add(changes.deleted_by(&old.id));
                    by.add(changes.author_of(&new.id));
                    walk.node(Some(old_node), None);
                    walk.node(None, Some(new_node));
                }
                let parts = walk.take();
                by.add_parts(&parts);
                by.add_touched(&changes, touched.get(&new.id));
                Compared {
                    kind: Kind::Changed,
                    before: Some(old.reading.clone()),
                    after: Some(new.reading.clone()),
                    before_index: Some(old.index),
                    after_index: Some(new.index),
                    by: by.0,
                    parts,
                }
            }
        });
    }
    Ok(out)
}

/// Who changed something, in the order they first show up.
#[derive(Default)]
struct Authors(Vec<String>);

impl Authors {
    fn add(&mut self, who: Option<&str>) {
        if let Some(who) = who
            && !self.0.iter().any(|a| a == who)
        {
            self.0.push(who.to_owned());
        }
    }

    fn add_parts(&mut self, parts: &[Part]) {
        for part in parts {
            self.add(part.by.as_deref());
        }
    }

    fn add_touched(&mut self, changes: &Changes, touched: Option<&Vec<usize>>) {
        for &change in touched.into_iter().flatten() {
            self.add(Some(&changes.list[change].author));
        }
    }
}

/// What each of the two versions shows, and what either shows.
struct Shown {
    from: Snapshot,
    to: Snapshot,
    either: Snapshot,
}

/// A node of a block's tree as one version has it.
#[derive(Clone)]
struct Node {
    id: Option<ID>,
    kind: NodeKind,
}

#[derive(Clone)]
enum NodeKind {
    Text(XmlTextRef),
    /// An inline node that isn't text (a hard break, maths, a footnote, a doc link), as its plain
    /// text reads.
    Atom(String),
    Element {
        tag: String,
        children: Vec<Node>,
    },
}

impl Node {
    fn of_element<T: ReadTxn>(txn: &T, el: &XmlElementRef) -> Node {
        let tag = el.tag().to_string();
        let attr = |key: &str| match el.get_attribute(txn, key) {
            Some(yrs::Out::Any(yrs::Any::String(s))) => s.to_string(),
            _ => String::new(),
        };
        let kind = match tag.as_str() {
            HARD_BREAK => NodeKind::Atom("\n".into()),
            INLINE_MATH => NodeKind::Atom(attr("latex")),
            DOC_LINK => NodeKind::Atom(attr("title")),
            FOOTNOTE => NodeKind::Atom(String::new()),
            _ => NodeKind::Element {
                children: el
                    .children(txn)
                    .filter_map(|child| match child {
                        XmlOut::Element(e) => Some(Node::of_element(txn, &e)),
                        XmlOut::Text(t) => Some(Node {
                            id: branch_id(&t),
                            kind: NodeKind::Text(t),
                        }),
                        XmlOut::Fragment(_) => None,
                    })
                    .collect(),
                tag,
            },
        };
        Node {
            id: branch_id(el),
            kind,
        }
    }

    fn is_block(&self) -> bool {
        matches!(self.kind, NodeKind::Element { .. })
    }

    /// What goes between this node and the block before it, in plain text.
    fn separator(&self) -> &'static str {
        match &self.kind {
            NodeKind::Element { tag, .. } if tag == TABLE_CELL || tag == TABLE_HEADER => "\t",
            _ => "\n",
        }
    }
}

/// Builds a changed block's parts.
struct Walk<'a, 'b> {
    txn: &'a mut yrs::TransactionMut<'b>,
    changes: &'a Changes,
    touched: &'a HashMap<ID, Vec<usize>>,
    shown: &'a Shown,
    parts: Vec<Part>,
}

impl Walk<'_, '_> {
    fn take(&mut self) -> Vec<Part> {
        std::mem::take(&mut self.parts)
    }

    fn push(&mut self, op: Op, text: &str, by: Option<&str>) {
        if text.is_empty() {
            return;
        }
        if let Some(last) = self.parts.last_mut()
            && last.op == op
            && last.by.as_deref() == by
        {
            last.text.push_str(text);
            return;
        }
        self.parts.push(Part {
            op,
            text: text.to_owned(),
            by: by.map(str::to_owned),
        });
    }

    /// One node, as the earlier version has it (`from`), the later one (`to`), or both (the same
    /// node).
    fn node(&mut self, from: Option<&Node>, to: Option<&Node>) {
        let Some(node) = from.or(to) else { return };
        match &node.kind {
            NodeKind::Text(text) => self.text(text),
            NodeKind::Atom(_) => self.atom(from, to),
            NodeKind::Element { .. } => {
                let children = |n: Option<&Node>| -> Vec<Node> {
                    match n.map(|n| &n.kind) {
                        Some(NodeKind::Element { children, .. }) => children.clone(),
                        _ => vec![],
                    }
                };
                let (a, b) = (children(from), children(to));
                self.children(&a, &b);
            }
        }
    }

    /// An element's children, matched by identity: those both versions have, in order, and
    /// between them those only the earlier one has, then those only the later one has.
    fn children(&mut self, from: &[Node], to: &[Node]) {
        let position: HashMap<ID, usize> = to
            .iter()
            .enumerate()
            .filter_map(|(j, n)| n.id.map(|id| (id, j)))
            .collect();
        let mut ordered: Vec<(Option<&Node>, Option<&Node>)> =
            Vec::with_capacity(from.len() + to.len());
        let mut removed: Vec<&Node> = vec![];
        let mut next = 0;
        for f in from {
            match f
                .id
                .and_then(|id| position.get(&id).copied())
                .filter(|&j| j >= next)
            {
                Some(j) => {
                    ordered.extend(removed.drain(..).map(|r| (Some(r), None)));
                    ordered.extend(to[next..j].iter().map(|t| (None, Some(t))));
                    ordered.push((Some(f), Some(&to[j])));
                    next = j + 1;
                }
                None => removed.push(f),
            }
        }
        ordered.extend(removed.into_iter().map(|r| (Some(r), None)));
        ordered.extend(to[next..].iter().map(|t| (None, Some(t))));

        // Blocks inside are kept apart as their plain text keeps them.
        let (mut seen_from, mut seen_to) = (false, false);
        let (mut last_removed, mut last_added): (Option<String>, Option<String>) = (None, None);
        for (f, t) in ordered {
            let node = f.or(t).expect("a node");
            if node.is_block() {
                let deleted_by = || {
                    node.id
                        .and_then(|id| self.changes.deleted_by(&id))
                        .map(str::to_owned)
                };
                let written_by = || {
                    node.id
                        .and_then(|id| self.changes.author_of(&id))
                        .map(str::to_owned)
                };
                match (f.is_some() && seen_from, t.is_some() && seen_to) {
                    (true, true) => self.push(Op::Same, node.separator(), None),
                    (true, false) => {
                        let by = if t.is_none() {
                            deleted_by()
                        } else {
                            last_removed.clone()
                        };
                        self.push(Op::Removed, node.separator(), by.as_deref());
                    }
                    (false, true) => {
                        let by = if f.is_none() {
                            written_by()
                        } else {
                            last_added.clone()
                        };
                        self.push(Op::Added, node.separator(), by.as_deref());
                    }
                    (false, false) => {}
                }
                match (f.is_some(), t.is_some()) {
                    (true, false) => last_removed = deleted_by(),
                    (false, true) => last_added = written_by(),
                    _ => {}
                }
            }
            self.node(f, t);
            seen_from |= f.is_some();
            seen_to |= t.is_some();
        }
    }

    /// An inline node that isn't text: the same, or what it read as before and after.
    fn atom(&mut self, from: Option<&Node>, to: Option<&Node>) {
        let read = |n: Option<&Node>| match n.map(|n| &n.kind) {
            Some(NodeKind::Atom(text)) => Some(text.clone()),
            _ => None,
        };
        let id = from.or(to).and_then(|n| n.id);
        match (read(from), read(to)) {
            (Some(a), Some(b)) if a == b => self.push(Op::Same, &a, None),
            (Some(a), Some(b)) => {
                // Changed in place (maths rewritten): by whoever last changed it.
                let by = id
                    .and_then(|id| self.touched.get(&id))
                    .and_then(|c| c.last())
                    .map(|&c| self.changes.list[c].author.clone());
                self.push(Op::Removed, &a, by.as_deref());
                self.push(Op::Added, &b, by.as_deref());
            }
            (Some(a), None) => {
                let by = id
                    .and_then(|id| self.changes.deleted_by(&id))
                    .map(str::to_owned);
                self.push(Op::Removed, &a, by.as_deref());
            }
            (None, Some(b)) => {
                let by = id
                    .and_then(|id| self.changes.author_of(&id))
                    .map(str::to_owned);
                self.push(Op::Added, &b, by.as_deref());
            }
            (None, None) => {}
        }
    }

    /// A text, character by character, as each version reads it.
    fn text(&mut self, text: &XmlTextRef) {
        let read = |runs: Vec<Run>| -> HashSet<ID> {
            runs.iter()
                .filter(|r| !r.is_pending_insertion())
                .flat_map(|r| r.chars().map(|(id, _)| id).collect::<Vec<_>>())
                .collect()
        };
        let in_from = read(text::runs(self.txn, text, &self.shown.from));
        let in_to = read(text::runs(self.txn, text, &self.shown.to));
        let all = text::runs(self.txn, text, &self.shown.either);
        let mut buf = String::new();
        let mut current: Option<(Op, Option<String>)> = None;
        for run in &all {
            for (id, ch) in run.chars() {
                let op = match (in_from.contains(&id), in_to.contains(&id)) {
                    (true, true) => Op::Same,
                    (true, false) => Op::Removed,
                    (false, true) => Op::Added,
                    (false, false) => continue,
                };
                let by = match op {
                    Op::Same => None,
                    Op::Added => self.changes.author_of(&id).map(str::to_owned),
                    Op::Removed => self.changes.deleted_by(&id).map(str::to_owned),
                };
                let key = (op, by);
                if current.as_ref() != Some(&key) {
                    if let Some((op, by)) = current.take() {
                        self.push(op, &buf, by.as_deref());
                    }
                    buf.clear();
                    current = Some(key);
                }
                buf.push(ch);
            }
        }
        if let Some((op, by)) = current {
            self.push(op, &buf, by.as_deref());
        }
    }
}
