use write_doc::ydoc::{self, EditMode};
use write_doc::*;

fn proposed(before: &str, after: &str) -> yrs::Doc {
    let y = ydoc::new_ydoc(90);
    ydoc::with_txn(&y, |txn, frag| {
        ydoc::write_all(txn, frag, &from_markdown(before))
    });
    let mode = EditMode {
        suggest: Some(("s_proposal".into(), "author".into())),
    };
    ydoc::with_txn(&y, |txn, frag| {
        ydoc::patch(
            txn,
            frag,
            &from_markdown(before),
            &from_markdown(after),
            &mode,
        )
    });
    y
}

#[test]
fn every_structural_change_is_pending_and_can_be_decided_both_ways() {
    let cases = [
        (
            "code text",
            "```js\nlet a = 1;\n```\n",
            "```js\nlet b = 2;\n```\n",
        ),
        ("code language", "```js\nx\n```\n", "```python\nx\n```\n"),
        (
            "image insert",
            "Intro.\n",
            "Intro.\n\n![x](https://example.test/a.png)\n",
        ),
        (
            "image delete",
            "Intro.\n\n![x](https://example.test/a.png)\n",
            "Intro.\n",
        ),
        ("rule insert", "Intro.\n", "Intro.\n\n---\n"),
        ("math insert", "Intro.\n", "Intro.\n\n$$\nx^2\n$$\n"),
        ("math delete", "Intro.\n\n$$\nx^2\n$$\n", "Intro.\n"),
        ("math replace", "Area $x^2$ here.\n", "Area $y^2$ here.\n"),
        (
            "footnote",
            "A claim.[^1]\n\n[^1]: Old note.\n",
            "A claim.[^1]\n\n[^1]: New note.\n",
        ),
        (
            "doc link",
            "See [[Plan A]] first.\n",
            "See [[Plan B]] first.\n",
        ),
        (
            "linked image",
            "Before [![x](a.png)](https://example.test) after.\n",
            "Before [![y](b.png)](https://example.test) after.\n",
        ),
        ("list add", "- one\n- two\n", "- one\n- two\n- three\n"),
        ("list remove", "- one\n- two\n- three\n", "- one\n- three\n"),
        ("checkbox", "- [ ] todo\n", "- [x] todo\n"),
        (
            "row add",
            "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
            "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n",
        ),
        (
            "paragraph add",
            "First.\n\nLast.\n",
            "First.\n\nNew.\n\nLast.\n",
        ),
        ("formatting", "A plain word.\n", "A **plain** word.\n"),
    ];
    for (label, before, after) in cases {
        for accept in [false, true] {
            let y = proposed(before, after);
            let read = ydoc::read_doc(&y);
            assert_eq!(
                to_markdown(&read),
                to_markdown(&from_markdown(before)),
                "{label}: pending current view"
            );
            assert_eq!(read.suggestions().len(), 1, "{label}: registered proposal");
            let critic = to_markdown_with(
                &read,
                &WriteOptions {
                    suggestions: SuggestionView::Critic,
                    ..Default::default()
                },
            );
            assert!(
                critic.contains("{++") || critic.contains("{--"),
                "{label}: critic view {critic}"
            );
            assert_eq!(
                decide_critic(&critic, false),
                to_markdown(&from_markdown(before)),
                "{label}: reject CriticMarkup"
            );
            assert_eq!(
                decide_critic(&critic, true),
                to_markdown(&from_markdown(after)),
                "{label}: accept CriticMarkup"
            );
            ydoc::with_txn(&y, |txn, frag| {
                assert!(
                    ydoc::resolve_suggestion(txn, frag, "s_proposal", accept),
                    "{label}"
                )
            });
            let read = ydoc::read_doc(&y);
            assert!(read.suggestions().is_empty(), "{label}: resolved");
            assert_eq!(
                to_markdown(&read),
                to_markdown(&from_markdown(if accept { after } else { before })),
                "{label}: accept={accept}"
            );
        }
    }
}

#[test]
fn a_later_overlapping_suggestion_keeps_the_first_author() {
    let before = "This is a very good plan.\n";
    let y = proposed(before, "This is a good plan.\n");
    let mode = EditMode {
        suggest: Some(("s_other".into(), "other".into())),
    };
    ydoc::with_txn(&y, |txn, frag| {
        ydoc::patch(
            txn,
            frag,
            &from_markdown(before),
            &from_markdown("This is an excellent plan.\n"),
            &mode,
        )
    });
    let read = ydoc::read_doc(&y);
    assert_eq!(to_markdown(&read), before);
    let summaries = read.suggestions();
    assert!(
        summaries
            .iter()
            .any(|s| s.id == "s_proposal" && s.author == "author")
    );
    assert!(
        summaries
            .iter()
            .any(|s| s.id == "s_other" && s.author == "other")
    );
}

#[test]
fn editing_a_list_keeps_its_pending_item() {
    let before = "- one\n- two\n";
    let y = proposed(before, "- hidden\n- one\n- two\n");
    ydoc::with_txn(&y, |txn, frag| {
        ydoc::patch(
            txn,
            frag,
            &from_markdown(before),
            &from_markdown("- one changed\n- two\n"),
            &EditMode::default(),
        )
    });
    assert_eq!(to_markdown(&ydoc::read_doc(&y)), "- one changed\n- two\n");
    assert_eq!(ydoc::read_doc(&y).suggestions().len(), 1);
    ydoc::with_txn(&y, |txn, frag| {
        assert!(ydoc::resolve_suggestion(txn, frag, "s_proposal", true))
    });
    assert_eq!(
        to_markdown(&ydoc::read_doc(&y)),
        "- hidden\n- one changed\n- two\n"
    );
}

fn decide_critic(input: &str, accept: bool) -> String {
    let mut out = String::new();
    let mut rest = input;
    while let Some(pos) = rest.find("{++").into_iter().chain(rest.find("{--")).min() {
        out.push_str(&rest[..pos]);
        let insert = rest[pos..].starts_with("{++");
        let content = &rest[pos + 3..];
        let end = content.find(if insert { "++}" } else { "--}" }).unwrap();
        if insert == accept {
            out.push_str(&content[..end]);
        }
        rest = &content[end + 3..];
    }
    out.push_str(rest);
    out
}

#[test]
fn deciding_a_parent_never_silently_erases_another_pending_proposal() {
    for accept in [false, true] {
        let inner = Suggestion {
            id: "s_inner".into(),
            author: "other".into(),
            kind: SuggestionKind::Insert,
        };
        let outer = Suggestion {
            id: "s_outer".into(),
            author: "author".into(),
            kind: if accept {
                SuggestionKind::Delete
            } else {
                SuggestionKind::Insert
            },
        };
        let doc = Doc::new(vec![Block::Suggested {
            suggestion: outer,
            block: Box::new(Block::paragraph(vec![Inline::Text {
                text: "pending".into(),
                marks: Marks {
                    suggestion: Some(inner),
                    ..Default::default()
                },
            }])),
        }]);
        let y = ydoc::new_ydoc(123);
        ydoc::with_txn(&y, |txn, frag| ydoc::write_all(txn, frag, &doc));
        let before = ydoc::read_doc(&y);
        ydoc::with_txn(&y, |txn, frag| {
            assert_eq!(
                ydoc::resolution_conflicts(txn, frag, "s_outer", accept),
                ["s_inner"]
            );
            assert!(!ydoc::resolve_suggestion(txn, frag, "s_outer", accept));
        });
        assert_eq!(ydoc::read_doc(&y), before);
        ydoc::with_txn(&y, |txn, frag| {
            assert!(ydoc::resolve_suggestion(txn, frag, "s_inner", true));
            assert!(ydoc::resolve_suggestion(txn, frag, "s_outer", accept));
        });
        assert!(ydoc::read_doc(&y).suggestions().is_empty());
    }
}

#[test]
fn row_cell_and_paragraph_proposals_keep_their_distinct_ids_in_snapshots() {
    let wrap = |id: &str, block| Block::Suggested {
        suggestion: Suggestion {
            id: id.into(),
            author: id.into(),
            kind: SuggestionKind::Insert,
        },
        block: Box::new(block),
    };
    let doc = Doc::new(vec![Block::Table {
        rows: vec![TableRow {
            cells: vec![TableCell {
                header: false,
                align: None,
                colspan: 1,
                rowspan: 1,
                blocks: vec![wrap(
                    "s_row",
                    wrap(
                        "s_cell",
                        wrap("s_para", Block::paragraph(vec![Inline::text("pending")])),
                    ),
                )],
            }],
        }],
    }]);
    let json = prosemirror::to_json(&doc);
    let row = &json["content"][0]["content"][0];
    assert_eq!(row["attrs"]["suggestion"]["id"], "s_row");
    let cell = &row["content"][0];
    assert_eq!(cell["attrs"]["suggestion"]["id"], "s_cell");
    assert_eq!(cell["content"][0]["attrs"]["suggestion"]["id"], "s_para");
    let y = ydoc::new_ydoc(321);
    ydoc::with_txn(&y, |txn, frag| ydoc::write_all(txn, frag, &doc));
    assert_eq!(ydoc::read_doc(&y), doc);
    assert_eq!(ydoc::read_doc(&y).suggestions().len(), 3);
}
