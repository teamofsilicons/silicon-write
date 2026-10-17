use write_doc::{Block, Doc, Inline, Marks, Suggestion, SuggestionKind, from_markdown, ydoc};
use yrs::Transact;

fn proposal(kind: SuggestionKind) -> Suggestion {
    Suggestion {
        kind,
        id: "s_quote".into(),
        author: "writer".into(),
    }
}

fn paragraph(text: &str) -> Block {
    Block::Paragraph {
        content: vec![Inline::Text {
            text: text.into(),
            marks: Marks::default(),
        }],
    }
}

fn suggested(kind: SuggestionKind, block: Block) -> Block {
    Block::suggested(proposal(kind), block)
}

fn assert_projection(doc: &Doc, expected: &str, first_text: usize) -> Vec<(usize, usize)> {
    let y = ydoc::new_ydoc(1);
    ydoc::with_txn(&y, |txn, frag| ydoc::write_all(txn, frag, doc));
    let frag = ydoc::fragment(&y);
    let txn = y.transact();
    let map = ydoc::text_map(&txn, &frag);
    let (quoted, ranges) = ydoc::quote_map(&txn, &frag, &map);
    assert_eq!(String::from_utf16(&quoted).unwrap(), expected);
    assert_eq!(quoted.len(), ranges.len());
    assert_eq!(
        ranges[0].0, map.texts[first_text].0,
        "the quote starts in the retained original text, not its proposed copy"
    );
    for (unit, (from, to)) in quoted.iter().zip(&ranges) {
        assert_eq!(to - from, 1);
        let mapped = map.text[*from];
        assert!(
            mapped == *unit || mapped == 0xFFFC,
            "quoted unit {unit:#x} maps to {mapped:#x} at {from}"
        );
    }
    // The outer range is also usable as the service's Yjs comment anchor.
    let start = ydoc::position_at(&txn, &map, ranges[0].0, false).unwrap();
    let end = ydoc::position_at(&txn, &map, ranges.last().unwrap().1, true).unwrap();
    assert_eq!(
        ydoc::resolve_position(&txn, &map, &start),
        Some(ranges[0].0)
    );
    assert_eq!(
        ydoc::resolve_position(&txn, &map, &end),
        Some(ranges.last().unwrap().1)
    );
    ranges
}

#[test]
fn quote_map_keeps_the_delete_side_of_structural_replacements_once() {
    let doc = Doc {
        blocks: vec![
            suggested(SuggestionKind::Insert, paragraph("Hidden before.")),
            suggested(SuggestionKind::Delete, paragraph("Alpha 😀 beta.")),
            suggested(
                SuggestionKind::Insert,
                from_markdown("**Alpha 😀 beta.**").blocks.remove(0),
            ),
            paragraph("End."),
            suggested(SuggestionKind::Insert, paragraph("Hidden after.")),
        ],
    };
    assert_projection(&doc, "Alpha 😀 beta.\n\nEnd.", 1);
}

#[test]
fn quote_map_omits_nested_insertions_without_adding_separators_or_shifting_text() {
    let doc = Doc {
        blocks: vec![
            Block::Blockquote {
                blocks: vec![
                    suggested(SuggestionKind::Insert, paragraph("Hidden first.")),
                    suggested(SuggestionKind::Delete, paragraph("Nested 😀 text.")),
                    suggested(SuggestionKind::Insert, paragraph("Nested 😀 text.")),
                    paragraph("Tail."),
                    suggested(SuggestionKind::Insert, paragraph("Hidden last.")),
                ],
            },
            paragraph("End."),
        ],
    };
    assert_projection(&doc, "Nested 😀 text.\nTail.\n\nEnd.", 1);
}

#[test]
fn quote_map_retains_deleted_inline_atoms_and_maps_their_visible_words() {
    let mut content = vec![Inline::Text {
        text: "See ".into(),
        marks: Marks::default(),
    }];
    for kind in [SuggestionKind::Delete, SuggestionKind::Insert] {
        content.push(Inline::Suggested {
            suggestion: proposal(kind),
            inline: Box::new(Inline::DocLink {
                title: "Plan".into(),
                alias: Some("Plan 😀".into()),
            }),
        });
    }
    content.push(Inline::Text {
        text: " with ".into(),
        marks: Marks::default(),
    });
    for kind in [SuggestionKind::Delete, SuggestionKind::Insert] {
        content.push(Inline::Suggested {
            suggestion: proposal(kind),
            inline: Box::new(Inline::InlineMath {
                latex: "x²".into()
            }),
        });
    }
    content.push(Inline::Text {
        text: " today.".into(),
        marks: Marks::default(),
    });
    let ranges = assert_projection(
        &Doc {
            blocks: vec![Block::Paragraph { content }],
        },
        "See Plan 😀 with x² today.",
        0,
    );
    for range in &ranges[4..11] {
        assert_eq!(
            *range,
            (4, 5),
            "each UTF16 unit of the alias maps to the retained Delete atom"
        );
    }
}
