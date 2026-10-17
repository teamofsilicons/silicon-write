use write_doc::ydoc::{self, EditMode};
use write_doc::*;

fn ydoc_from(doc: &Doc, client: u64) -> yrs::Doc {
    let y = ydoc::new_ydoc(client);
    ydoc::with_txn(&y, |txn, frag| ydoc::write_all(txn, frag, doc));
    y
}

fn edit_markdown(y: &yrs::Doc, new_md: &str, mode: &EditMode) {
    let current = ydoc::read_doc(y);
    let base = from_markdown(&to_markdown(&current));
    let new = from_markdown(new_md);
    ydoc::with_txn(y, |txn, frag| ydoc::patch(txn, frag, &base, &new, mode));
}

fn suggest(id: &str) -> EditMode {
    EditMode { suggest: Some((id.into(), "author-x".into())) }
}

#[test]
fn a_direct_edit_keeps_a_pending_suggested_paragraph() {
    let y = ydoc_from(&from_markdown("First.\n\nSecond.\n"), 7);
    edit_markdown(&y, "First.\n\nNew one.\n\nSecond.\n", &suggest("s1"));
    assert_eq!(ydoc::read_doc(&y).suggestions().len(), 1);
    // Someone edits directly from the Markdown they read, which doesn't show the suggestion yet.
    let md = to_markdown(&ydoc::read_doc(&y));
    assert_eq!(md, "First.\n\nSecond.\n");
    edit_markdown(&y, "First!\n\nSecond.\n", &EditMode::default());
    let doc = ydoc::read_doc(&y);
    assert_eq!(doc.suggestions().len(), 1, "the pending suggestion survives: {doc:#?}");
    assert_eq!(to_markdown(&doc), "First!\n\nSecond.\n");
    assert_eq!(to_markdown(&doc.with_suggestions_accepted()), "First!\n\nNew one.\n\nSecond.\n");
}
