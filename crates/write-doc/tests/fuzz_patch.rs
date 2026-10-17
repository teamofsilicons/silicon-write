//! The patcher must always land exactly on the target, whatever the edit: a seeded fuzz over rich docs and
//! Markdown-level edits (text with emoji and CJK, formatting, links, lists, tables, code, block moves).

use write_doc::ydoc::{self, EditMode};
use write_doc::*;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact, Update};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next() as usize) % items.len()]
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

const WORDS: &[&str] = &["alpha", "beta", "gamma", "déjà", "naïve", "über", "日本語", "中文", "🙂", "👍🏽", "e=mc", "x_y", "a*b", "[x]", "<tag>", "$5", "50%", "#1", "C++", "rust"];

fn words(rng: &mut Rng, n: usize) -> String {
    (0..n).map(|_| *rng.pick(WORDS)).collect::<Vec<_>>().join(" ")
}

fn inline(rng: &mut Rng) -> String {
    let n = 1 + (rng.next() % 5) as usize;
    let w = words(rng, n);
    match rng.next() % 9 {
        0 => format!("**{w}**"),
        1 => format!("*{w}*"),
        2 => format!("~~{w}~~"),
        3 => format!("[{w}](https://example.test/{})", rng.next() % 100),
        4 => format!("<u>{w}</u>"),
        5 => format!("<mark>{w}</mark>"),
        6 => format!("`{w}`"),
        _ => w,
    }
}

fn line(rng: &mut Rng) -> String {
    (0..1 + (rng.next() % 4)).map(|_| inline(rng)).collect::<Vec<_>>().join(" ")
}

fn block(rng: &mut Rng) -> String {
    match rng.next() % 9 {
        0 => format!("# {}", line(rng)),
        1 => format!("## {}", line(rng)),
        2 => (0..1 + rng.next() % 3).map(|_| format!("- {}", line(rng))).collect::<Vec<_>>().join("\n"),
        3 => (0..1 + rng.next() % 3).enumerate().map(|(i, _)| format!("{}. {}", i + 1, line(rng))).collect::<Vec<_>>().join("\n"),
        4 => (0..1 + rng.next() % 3).map(|_| format!("- [{}] {}", if rng.chance(50) { "x" } else { " " }, line(rng))).collect::<Vec<_>>().join("\n"),
        5 => format!("> {}", line(rng)),
        6 => format!("```\n{}\n```", words(rng, 3)),
        7 => format!("| a | b |\n| --- | --- |\n| {} | {} |", words(rng, 1), words(rng, 2)),
        _ => line(rng),
    }
}

fn doc_md(rng: &mut Rng) -> String {
    (0..2 + rng.next() % 6).map(|_| block(rng)).collect::<Vec<_>>().join("\n\n") + "\n"
}

/// A Markdown-level edit of `md`: replace, insert or delete a block, or change words inside one.
fn mutate(rng: &mut Rng, md: &str) -> String {
    let mut blocks: Vec<String> = md.trim_end().split("\n\n").map(str::to_owned).collect();
    let i = (rng.next() as usize) % blocks.len().max(1);
    match rng.next() % 6 {
        0 => blocks.insert(i, block(rng)),
        1 if blocks.len() > 1 => {
            blocks.remove(i);
        }
        2 => blocks[i] = block(rng),
        3 => {
            // Change one word inside the block.
            let b = &blocks[i];
            let word = *rng.pick(WORDS);
            if let Some(pos) = b.find(word) {
                let replacement = words(rng, 1);
                blocks[i] = format!("{}{}{}", &b[..pos], replacement, &b[pos + word.len()..]);
            } else {
                blocks[i] = format!("{} {}", b, words(rng, 1));
            }
        }
        4 if blocks.len() > 1 => {
            let j = (rng.next() as usize) % blocks.len();
            blocks.swap(i, j);
        }
        _ => {
            let b = blocks[i].clone();
            blocks[i] = format!("{b} {}", inline(rng));
        }
    }
    blocks.join("\n\n") + "\n"
}

fn live(doc: &Doc, client: u64) -> yrs::Doc {
    let y = ydoc::new_ydoc(client);
    ydoc::with_txn(&y, |txn, frag| ydoc::write_all(txn, frag, doc));
    y
}

fn edit_to(y: &yrs::Doc, md: &str) {
    let current = ydoc::read_doc(y);
    let base = from_markdown(&to_markdown(&current));
    let new = from_markdown(md);
    ydoc::with_txn(y, |txn, frag| ydoc::patch(txn, frag, &base, &new, &EditMode::default()));
}

#[test]
fn patch_always_reaches_the_target() {
    for seed in 1..=400u64 {
        let mut rng = Rng(seed);
        let start_md = doc_md(&mut rng);
        let start = from_markdown(&start_md);
        let y = live(&start, 3);
        let mut current_md = to_markdown(&start);
        for step in 0..6 {
            let target_md = mutate(&mut rng, &current_md);
            let target = from_markdown(&target_md);
            edit_to(&y, &target_md);
            let got = ydoc::read_doc(&y);
            assert_eq!(
                to_markdown(&got),
                to_markdown(&target),
                "seed {seed} step {step}\n--- from\n{current_md}\n--- to\n{target_md}"
            );
            current_md = to_markdown(&got);
        }
    }
}

#[test]
fn concurrent_edits_to_different_blocks_both_survive() {
    for seed in 1..=150u64 {
        let mut rng = Rng(seed * 7919);
        let md = (0..4).map(|_| line(&mut rng)).collect::<Vec<_>>().join("\n\n") + "\n";
        let start = from_markdown(&md);
        let y = live(&start, 1);
        let full = y.transact().encode_state_as_update_v1(&StateVector::default());
        let a = ydoc::new_ydoc(2);
        a.transact_mut().apply_update(Update::decode_v1(&full).unwrap()).unwrap();
        let b = ydoc::new_ydoc(3);
        b.transact_mut().apply_update(Update::decode_v1(&full).unwrap()).unwrap();
        let blocks: Vec<String> = to_markdown(&start).trim_end().split("\n\n").map(str::to_owned).collect();
        if blocks.len() < 4 {
            continue;
        }
        let mut a_blocks = blocks.clone();
        a_blocks[0] = format!("{} {}", a_blocks[0], words(&mut rng, 2));
        let mut b_blocks = blocks.clone();
        b_blocks[3] = format!("{} {}", b_blocks[3], words(&mut rng, 2));
        edit_to(&a, &(a_blocks.join("\n\n") + "\n"));
        edit_to(&b, &(b_blocks.join("\n\n") + "\n"));
        for other in [&a, &b] {
            let update = other.transact().encode_diff_v1(&y.transact().state_vector());
            y.transact_mut().apply_update(Update::decode_v1(&update).unwrap()).unwrap();
        }
        let mut expected = blocks.clone();
        expected[0] = a_blocks[0].clone();
        expected[3] = b_blocks[3].clone();
        assert_eq!(
            to_markdown(&ydoc::read_doc(&y)),
            to_markdown(&from_markdown(&(expected.join("\n\n") + "\n"))),
            "seed {seed}"
        );
    }
}

#[test]
fn suggestions_accept_to_the_target_and_reject_to_the_original() {
    let mut failures = vec![];
    for seed in 1..=250u64 {
        for accept in [true, false] {
            let mut rng = Rng(seed * 104729);
            // Text-only docs: suggestions are about text (structure changes apply directly in the editor).
            let md = (0..3).map(|_| line(&mut rng)).collect::<Vec<_>>().join("\n\n") + "\n";
            let start = from_markdown(&md);
            let original = to_markdown(&start);
            let y = live(&start, 1);
            let mut blocks: Vec<String> = original.trim_end().split("\n\n").map(str::to_owned).collect();
            let i = (rng.next() as usize) % blocks.len();
            let word = words(&mut rng, 1);
            blocks[i] = match rng.next() % 3 {
                0 => format!("{} {}", blocks[i], word),
                1 => blocks[i].split(' ').skip(1).collect::<Vec<_>>().join(" "),
                _ => format!("{word} {}", blocks[i]),
            };
            if blocks[i].trim().is_empty() {
                blocks[i] = word.clone();
            }
            let target_md = blocks.join("\n\n") + "\n";
            let target = to_markdown(&from_markdown(&target_md));
            let current = ydoc::read_doc(&y);
            let base = from_markdown(&to_markdown(&current));
            let new = from_markdown(&target_md);
            let mode = EditMode { suggest: Some(("s1".into(), "author".into())) };
            ydoc::with_txn(&y, |txn, frag| ydoc::patch(txn, frag, &base, &new, &mode));
            // Nothing changed yet for readers.
            let pending = to_markdown(&ydoc::read_doc(&y));
            if pending != original {
                failures.push(format!("seed {seed}: the suggestion changed the doc before review\n{original}\n---\n{pending}"));
                continue;
            }
            ydoc::with_txn(&y, |txn, frag| ydoc::resolve_suggestion(txn, frag, "s1", accept));
            let got = to_markdown(&ydoc::read_doc(&y));
            let want = if accept { &target } else { &original };
            if &got != want {
                failures.push(format!("seed {seed} accept={accept}\n--- want\n{want}--- got\n{got}"));
            }
        }
    }
    assert!(failures.is_empty(), "{} failures, first:\n{}", failures.len(), failures.first().unwrap());
}
