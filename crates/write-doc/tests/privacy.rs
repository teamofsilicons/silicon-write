//! Someone who may not read a doc's history (a viewer, a commenter, a public link) is given the doc
//! without the text of anything deleted, and later changes still reach them intact.

use write_doc::history::without_history;
use write_doc::ydoc::{self, EditMode};
use write_doc::*;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact, Update};

fn edit_markdown(y: &yrs::Doc, new_md: &str) {
    let current = ydoc::read_doc(y);
    let base = from_markdown(&to_markdown(&current));
    ydoc::with_txn(y, |txn, frag| ydoc::patch(txn, frag, &base, &from_markdown(new_md), &EditMode::default()));
}

fn full(y: &yrs::Doc) -> Vec<u8> {
    y.transact().encode_state_as_update_v1(&StateVector::default())
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[test]
fn deleted_text_isnt_given_to_readers_and_later_changes_still_land() {
    let live = ydoc::new_ydoc(1);
    ydoc::with_txn(&live, |txn, frag| ydoc::write_all(txn, frag, &from_markdown("Keep this.\n\nThe password is hunter2secret.\n\nAnd this.\n")));
    edit_markdown(&live, "Keep this.\n\nThe password is gone.\n\nAnd this.\n");
    edit_markdown(&live, "Keep this.\n\nAnd this.\n");
    assert!(contains(&full(&live), "hunter2secret"), "the live doc keeps its history");

    let reader = without_history(&full(&live)).unwrap();
    let given = reader.transact().encode_state_as_update_v1(&StateVector::default());
    assert!(!contains(&given, "hunter2secret"), "deleted text is not given out");
    assert!(!contains(&given, "password"), "nor any deleted paragraph");
    assert_eq!(to_markdown(&ydoc::read_doc(&reader)), "Keep this.\n\nAnd this.\n");

    // A reader's own editor (garbage collection on, as in the browser) takes it, and every later
    // change, typed right where the deleted text was, reaches it intact.
    let browser = yrs::Doc::new();
    browser.transact_mut().apply_update(Update::decode_v1(&given).unwrap()).unwrap();
    for next in ["Keep this, now.\n\nAnd this.\n", "Keep this, now.\n\nNew middle.\n\nAnd this.\n", "Keep this, now.\n\nNew middle, again.\n\nAnd this!\n"] {
        let before = live.transact().state_vector();
        edit_markdown(&live, next);
        let change = live.transact().encode_diff_v1(&before);
        browser.transact_mut().apply_update(Update::decode_v1(&change).unwrap()).unwrap();
        assert_eq!(to_markdown(&ydoc::read_doc(&browser)), next);
    }
    // And syncing again from what the browser has gives nothing more than the live doc's current text.
    let catch_up = without_history(&full(&live)).unwrap().transact().encode_diff_v1(&browser.transact().state_vector());
    browser.transact_mut().apply_update(Update::decode_v1(&catch_up).unwrap()).unwrap();
    assert_eq!(to_markdown(&ydoc::read_doc(&browser)), to_markdown(&ydoc::read_doc(&live)));
}
