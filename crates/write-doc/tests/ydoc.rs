use std::collections::HashSet;

use write_doc::history::{self, StoredUpdate};
use write_doc::ydoc::{self, EditMode};
use write_doc::*;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact, Update};

const SAMPLE: &str = "# Plan\n\nIntro with **bold** and [a link](https://x.test).\n\n- one\n- two\n  - nested\n\n- [ ] task\n- [x] done\n\n> quoted\n\n```js\nlet a = 1;\n```\n\n| h1 | h2 |\n| --- | --- |\n| a | b |\n\nMath $x^2$ and footnote[^1] and [[Other]].\n\n![pic](https://x.test/p.png)\n\n$$\ny=mx\n$$\n\n[[_TOC_]]\n\n[^1]: Note *text*.\n";

fn ydoc_from(doc: &Doc, client: u64) -> yrs::Doc {
    let y = ydoc::new_ydoc(client);
    ydoc::with_txn(&y, |txn, frag| ydoc::write_all(txn, frag, doc));
    y
}

fn full_update(y: &yrs::Doc) -> Vec<u8> {
    y.transact().encode_state_as_update_v1(&StateVector::default())
}

fn fork(y: &yrs::Doc, client: u64) -> yrs::Doc {
    let f = ydoc::new_ydoc(client);
    f.transact_mut().apply_update(Update::decode_v1(&full_update(y)).unwrap()).unwrap();
    f
}

fn edit_markdown(y: &yrs::Doc, new_md: &str, mode: &EditMode) {
    let current = ydoc::read_doc(y);
    let base = from_markdown(&to_markdown(&current));
    let new = from_markdown(new_md);
    ydoc::with_txn(y, |txn, frag| ydoc::patch(txn, frag, &base, &new, mode));
}

#[test]
fn write_read_roundtrip() {
    let doc = from_markdown(SAMPLE);
    let y = ydoc_from(&doc, 7);
    assert_eq!(ydoc::read_doc(&y), doc);
}

#[test]
fn patch_reaches_target_and_keeps_untouched_items() {
    let doc = from_markdown(SAMPLE);
    let y = ydoc_from(&doc, 7);
    let before_sv = y.transact().state_vector();
    let md = to_markdown(&doc);
    let new_md = md.replace("Intro with", "Introduction, with").replace("- two", "- two and a half");
    edit_markdown(&y, &new_md, &EditMode::default());
    assert_eq!(to_markdown(&ydoc::read_doc(&y)), new_md);
    // Only a handful of new structs: the edit didn't rewrite the doc.
    let y2 = ydoc::new_ydoc(9);
    let diff = y.transact().encode_diff_v1(&before_sv);
    y2.transact_mut().apply_update(Update::decode_v1(&full_update(&ydoc_from(&doc, 7))).unwrap()).unwrap();
    assert!(diff.len() < 200, "diff too big: {} bytes", diff.len());
}

#[test]
fn all_kinds_of_edits() {
    let base = from_markdown(SAMPLE);
    let targets = [
        "# Plan\n\nIntro only.\n",
        "Completely new text.\n\n## Heading two\n",
        &SAMPLE.replace("- one\n- two\n  - nested\n", "1. one\n2. two\n"),
        &SAMPLE.replace("| a | b |", "| a | **bee** |"),
        &SAMPLE.replace("- [ ] task", "- [x] task"),
        &SAMPLE.replace("```js\nlet a = 1;\n```", "```ts\nlet a: number = 2;\n```"),
        &SAMPLE.replace("Math $x^2$ and", "Maths $y^3$, then"),
        &SAMPLE.replace("> quoted", "> quoted\n>\n> more"),
        &SAMPLE.replace("# Plan", "### Plan"),
    ];
    for target in targets {
        let y = ydoc_from(&base, 3);
        edit_markdown(&y, target, &EditMode::default());
        let got = ydoc::read_doc(&y);
        assert_eq!(got, from_markdown(target), "target:\n{target}");
    }
}

#[test]
fn concurrent_edits_merge() {
    let doc = from_markdown("First paragraph here.\n\nSecond paragraph here.\n");
    let y = ydoc_from(&doc, 1);
    // A Carbon types in the first paragraph in their own copy...
    let carbon = fork(&y, 2);
    edit_markdown(&carbon, "First paragraph here, typed.\n\nSecond paragraph here.\n", &EditMode::default());
    // ...while a Silicon edits the second paragraph, from the same base.
    let silicon = fork(&y, 3);
    edit_markdown(&silicon, "First paragraph here.\n\nSecond paragraph, rewritten.\n", &EditMode::default());
    for other in [&carbon, &silicon] {
        let update = other.transact().encode_diff_v1(&y.transact().state_vector());
        y.transact_mut().apply_update(Update::decode_v1(&update).unwrap()).unwrap();
    }
    assert_eq!(
        to_markdown(&ydoc::read_doc(&y)),
        "First paragraph here, typed.\n\nSecond paragraph, rewritten.\n"
    );
}

#[test]
fn suggestions_accept_and_reject() {
    let doc = from_markdown("The quick brown fox.\n");
    for accept in [true, false] {
        let y = ydoc_from(&doc, 1);
        let mode = EditMode { suggest: Some(("s1".into(), "author-1".into())) };
        edit_markdown(&y, "The slow brown fox jumps.\n", &mode);
        let read = ydoc::read_doc(&y);
        // The text didn't change yet: Markdown shows the doc as it reads now.
        assert_eq!(to_markdown(&read), "The quick brown fox.\n");
        let critic = to_markdown_with(&read, &WriteOptions { suggestions: SuggestionView::Critic, ..Default::default() });
        assert!(critic.contains("{++") && critic.contains("{--"), "{critic}");
        assert_eq!(read.suggestions().len(), 1);
        ydoc::with_txn(&y, |txn, frag| assert!(ydoc::resolve_suggestion(txn, frag, "s1", accept)));
        let expected = if accept { "The slow brown fox jumps.\n" } else { "The quick brown fox.\n" };
        assert_eq!(to_markdown(&ydoc::read_doc(&y)), expected);
        assert!(ydoc::read_doc(&y).suggestions().is_empty());
    }
}

#[test]
fn suggested_new_paragraph_goes_when_rejected() {
    let doc = from_markdown("One.\n");
    let y = ydoc_from(&doc, 1);
    let mode = EditMode { suggest: Some(("s2".into(), "a".into())) };
    edit_markdown(&y, "One.\n\nTwo.\n", &mode);
    ydoc::with_txn(&y, |txn, frag| ydoc::resolve_suggestion(txn, frag, "s2", false));
    assert_eq!(ydoc::read_doc(&y), from_markdown("One.\n"));
}

/// Runs an edit on a copy of `y` and returns the update that edit's transaction made.
fn recorded(y: &yrs::Doc, client: u64, f: impl FnOnce(&yrs::Doc)) -> (yrs::Doc, Vec<u8>) {
    use std::sync::{Arc, Mutex};
    let copy = fork(y, client);
    let captured = Arc::new(Mutex::new(vec![]));
    let sink = captured.clone();
    copy.observe_update_v1("record", move |_: &yrs::TransactionMut, e: &yrs::UpdateEvent| {
        sink.lock().unwrap().push(e.update.clone())
    })
    .unwrap();
    f(&copy);
    let updates = captured.lock().unwrap().clone();
    assert_eq!(updates.len(), 1);
    copy.unobserve_update_v1("record").unwrap();
    (copy, updates.into_iter().next().unwrap())
}

#[test]
fn undo_one_author_keeps_others() {
    let empty = ydoc::new_ydoc(1);
    let (a, u1) = recorded(&empty, 10, |d| {
        ydoc::with_txn(d, |txn, frag| ydoc::write_all(txn, frag, &from_markdown("Alpha beta gamma.\n")))
    });
    let (b, u2) = recorded(&a, 20, |d| edit_markdown(d, "Alpha gamma delta.\n", &EditMode::default()));
    let (_c, u3) = recorded(&b, 30, |d| edit_markdown(d, "Alpha gamma delta. Done.\n", &EditMode::default()));
    let stored = vec![
        StoredUpdate { seq: 1, author: "A".into(), update: u1 },
        StoredUpdate { seq: 2, author: "B".into(), update: u2 },
        StoredUpdate { seq: 3, author: "C".into(), update: u3 },
    ];
    let undone = history::undo_author_since(&stored, "B", &HashSet::from([20u64]), 1).unwrap();
    assert_eq!(to_markdown(&undone), "Alpha beta gamma. Done.\n");
    assert_eq!(to_markdown(&history::doc_at(&stored, 2).unwrap()), "Alpha gamma delta.\n");
    assert_eq!(to_markdown(&history::doc_at(&stored, 3).unwrap()), "Alpha gamma delta. Done.\n");
}

#[test]
fn text_map_and_authorship() {
    let doc = from_markdown("Hello world.\n\nSecond.\n");
    let y = ydoc_from(&doc, 5);
    let frag = ydoc::fragment(&y);
    let txn = y.transact();
    let map = ydoc::text_map(&txn, &frag);
    assert_eq!(map.slice(0, map.text.len()), "Hello world.\nSecond.");
    drop(txn);
    let authors = ydoc::block_authors(&y);
    assert_eq!(authors, vec![vec![5], vec![5]]);
}
