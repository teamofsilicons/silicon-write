use super::{B64, Range, capture, recover, recover_section, resolve};
use base64::Engine;
use std::collections::HashSet;
use write_doc::history::StoredUpdate;
use write_doc::{Block, Doc, Inline, Marks, Suggestion, SuggestionKind, ydoc};
use yrs::{
    ReadTxn, Text, Transact, TransactionMut, XmlElementPrelim, XmlFragment, XmlFragmentRef, XmlOut,
    XmlTextPrelim,
};

const ORIGINAL: &str = "The commenter reads this line.";

struct History {
    y: yrs::Doc,
    updates: Vec<StoredUpdate>,
}

impl History {
    fn new(text: &str) -> Self {
        let mut history = Self {
            y: ydoc::new_ydoc(71),
            updates: vec![],
        };
        history.reconstruct(vec![paragraph(text)]);
        history
    }

    fn change(&mut self, edit: impl FnOnce(&mut TransactionMut, &XmlFragmentRef)) {
        let before = self.y.transact().state_vector();
        ydoc::with_txn(&self.y, edit);
        let update = self.y.transact().encode_diff_v1(&before);
        self.updates.push(StoredUpdate {
            seq: self.updates.len() as i64 + 1,
            author: "reviewer".into(),
            update,
        });
    }

    // Tiptap's structural proposal reconstructs both the current and proposed nodes. A
    // patch which preserved the old node would miss the identity-loss regression.
    fn reconstruct(&mut self, blocks: Vec<Block>) {
        self.change(|txn, fragment| ydoc::write_all(txn, fragment, &Doc { blocks }));
    }

    fn decide(&mut self, id: &str, accept: bool) {
        self.change(|txn, fragment| assert!(ydoc::resolve_suggestion(txn, fragment, id, accept)));
    }

    fn anchor(&self, quote: &str) -> Vec<Range> {
        let fragment = ydoc::fragment(&self.y);
        let txn = self.y.transact();
        let map = ydoc::text_map(&txn, &fragment);
        let text = String::from_utf16_lossy(&map.text);
        let byte = text.find(quote).expect("fixture contains the quote");
        let from = text[..byte].encode_utf16().count();
        let to = from + quote.encode_utf16().count();
        let ranges = capture(&txn, &map, from, to);
        assert!(!ranges.is_empty());
        ranges
    }

    fn current_quote(&self, original: &[Range]) -> Option<String> {
        // Always recover from the original anchor, just as a cache miss does in locate().
        let ranges = recover(&self.updates, &HashSet::new(), 1, original).unwrap();
        let fragment = ydoc::fragment(&self.y);
        let txn = self.y.transact();
        let map = ydoc::text_map(&txn, &fragment);
        let positions: Vec<_> = ranges
            .iter()
            .filter_map(|range| resolve(&txn, &map, range))
            .collect();
        let from = positions.iter().map(|&(from, _)| from).min()?;
        let to = positions.iter().map(|&(_, to)| to).max()?;
        Some(map.slice(from, to))
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

fn proposed(id: &str, kind: SuggestionKind, block: Block) -> Block {
    Block::suggested(
        Suggestion {
            id: id.into(),
            author: "commenter".into(),
            kind,
        },
        block,
    )
}

fn bold_proposal() -> Vec<Block> {
    let bold = Block::Paragraph {
        content: vec![
            Inline::Text {
                text: "The ".into(),
                marks: Marks::default(),
            },
            Inline::Text {
                text: "commenter".into(),
                marks: Marks {
                    bold: true,
                    ..Marks::default()
                },
            },
            Inline::Text {
                text: " reads this line.".into(),
                marks: Marks::default(),
            },
        ],
    };
    vec![
        proposed("s_bold", SuggestionKind::Delete, paragraph(ORIGINAL)),
        proposed("s_bold", SuggestionKind::Insert, bold),
    ]
}

#[test]
fn reconstructed_format_proposal_follows_current_text_then_either_decision() {
    for accept in [false, true] {
        let mut history = History::new(ORIGINAL);
        let anchor = history.anchor("reads this line");
        history.reconstruct(bold_proposal());
        assert_eq!(
            history.current_quote(&anchor).as_deref(),
            Some("reads this line"),
            "pending Bold must choose the current copy, not become ambiguous"
        );
        history.decide("s_bold", accept);
        assert_eq!(
            history.current_quote(&anchor).as_deref(),
            Some("reads this line"),
            "Bold accept={accept} must follow the retained node even though it was inserted earlier"
        );
    }
}

#[test]
fn rejected_bold_then_accepted_split_preserves_quotes_on_both_sides_of_the_boundary() {
    let mut history = History::new(ORIGINAL);
    let tail = history.anchor("reads this line");
    let crossing = history.anchor("commenter reads this");
    history.reconstruct(bold_proposal());
    history.decide("s_bold", false);
    assert_eq!(
        history.current_quote(&tail).as_deref(),
        Some("reads this line")
    );
    assert_eq!(
        history.current_quote(&crossing).as_deref(),
        Some("commenter reads this")
    );

    history.reconstruct(vec![
        proposed("s_split", SuggestionKind::Delete, paragraph(ORIGINAL)),
        proposed(
            "s_split",
            SuggestionKind::Insert,
            paragraph("The commenter"),
        ),
        proposed(
            "s_split",
            SuggestionKind::Insert,
            paragraph(" reads this line."),
        ),
    ]);
    assert_eq!(
        history.current_quote(&crossing).as_deref(),
        Some("commenter reads this")
    );
    history.decide("s_split", true);
    assert_eq!(
        history.current_quote(&tail).as_deref(),
        Some("reads this line")
    );
    assert_eq!(
        history.current_quote(&crossing).as_deref(),
        Some("commenter\n reads this"),
        "the recovered selection spans both retained paragraphs, including their new boundary"
    );
}

#[test]
fn an_unrelated_later_copy_in_the_same_gap_does_not_revive_a_deleted_quote() {
    let mut history = History::new(ORIGINAL);
    let anchor = history.anchor("reads this line");
    history.change(|txn, fragment| fragment.remove_range(txn, 0, 1));
    assert_eq!(history.current_quote(&anchor), None);
    // Same complete block, same gap, but inserted in a later ordinary update. It is
    // neither the causal replacement nor a restore, even though every word matches.
    history.change(|txn, fragment| {
        let paragraph = fragment.insert(txn, 0, XmlElementPrelim::empty("paragraph"));
        paragraph.insert(txn, 0, XmlTextPrelim::new(ORIGINAL));
    });
    assert_eq!(history.current_quote(&anchor), None);
}

#[test]
fn accepting_a_different_proposal_does_not_move_the_anchor_to_its_identical_words() {
    let mut history = History::new(ORIGINAL);
    let anchor = history.anchor("reads this line");
    history.reconstruct(vec![proposed(
        "s_remove",
        SuggestionKind::Delete,
        paragraph(ORIGINAL),
    )]);
    let before = ydoc::read_doc(&history.y);
    let mut after = before.clone();
    after.blocks.push(proposed(
        "s_other",
        SuggestionKind::Insert,
        paragraph(ORIGINAL),
    ));
    history.change(|txn, fragment| {
        ydoc::patch(txn, fragment, &before, &after, &ydoc::EditMode::default())
    });
    assert_eq!(
        history.current_quote(&anchor).as_deref(),
        Some("reads this line")
    );
    history.decide("s_remove", true);
    history.decide("s_other", true);
    assert_eq!(
        history.current_quote(&anchor),
        None,
        "equal text in a different suggestion is not a replacement"
    );
}

#[test]
fn a_later_structural_accept_cannot_reuse_offsets_of_text_already_deleted_in_place() {
    let mut history = History::new("Alpha target omega tail.");
    let anchor = history.anchor("target");
    let original_id = {
        let fragment = ydoc::fragment(&history.y);
        let txn = history.y.transact();
        fragment.get(&txn, 0).unwrap().id()
    };
    history.change(|txn, fragment| {
        let XmlOut::Element(paragraph) = fragment.get(txn, 0).unwrap() else {
            panic!("fixture paragraph");
        };
        let XmlOut::Text(text) = paragraph.get(txn, 0).unwrap() else {
            panic!("fixture text");
        };
        text.remove_range(txn, 6, 6);
    });
    assert_eq!(history.current_quote(&anchor), None);

    // Propose a heading without reconstructing the old paragraph. The orphaned
    // Source still names that paragraph ID, but its old offsets now cover " omega".
    let before = ydoc::read_doc(&history.y);
    let after = Doc {
        blocks: vec![Block::Heading {
            level: 2,
            content: vec![Inline::Text {
                text: "Alpha  omega tail.".into(),
                marks: Marks::default(),
            }],
        }],
    };
    let mode = ydoc::EditMode {
        suggest: Some(("s_heading".into(), "commenter".into())),
    };
    history.change(|txn, fragment| ydoc::patch(txn, fragment, &before, &after, &mode));
    {
        let fragment = ydoc::fragment(&history.y);
        let txn = history.y.transact();
        assert_eq!(fragment.get(&txn, 0).unwrap().id(), original_id);
    }
    assert_eq!(history.current_quote(&anchor), None);
    history.decide("s_heading", true);
    assert_eq!(
        history.current_quote(&anchor),
        None,
        "the accepted heading keeps the shortened text, not the deleted passage"
    );
}

fn section_block(history: &History, start: &str) -> Option<usize> {
    let current = recover_section(&history.updates, &HashSet::new(), 1, start).unwrap()?;
    let fragment = ydoc::fragment(&history.y);
    let txn = history.y.transact();
    let map = ydoc::text_map(&txn, &fragment);
    let at = ydoc::resolve_position(&txn, &map, &B64.decode(current).unwrap())?;
    map.block_at(at)
}

#[test]
fn section_points_follow_quote_wrapping_and_unwrapping_without_becoming_text_ranges() {
    let text = "A café 👩‍💻 stays in its section.";
    let mut history = History::new(text);
    let start = history.anchor(text)[0].start.clone();
    history.reconstruct(vec![Block::Blockquote {
        blocks: vec![paragraph(text)],
    }]);
    assert_eq!(section_block(&history, &start), Some(0));
    history.reconstruct(vec![paragraph(text)]);
    assert_eq!(section_block(&history, &start), Some(0));
}

#[test]
fn section_points_do_not_follow_later_copies_or_ambiguous_replacements() {
    let mut history = History::new(ORIGINAL);
    let start = history.anchor(ORIGINAL)[0].start.clone();
    history.change(|txn, fragment| fragment.remove_range(txn, 0, 1));
    history.reconstruct(vec![paragraph(ORIGINAL)]);
    assert_eq!(section_block(&history, &start), None);

    let mut history = History::new(ORIGINAL);
    let start = history.anchor(ORIGINAL)[0].start.clone();
    history.reconstruct(vec![paragraph(ORIGINAL), paragraph(ORIGINAL)]);
    assert_eq!(section_block(&history, &start), None);
}

#[test]
fn a_section_point_does_not_guess_between_two_accepted_split_sections() {
    let mut history = History::new(ORIGINAL);
    let start = history.anchor(ORIGINAL)[0].start.clone();
    history.reconstruct(vec![
        proposed("s_split", SuggestionKind::Delete, paragraph(ORIGINAL)),
        proposed(
            "s_split",
            SuggestionKind::Insert,
            paragraph("The commenter"),
        ),
        proposed(
            "s_split",
            SuggestionKind::Insert,
            paragraph(" reads this line."),
        ),
    ]);
    assert_eq!(section_block(&history, &start), Some(0));
    history.decide("s_split", true);
    assert_eq!(section_block(&history, &start), None);
}
