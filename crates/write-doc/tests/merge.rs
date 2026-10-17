use std::collections::BTreeSet;

use write_doc::merge;
use write_doc::ydoc::{self, EditMode};
use write_doc::*;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact, Update};

fn ydoc_from(doc: &Doc, client: u64) -> yrs::Doc {
    let y = ydoc::new_ydoc(client);
    ydoc::with_txn(&y, |txn, frag| ydoc::write_all(txn, frag, doc));
    y
}

fn fork(y: &yrs::Doc, client: u64) -> yrs::Doc {
    let f = ydoc::new_ydoc(client);
    let full = y.transact().encode_state_as_update_v1(&StateVector::default());
    f.transact_mut().apply_update(Update::decode_v1(&full).unwrap()).unwrap();
    f
}

fn merge_into(target: &yrs::Doc, source: &yrs::Doc) {
    let sv = target.transact().state_vector();
    let diff = source.transact().encode_diff_v1(&sv);
    target.transact_mut().apply_update(Update::decode_v1(&diff).unwrap()).unwrap();
}

fn normal(doc: &Doc) -> Doc {
    from_markdown(&to_markdown(doc))
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

fn md(blocks: &[Block]) -> String {
    to_markdown(&Doc { blocks: blocks.to_vec() })
}

/// What the service does with a version (`yours_md`) written from `base_md` when the doc has become
/// `theirs_md` since: the clean part merged in, then each conflict as a suggestion on its own copy
/// of the doc as it is then.
fn three_way(base_md: &str, theirs_md: &str, yours_md: &str) -> (Doc, merge::Plan) {
    let start = ydoc_from(&from_markdown(base_md), 1);
    let live = fork(&start, 2);
    edit_markdown(&live, theirs_md, &EditMode::default());
    let copy = fork(&start, 3);
    let base = normal(&ydoc::read_doc(&copy));
    let theirs = normal(&ydoc::read_doc(&live));
    let plan = merge::plan(&base, &theirs, &from_markdown(yours_md));
    ydoc::with_txn(&copy, |txn, frag| ydoc::patch(txn, frag, &base, &plan.direct, &EditMode::default()));
    merge_into(&live, &copy);
    let now = normal(&ydoc::read_doc(&live));
    let forks: Vec<yrs::Doc> = plan
        .conflicts
        .iter()
        .enumerate()
        .map(|(k, conflict)| {
            let f = fork(&live, 10 + k as u64);
            let target = merge::place(&theirs, &now, conflict);
            ydoc::with_txn(&f, |txn, frag| ydoc::patch(txn, frag, &now, &target, &suggest(&format!("c{k}"))));
            f
        })
        .collect();
    for f in &forks {
        merge_into(&live, f);
    }
    (ydoc::read_doc(&live), plan)
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

#[test]
fn a_suggested_new_paragraph_is_only_a_suggestion() {
    let y = ydoc_from(&from_markdown("First.\n\nSecond.\n"), 7);
    let before = ydoc::read_doc(&y);
    edit_markdown(&y, "First.\n\nNew one.\n\nSecond.\n", &suggest("s1"));
    let after = ydoc::read_doc(&y);
    // Rejected, it was never there (a commenter may make it); accepted, it is.
    assert_eq!(after.without_suggestions(), before.without_suggestions());
    assert_eq!(to_markdown(&after.with_suggestions_accepted()), "First.\n\nNew one.\n\nSecond.\n");
    // Resolving it in the live doc gives the same.
    for accept in [false, true] {
        let resolved = fork(&y, 8);
        ydoc::with_txn(&resolved, |txn, frag| assert!(ydoc::resolve_suggestion(txn, frag, "s1", accept)));
        let expected = if accept { after.with_suggestions_accepted() } else { after.without_suggestions() };
        assert_eq!(ydoc::read_doc(&resolved), expected, "accept {accept}");
    }
    // A suggested deletion of a whole paragraph, accepted, takes the paragraph away.
    edit_markdown(&y, "First.\n", &suggest("s2"));
    let doc = ydoc::read_doc(&y);
    assert_eq!(to_markdown(&doc.with_suggestions_accepted()), "First.\n\nNew one.\n");
    assert_eq!(to_markdown(&doc.without_suggestions()), "First.\n\nSecond.\n");
}

#[test]
fn separate_changes_merge_cleanly() {
    let (doc, plan) = three_way("One.\n\nTwo.\n\nThree.\n", "One!\n\nTwo.\n\nThree.\n", "One.\n\nTwo.\n\nThree?\n");
    assert!(plan.conflicts.is_empty(), "{plan:#?}");
    assert_eq!(to_markdown(&doc), "One!\n\nTwo.\n\nThree?\n");
    assert!(doc.suggestions().is_empty());
}

#[test]
fn separate_changes_in_one_paragraph_merge_cleanly() {
    let (doc, plan) = three_way("The quick brown fox jumps.\n", "The quick red fox jumps.\n", "The quick brown fox leaps.\n");
    assert!(plan.conflicts.is_empty(), "{plan:#?}");
    assert_eq!(to_markdown(&doc), "The quick red fox leaps.\n");
}

#[test]
fn the_same_change_on_both_sides_is_made_once() {
    let (doc, plan) = three_way("Teh plan.\n\nMore.\n", "The plan.\n\nMore.\n", "The plan.\n\nMore.\n");
    assert!(plan.conflicts.is_empty());
    assert_eq!(to_markdown(&doc), "The plan.\n\nMore.\n");
    // Also when the incoming version changed more in the same paragraph.
    let (doc, plan) = three_way("Teh plan is set.\n", "The plan is set.\n", "The plan is done.\n");
    assert!(plan.conflicts.is_empty(), "{plan:#?}");
    assert_eq!(to_markdown(&doc), "The plan is done.\n");
    // And a whole new paragraph added on both sides.
    let (doc, plan) = three_way("A.\n", "A.\n\nSame.\n\nMore.\n", "A.\n\nSame.\n");
    assert!(plan.conflicts.is_empty());
    assert_eq!(to_markdown(&doc), "A.\n\nSame.\n\nMore.\n");
}

#[test]
fn clashing_changes_become_a_suggestion_on_the_doc_as_it_is() {
    let (doc, plan) = three_way("The cat sat.\n\nEnd.\n", "The dog sat.\n\nEnd.\n", "The bird sat.\n\nEnd.\n");
    assert_eq!(plan.conflicts.len(), 1, "{plan:#?}");
    let conflict = &plan.conflicts[0];
    assert_eq!(md(&conflict.base), "The cat sat.\n");
    assert_eq!(md(&conflict.theirs), "The dog sat.\n");
    assert_eq!(md(&conflict.yours), "The bird sat.\n");
    assert_eq!(conflict.theirs_at, 0..1);
    // The doc keeps its text; the incoming text is a suggestion on it, by its writer.
    assert_eq!(to_markdown(&doc), "The dog sat.\n\nEnd.\n");
    let suggestions = doc.suggestions();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].author, "author-x");
    assert_eq!(to_markdown(&doc.with_suggestions_accepted()), "The bird sat.\n\nEnd.\n");
    assert_eq!(to_markdown(&doc.without_suggestions()), "The dog sat.\n\nEnd.\n");
}

#[test]
fn a_conflict_keeps_the_docs_other_changes_in_the_same_paragraph() {
    let (doc, plan) = three_way("One two three four.\n", "One 2 three FOUR.\n", "One deux three four.\n");
    assert_eq!(plan.conflicts.len(), 1, "{plan:#?}");
    assert_eq!(md(&plan.conflicts[0].target), "One deux three FOUR.\n");
    assert_eq!(to_markdown(&doc), "One 2 three FOUR.\n");
    assert_eq!(to_markdown(&doc.with_suggestions_accepted()), "One deux three FOUR.\n");
}

#[test]
fn neighbouring_conflicts_make_one_and_others_stay_apart() {
    let base = "A.\n\nB.\n\nC.\n\nD.\n\nE.\n";
    let theirs = "A1.\n\nB1.\n\nC.\n\nD.\n\nE1.\n";
    let yours = "A2.\n\nB2.\n\nC.\n\nD2.\n\nE2.\n";
    let (doc, plan) = three_way(base, theirs, yours);
    assert_eq!(plan.conflicts.len(), 2, "{plan:#?}");
    assert_eq!(md(&plan.conflicts[0].theirs), "A1.\n\nB1.\n");
    assert_eq!(plan.conflicts[0].theirs_at, 0..2);
    assert_eq!(md(&plan.conflicts[1].theirs), "E1.\n");
    assert_eq!(to_markdown(&doc), "A1.\n\nB1.\n\nC.\n\nD2.\n\nE1.\n");
    assert_eq!(doc.suggestions().len(), 2);
    assert_eq!(to_markdown(&doc.with_suggestions_accepted()), "A2.\n\nB2.\n\nC.\n\nD2.\n\nE2.\n");
}

#[test]
fn a_paragraph_deleted_on_one_side_and_changed_on_the_other() {
    // The doc deleted it and the incoming version changed it: it comes back as a suggestion.
    let (doc, plan) = three_way("A.\n\nB.\n\nC.\n", "A.\n\nC.\n", "A.\n\nB changed.\n\nC.\n");
    assert_eq!(plan.conflicts.len(), 1, "{plan:#?}");
    assert_eq!(to_markdown(&doc), "A.\n\nC.\n");
    assert_eq!(to_markdown(&doc.with_suggestions_accepted()), "A.\n\nB changed.\n\nC.\n");
    // The doc changed it and the incoming version deleted it: deleting it is the suggestion.
    let (doc, plan) = three_way("A.\n\nB.\n\nC.\n", "A.\n\nB changed.\n\nC.\n", "A.\n\nC.\n");
    assert_eq!(plan.conflicts.len(), 1, "{plan:#?}");
    assert_eq!(to_markdown(&doc), "A.\n\nB changed.\n\nC.\n");
    assert_eq!(to_markdown(&doc.with_suggestions_accepted()), "A.\n\nC.\n");
}

#[test]
fn new_paragraphs_added_at_the_same_place_are_both_kept() {
    let (doc, plan) = three_way("A.\n", "A.\n\nFrom the doc.\n", "A.\n\nFrom the file.\n");
    assert!(plan.conflicts.is_empty());
    let text = to_markdown(&doc);
    assert!(text.contains("From the doc.") && text.contains("From the file."), "{text}");
}

#[test]
fn formatting_and_structure_merge_too() {
    let base = "# Title\n\n- one\n- two\n\nPlain words here.\n";
    let theirs = "# Title\n\n- one\n- two\n- three\n\nPlain **words** here.\n";
    let yours = "# New title\n\n- one\n- two\n\nPlain words here.\n\nAn ending.\n";
    let (doc, plan) = three_way(base, theirs, yours);
    assert!(plan.conflicts.is_empty(), "{plan:#?}");
    assert_eq!(to_markdown(&doc), "# New title\n\n- one\n- two\n- three\n\nPlain **words** here.\n\nAn ending.\n");
}

// ------------------------------------------------------------------------------------------
// Random versions on both sides: neither side's words are ever lost.
// ------------------------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() as usize) % n.max(1)
    }
}

const WORDS: &[&str] = &["alpha", "beta", "gamma", "delta", "déjà", "naïve", "日本語", "🙂", "rust", "plan", "the", "and"];

/// A few edits to the paragraphs, each adding words marked with `tag` (so they can be found later).
fn edit(rng: &mut Rng, paragraphs: &[String], tag: &str, edits: usize) -> Vec<String> {
    let mut out = paragraphs.to_vec();
    for k in 0..edits {
        let token = format!("{tag}{k}x{}", rng.below(1000));
        match rng.below(6) {
            0 if !out.is_empty() => {
                // Change a word.
                let i = rng.below(out.len());
                let mut words: Vec<String> = out[i].split(' ').map(str::to_owned).collect();
                let w = first_word(&words) + rng.below(words.len() - first_word(&words));
                words[w] = token;
                out[i] = words.join(" ");
            }
            1 if !out.is_empty() => {
                let i = rng.below(out.len());
                out[i] = format!("{} {token}", out[i]);
            }
            2 if out.len() > 1 => {
                out.remove(rng.below(out.len()));
            }
            3 if !out.is_empty() => {
                // Bold a word.
                let i = rng.below(out.len());
                let mut words: Vec<String> = out[i].split(' ').map(str::to_owned).collect();
                let w = first_word(&words) + rng.below(words.len() - first_word(&words));
                if !words[w].starts_with("**") {
                    words[w] = format!("**{}**", words[w]);
                }
                out[i] = words.join(" ");
            }
            _ => {
                let at = rng.below(out.len() + 1);
                out.insert(at, format!("{token} {}", WORDS[rng.below(WORDS.len())]));
            }
        }
    }
    out
}

/// Where a block's words start: after its marker, if it has one.
fn first_word(words: &[String]) -> usize {
    usize::from(MARKERS.contains(&words[0].as_str()) && words.len() > 1)
}

const MARKERS: &[&str] = &["#", "##", ">"];

fn join(paragraphs: &[String]) -> String {
    paragraphs.iter().map(|p| format!("{p}\n")).collect::<Vec<_>>().join("\n")
}

fn tokens(text: &str, tag: &str) -> BTreeSet<String> {
    text.split(|c: char| c.is_whitespace() || c == '*')
        .filter(|w| w.starts_with(tag))
        .map(str::to_owned)
        .collect()
}

#[test]
fn random_versions_lose_nothing() {
    let (mut clean, mut conflicting) = (0, 0);
    for seed in 0..400u64 {
        let mut rng = Rng(seed * 7919 + 13);
        let base: Vec<String> = (0..2 + rng.below(5))
            .map(|_| {
                let words = (0..2 + rng.below(6)).map(|_| WORDS[rng.below(WORDS.len())]).collect::<Vec<_>>().join(" ");
                // Some headings and quotes among the paragraphs.
                match rng.below(5) {
                    0 => format!("{} {words}", MARKERS[rng.below(MARKERS.len())]),
                    _ => words,
                }
            })
            .collect();
        let (their_edits, your_edits) = (1 + rng.below(3), 1 + rng.below(3));
        let theirs = edit(&mut rng, &base, "tt", their_edits);
        let yours = edit(&mut rng, &base, "yy", your_edits);
        let (base_md, theirs_md, yours_md) = (join(&base), join(&theirs), join(&yours));

        let (doc, plan) = three_way(&base_md, &theirs_md, &yours_md);
        let accepted = to_markdown(&doc.with_suggestions_accepted());
        let rejected = to_markdown(&doc.without_suggestions());
        let context = format!("seed {seed}\nbase:\n{base_md}\ntheirs:\n{theirs_md}\nyours:\n{yours_md}\nplan: {plan:#?}\naccepted:\n{accepted}\nrejected:\n{rejected}");
        // Every word the incoming version added is in the doc once its suggestions are accepted, and
        // every word the doc's own changes added is still there if they are rejected.
        for token in tokens(&yours_md, "yy") {
            assert!(accepted.contains(&token), "lost the incoming {token}\n{context}");
        }
        for token in tokens(&theirs_md, "tt") {
            assert!(rejected.contains(&token), "lost the doc's {token}\n{context}");
        }
        // Nothing is made twice.
        for token in tokens(&theirs_md, "tt").into_iter().chain(tokens(&yours_md, "yy")) {
            assert!(accepted.matches(&token).count() <= 1, "{token} twice\n{context}");
        }
        assert_eq!(plan.conflicts.is_empty(), doc.suggestions().is_empty(), "{context}");
        if plan.conflicts.is_empty() {
            clean += 1;
        } else {
            conflicting += 1;
        }
        // A side that changed nothing, or both making the same change, merges to the other.
        if seed % 4 == 0 {
            let (doc, plan) = three_way(&base_md, &theirs_md, &base_md);
            assert!(plan.conflicts.is_empty(), "{context}");
            assert_eq!(to_markdown(&doc), to_markdown(&from_markdown(&theirs_md)), "{context}");
            let (doc, plan) = three_way(&base_md, &base_md, &yours_md);
            assert!(plan.conflicts.is_empty(), "{context}");
            assert_eq!(to_markdown(&doc), to_markdown(&from_markdown(&yours_md)), "{context}");
            let (doc, plan) = three_way(&base_md, &theirs_md, &theirs_md);
            assert!(plan.conflicts.is_empty(), "{context}");
            assert_eq!(to_markdown(&doc), to_markdown(&from_markdown(&theirs_md)), "{context}");
        }
    }
    // Both kinds of merge were tried.
    assert!(clean >= 100 && conflicting >= 40, "clean {clean}, conflicting {conflicting}");
}
