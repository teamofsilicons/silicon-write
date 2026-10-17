use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use write_doc::history::{self, StoredUpdate};
use write_doc::ydoc::{self, EditMode};
use write_doc::{from_markdown, to_markdown};
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact, Update};

struct History {
    y: yrs::Doc,
    updates: Vec<StoredUpdate>,
}

impl History {
    fn new(md: &str) -> Self {
        let mut h = Self {
            y: ydoc::new_ydoc(1),
            updates: vec![],
        };
        h.edit("owner", md);
        h
    }

    fn edit(&mut self, author: &str, md: &str) {
        let client = match author {
            "owner" => 10,
            "writer" => 20,
            _ => 30,
        };
        let y = ydoc::new_ydoc(client);
        y.transact_mut()
            .apply_update(
                Update::decode_v1(
                    &self
                        .y
                        .transact()
                        .encode_state_as_update_v1(&StateVector::default()),
                )
                .unwrap(),
            )
            .unwrap();
        let captured = Arc::new(Mutex::new(vec![]));
        let sink = captured.clone();
        y.observe_update_v1("capture", move |_, e| {
            sink.lock().unwrap().push(e.update.clone())
        })
        .unwrap();
        let current = ydoc::read_doc(&y);
        ydoc::with_txn(&y, |txn, frag| {
            ydoc::patch(
                txn,
                frag,
                &current,
                &from_markdown(md),
                &EditMode::default(),
            )
        });
        let updates = std::mem::take(&mut *captured.lock().unwrap());
        for update in updates {
            self.updates.push(StoredUpdate {
                seq: self.updates.len() as i64 + 1,
                author: author.to_owned(),
                update,
            });
        }
        y.unobserve_update_v1("capture").unwrap();
        self.y = y;
    }

    fn undo(&self, author: &str, since: i64) -> String {
        to_markdown(
            &history::undo_author_since(&self.updates, author, &HashSet::new(), since).unwrap(),
        )
    }
}

#[test]
fn undo_restores_attributes_and_keeps_later_attributes() {
    let cases = [
        ("## Heading\n", "### Heading\n"),
        (
            "![First](https://example.test/first.png)\n",
            "![Second](https://example.test/second.png)\n",
        ),
        ("```js\nx();\n```\n", "```ts\nx();\n```\n"),
        ("$$\nx+y\n$$\n", "$$\nx-y\n$$\n"),
        ("3. three\n4. four\n", "7. three\n8. four\n"),
        ("Owner **bold** words.\n", "Owner bold words.\n"),
    ];
    for (before, after) in cases {
        let mut h = History::new(before);
        h.edit("writer", after);
        assert_eq!(
            h.undo("writer", 1),
            to_markdown(&from_markdown(before)),
            "{before}"
        );
    }
    let mut h = History::new("## Heading\n");
    h.edit("writer", "### Heading\n");
    h.edit("friend", "#### Heading\n");
    assert_eq!(h.undo("writer", 1), "#### Heading\n");
}

#[test]
fn undo_keeps_words_inside_the_authors_new_paragraph() {
    let mut h = History::new("Owner text.\n");
    h.edit("writer", "Owner text.\n\nSilicon draft.\n");
    h.edit(
        "friend",
        "Owner text.\n\nSilicon draft. Friend's important addition.\n",
    );
    assert_eq!(
        h.undo("writer", 1),
        "Owner text.\n\n Friend's important addition.\n"
    );
}

#[test]
fn undo_keeps_edits_in_split_and_moved_paragraphs() {
    for (before, writer, friend) in [
        (
            "First half. Second half.\n",
            "First half.\n\nSecond half.\n",
            "First half.\n\nSecond half, with the friend's fix.\n",
        ),
        (
            "Para A.\n\nPara B.\n\nPara C.\n",
            "Para B.\n\nPara C.\n\nPara A.\n",
            "Para B.\n\nPara C.\n\nPara A, with the friend's fix.\n",
        ),
    ] {
        let mut h = History::new(before);
        h.edit("writer", writer);
        h.edit("friend", friend);
        let undone = h.undo("writer", 1);
        assert!(undone.contains("with the friend's fix"), "{undone}");
    }
}

#[test]
fn compare_and_restore_match_elements_not_neighbor_offsets() {
    let mut h = History::new("# Plan\n\nA1 alpha.\n\nB1 beta.\n\nC1 gamma.\n");
    h.edit("writer", "# Plan\n\nA1 alpha.\n\nC1 gamma.\n");
    h.edit("friend", "# Plan\n\nA1 alpha.\n\nC2 gamma changed.\n");
    let compared = history::compare::compare(&h.updates, 1, 3).unwrap();
    let changed: Vec<_> = compared
        .iter()
        .filter(|b| b.kind != history::compare::Kind::Same)
        .collect();
    assert_eq!(changed.len(), 2);
    assert_eq!(changed[0].kind, history::compare::Kind::Removed);
    assert_eq!(changed[0].by, ["writer"]);
    assert_eq!(changed[1].kind, history::compare::Kind::Changed);
    assert_eq!(changed[1].by, ["friend"]);
    let old_y = history::replay([h.updates[0].update.as_slice()]).unwrap();
    let old_frag = ydoc::fragment(&old_y);
    let (old, old_placed) = history::blocks::placed(&old_y.transact(), &old_frag);
    let current_frag = ydoc::fragment(&h.y);
    let (current, current_placed) = history::blocks::placed(&h.y.transact(), &current_frag);
    let changes = history::changes::Changes::new(&h.updates).unwrap();
    let restored = history::blocks::bring_back(
        &old,
        &old_placed,
        &current,
        &current_placed,
        2..=2,
        |a, b| changes.replaced(a, b),
    );
    assert_eq!(
        to_markdown(&restored),
        "# Plan\n\nA1 alpha.\n\nB1 beta.\n\nC2 gamma changed.\n"
    );
}

#[test]
fn undo_keeps_another_writers_picture_change_inside_a_new_block() {
    let mut h = History::new("Owner text.\n");
    h.edit(
        "writer",
        "Owner text.\n\n![Draft](https://example.test/draft.png)\n",
    );
    h.edit(
        "friend",
        "Owner text.\n\n![Final](https://example.test/final.png)\n",
    );
    let undone = h.undo("writer", 1);
    assert!(
        undone.contains("https://example.test/final.png"),
        "{undone}"
    );
    assert!(undone.contains("Final"), "{undone}");
}
