//! What changed between two runs of inline content, the way a reader would put it.
//!
//! Text is compared word by word. A word that changed only a little (a typo, an ending) is edited
//! character by character, so a comment on it and who wrote it stay with it; any other changed
//! passage is replaced as a whole. Spaces and punctuation alone never hold a replaced passage
//! together, and a sentence replaced as a whole takes its punctuation with it: text replaced by
//! other words keeps nothing of the old text for a comment to sit on, so the comment shows the text
//! it was on instead of claiming the new words.
//!
//! Inline nodes that aren't text are compared by their kind, so a footnote whose note changed is
//! still the same footnote (the caller gives it its new content), and nodes always stay where the
//! text around them says they are.

use std::ops::Range;
use std::time::{Duration, Instant};

/// One unit of inline content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Sym {
    Char(char),
    /// A line break.
    Break,
    /// An inline node that isn't text, by its kind.
    Node(u8),
}

/// One step from the old units to the new ones, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// The next `n` units are the same on both sides.
    Equal(usize),
    /// The next `n` old units go.
    Delete(usize),
    /// The next `n` new units come in.
    Insert(usize),
}

/// How long comparing words may take before settling for a less exact answer (the doc is locked
/// meanwhile).
const DEADLINE: Duration = Duration::from_millis(500);

/// Past this many changed characters on both sides, a passage is only compared at its two ends.
const LONG: usize = 10_000;

/// The steps that turn `old` into `new`.
pub fn diff(old: &[Sym], new: &[Sym]) -> Vec<Op> {
    if old == new {
        return if old.is_empty() { vec![] } else { vec![Op::Equal(old.len())] };
    }
    let old_tokens = tokens(old);
    let new_tokens = tokens(new);
    let mut regions = regions(old, new, &old_tokens, &new_tokens);
    absorb_between(&mut regions, &old_tokens, &new_tokens);
    absorb_sentences(&mut regions, old, &old_tokens);
    let mut ops = vec![];
    for region in &regions {
        let o = units(&old_tokens, &region.old, old.len());
        let n = units(&new_tokens, &region.new, new.len());
        if region.same {
            push(&mut ops, Op::Equal(o.len()));
        } else {
            refine(&old[o], &new[n], &mut ops);
        }
    }
    ops
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Letters and digits (a CJK sentence is one word).
    Word,
    Space,
    /// One punctuation mark or symbol.
    Mark,
    /// A line break or an inline node.
    Node,
}

#[derive(Debug)]
struct Token {
    units: Range<usize>,
    kind: Kind,
}

fn kind_of(sym: Sym) -> Kind {
    match sym {
        Sym::Char(c) if c.is_alphanumeric() => Kind::Word,
        Sym::Char(c) if c.is_whitespace() => Kind::Space,
        Sym::Char(_) => Kind::Mark,
        Sym::Break | Sym::Node(_) => Kind::Node,
    }
}

fn tokens(syms: &[Sym]) -> Vec<Token> {
    let mut out = vec![];
    let mut i = 0;
    while i < syms.len() {
        let kind = kind_of(syms[i]);
        let mut j = i + 1;
        if matches!(kind, Kind::Word | Kind::Space) {
            while j < syms.len() && kind_of(syms[j]) == kind {
                j += 1;
            }
        }
        out.push(Token { units: i..j, kind });
        i = j;
    }
    out
}

/// The units a range of tokens covers.
fn units(tokens: &[Token], range: &Range<usize>, total: usize) -> Range<usize> {
    let start = tokens.get(range.start).map_or(total, |t| t.units.start);
    if range.is_empty() { start..start } else { start..tokens[range.end - 1].units.end }
}

fn length(tokens: &[Token], range: &Range<usize>) -> usize {
    tokens[range.clone()].iter().map(|t| t.units.len()).sum()
}

/// A stretch that is the same on both sides, or that changed (token ranges).
#[derive(Debug, Clone)]
struct Region {
    same: bool,
    old: Range<usize>,
    new: Range<usize>,
}

fn regions(old: &[Sym], new: &[Sym], old_tokens: &[Token], new_tokens: &[Token]) -> Vec<Region> {
    let old_keys: Vec<&[Sym]> = old_tokens.iter().map(|t| &old[t.units.clone()]).collect();
    let new_keys: Vec<&[Sym]> = new_tokens.iter().map(|t| &new[t.units.clone()]).collect();
    let ops = similar::capture_diff_slices_deadline(
        similar::Algorithm::Myers,
        &old_keys,
        &new_keys,
        Some(Instant::now() + DEADLINE),
    );
    let mut regions: Vec<Region> = vec![];
    for op in ops {
        let (tag, o, n) = op.as_tag_tuple();
        let same = tag == similar::DiffTag::Equal;
        match regions.last_mut() {
            Some(last) if last.same == same => {
                last.old.end = o.end;
                last.new.end = n.end;
            }
            _ => regions.push(Region { same, old: o, new: n }),
        }
    }
    regions
}

/// Only spaces and punctuation.
fn weak(tokens: &[Token]) -> bool {
    tokens.iter().all(|t| matches!(t.kind, Kind::Space | Kind::Mark))
}

/// Folds what stayed the same between two changes into them when it can't stand on its own: only
/// spaces and punctuation, or a few words no longer than the changes on either side of them (which
/// are coincidence rather than text that stayed). Inline nodes always stand on their own.
fn absorb_between(regions: &mut Vec<Region>, old_tokens: &[Token], new_tokens: &[Token]) {
    let size = |r: &Region| length(old_tokens, &r.old).max(length(new_tokens, &r.new));
    let mut i = 1;
    while i + 1 < regions.len() {
        let (before, same, after) = (&regions[i - 1], &regions[i], &regions[i + 1]);
        let between = same.same && !before.same && !after.same && {
            let tokens = &old_tokens[same.old.clone()];
            let nodes = tokens.iter().any(|t| t.kind == Kind::Node);
            let n = length(old_tokens, &same.old);
            !nodes && (weak(tokens) || (n <= size(before) && n <= size(after)))
        };
        if between {
            let merged = Region {
                same: false,
                old: before.old.start..after.old.end,
                new: before.new.start..after.new.end,
            };
            regions.splice(i - 1..i + 2, [merged]);
            // The bigger change may now take in what stayed the same before it.
            i = i.saturating_sub(2).max(1);
        } else {
            i += 1;
        }
    }
}

fn is_terminator(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '…' | '‽') || is_wide_terminator(c)
}

/// Sentence ends that need no space after them (CJK).
fn is_wide_terminator(c: char) -> bool {
    matches!(c, '。' | '！' | '？' | '｡')
}

fn is_closer(c: char) -> bool {
    matches!(c, '"' | '\'' | '”' | '’' | '»' | ')' | ']' | '}' | '」' | '』' | '）' | '］')
}

fn mark(syms: &[Sym], token: &Token) -> Option<char> {
    match (token.kind, syms[token.units.start]) {
        (Kind::Mark, Sym::Char(c)) => Some(c),
        _ => None,
    }
}

/// Whether text ends at the end of a sentence (or of a line).
fn ends_sentence(syms: &[Sym], tokens: &[Token]) -> bool {
    let mut k = tokens.len();
    let Some(last) = tokens.last() else {
        return true;
    };
    if syms[last.units.clone()].iter().any(|s| matches!(s, Sym::Break | Sym::Char('\n'))) {
        return true;
    }
    let mut spaced = false;
    while k > 0 && tokens[k - 1].kind == Kind::Space {
        k -= 1;
        spaced = true;
    }
    if k > 0 && mark(syms, &tokens[k - 1]).is_some_and(is_wide_terminator) {
        return true;
    }
    if !spaced {
        return false;
    }
    // Closing quotes and brackets, and notes, can follow the full stop.
    while k > 0
        && (mark(syms, &tokens[k - 1]).is_some_and(is_closer)
            || (tokens[k - 1].kind == Kind::Node && syms[tokens[k - 1].units.start] != Sym::Break))
    {
        k -= 1;
    }
    k > 0 && mark(syms, &tokens[k - 1]).is_some_and(is_terminator)
}

/// How many tokens at the start of `tokens` close a sentence: punctuation with a sentence end in it,
/// followed by a space, a node, the end of the text (`at_end`), or nothing for CJK.
fn closing(syms: &[Sym], tokens: &[Token], at_end: bool) -> Option<usize> {
    let mut k = 0;
    let mut ends = false;
    let mut wide = false;
    while k < tokens.len() {
        match mark(syms, &tokens[k]) {
            Some(c) if is_terminator(c) || is_closer(c) => {
                ends |= is_terminator(c);
                wide |= is_wide_terminator(c);
                k += 1;
            }
            _ => break,
        }
    }
    let followed = match tokens.get(k) {
        None => at_end,
        Some(t) => matches!(t.kind, Kind::Space | Kind::Node) || wide,
    };
    (k > 0 && ends && followed).then_some(k)
}

/// A changed passage that starts a sentence and runs to its end takes the punctuation around it
/// (closing marks, a full stop, opening quotes at the very start): the sentence was replaced, and
/// its full stop shouldn't hold a comment on the old sentence in place over the new one.
fn absorb_sentences(regions: &mut Vec<Region>, old: &[Sym], old_tokens: &[Token]) {
    let mut i = 0;
    while i < regions.len() {
        if regions[i].same {
            i += 1;
            continue;
        }
        let last = regions.len() - 1;
        let leading = i == 1 && weak(&old_tokens[regions[0].old.clone()]);
        let starts = i == 0 || leading || ends_sentence(old, &old_tokens[regions[i - 1].old.clone()]);
        let take = if i == last {
            Some(0)
        } else {
            let next = &old_tokens[regions[i + 1].old.clone()];
            let at_end = i + 1 == last;
            if at_end && weak(next) { Some(next.len()) } else { closing(old, next, at_end) }
        };
        if let (true, Some(take)) = (starts, take) {
            if take > 0 {
                regions[i].old.end += take;
                regions[i].new.end += take;
                regions[i + 1].old.start += take;
                regions[i + 1].new.start += take;
                if regions[i + 1].old.is_empty() {
                    regions.remove(i + 1);
                }
            }
            if leading {
                regions[1].old.start = regions[0].old.start;
                regions[1].new.start = regions[0].new.start;
                regions.remove(0);
                i -= 1;
            }
        }
        i += 1;
    }
}

fn push(ops: &mut Vec<Op>, op: Op) {
    let n = match op {
        Op::Equal(n) | Op::Delete(n) | Op::Insert(n) => n,
    };
    if n == 0 {
        return;
    }
    match (ops.last_mut(), op) {
        (Some(Op::Equal(a)), Op::Equal(b)) | (Some(Op::Delete(a)), Op::Delete(b)) | (Some(Op::Insert(a)), Op::Insert(b)) => *a += b,
        _ => ops.push(op),
    }
}

/// A changed passage: edited character by character when the two sides are mostly the same
/// letters (a typo, an ending, a CJK sentence with a word changed), replaced whole otherwise. Only
/// letters and digits count as the same: spaces and punctuation are the same in any two sentences.
fn refine(old: &[Sym], new: &[Sym], ops: &mut Vec<Op>) {
    let text = |syms: &[Sym]| -> Option<String> {
        syms.iter().map(|s| match s {
            Sym::Char(c) => Some(*c),
            _ => None,
        })
        .collect()
    };
    let (Some(a), Some(b)) = (text(old), text(new)) else {
        push(ops, Op::Delete(old.len()));
        push(ops, Op::Insert(new.len()));
        return;
    };
    if a.is_empty() || b.is_empty() {
        push(ops, Op::Delete(old.len()));
        push(ops, Op::Insert(new.len()));
        return;
    }
    let letters = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).count();
    let prefix = old.iter().zip(new).take_while(|(x, y)| x == y).count();
    let suffix = old[prefix..].iter().rev().zip(new[prefix..].iter().rev()).take_while(|(x, y)| x == y).count();
    let mut steps = vec![];
    let mut common = 0;
    if old.len() - prefix - suffix > LONG && new.len() - prefix - suffix > LONG {
        let a: Vec<char> = a.chars().collect();
        let ends: String = a[..prefix].iter().chain(&a[a.len() - suffix..]).collect();
        common = letters(&ends);
        push(&mut steps, Op::Equal(prefix));
        push(&mut steps, Op::Delete(old.len() - prefix - suffix));
        push(&mut steps, Op::Insert(new.len() - prefix - suffix));
        push(&mut steps, Op::Equal(suffix));
    } else {
        for chunk in dissimilar::diff(&a, &b) {
            match chunk {
                dissimilar::Chunk::Equal(s) => {
                    common += letters(s);
                    push(&mut steps, Op::Equal(s.chars().count()));
                }
                dissimilar::Chunk::Delete(s) => push(&mut steps, Op::Delete(s.chars().count())),
                dissimilar::Chunk::Insert(s) => push(&mut steps, Op::Insert(s.chars().count())),
            }
        }
    }
    if common > 0 && common * 2 >= letters(&a).min(letters(&b)) {
        for step in steps {
            push(ops, step);
        }
    } else {
        push(ops, Op::Delete(old.len()));
        push(ops, Op::Insert(new.len()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn syms(s: &str) -> Vec<Sym> {
        s.chars().map(|c| if c == '¶' { Sym::Break } else if c == '†' { Sym::Node(2) } else { Sym::Char(c) }).collect()
    }

    /// The diff written out: `=kept=`, `-gone-`, `+new+`.
    fn show(old: &str, new: &str) -> String {
        let (o, n) = (syms(old), syms(new));
        let ops = diff(&o, &n);
        let (oc, nc): (Vec<char>, Vec<char>) = (old.chars().collect(), new.chars().collect());
        let (mut i, mut j) = (0, 0);
        let mut out = String::new();
        for op in ops {
            match op {
                Op::Equal(k) => {
                    assert_eq!(oc[i..i + k], nc[j..j + k]);
                    out.push_str(&format!("={}=", oc[i..i + k].iter().collect::<String>()));
                    i += k;
                    j += k;
                }
                Op::Delete(k) => {
                    out.push_str(&format!("-{}-", oc[i..i + k].iter().collect::<String>()));
                    i += k;
                }
                Op::Insert(k) => {
                    out.push_str(&format!("+{}+", nc[j..j + k].iter().collect::<String>()));
                    j += k;
                }
            }
        }
        assert_eq!((i, j), (oc.len(), nc.len()), "the steps cover both sides");
        out
    }

    #[test]
    fn unrelated_text_keeps_nothing() {
        assert_eq!(show("Replace this sentence entirely.", "Zebra quantum 42 lorem."), "-Replace this sentence entirely.-+Zebra quantum 42 lorem.+");
        assert_eq!(
            show("First sentence stays. Replace this sentence entirely.", "First sentence stays. Zebra quantum 42 lorem."),
            "=First sentence stays. =-Replace this sentence entirely.-+Zebra quantum 42 lorem.+"
        );
        assert_eq!(
            show("Replace this sentence entirely. Second stays.", "Zebra quantum 42 lorem. Second stays."),
            "-Replace this sentence entirely.-+Zebra quantum 42 lorem.+= Second stays.="
        );
        assert_eq!(show("\"Old words here.\"", "\"New sentence now.\""), "-\"Old words here.\"-+\"New sentence now.\"+");
        assert_eq!(show("alpha beta", "gamma delta"), "-alpha beta-+gamma delta+");
    }

    #[test]
    fn words_inside_a_sentence() {
        assert_eq!(show("Ship on Monday with the team.", "Ship on Tuesday with the team."), "=Ship on =-Mon-+Tues+=day with the team.=");
        assert_eq!(show("(see above)", "(see below)"), "=(see =-above-+below+=)=");
        assert_eq!(show("Hello, world.", "Hello, there."), "=Hello, =-world-+there+=.=");
        assert_eq!(show("I recieve it.", "I receive it."), "=I rec=-i-=e=+i+=ve it.=");
        assert_eq!(show("We run.", "We running."), "=We run=+ning+=.=");
        assert_eq!(show("The cats sat.", "The dogs sat."), "=The =-cats-+dogs+= sat.=");
    }

    #[test]
    fn typing_keeps_everything_else() {
        assert_eq!(show("The Carbon wrote this.", "The Carbon had written this."), "=The Carbon =-wrote-+had written+= this.=");
        assert_eq!(show("Line one", "Line one and two"), "=Line one=+ and two+");
        assert_eq!(show("日本語のテキストです", "日本語の文章です"), "=日本語の=-テキスト-+文章+=です=");
    }

    #[test]
    fn nodes_stay_where_the_text_says() {
        assert_eq!(show("A note.†", "A note.†"), "=A note.†=");
        assert_eq!(show("Line one and two.", "Line one¶and two."), "=Line one=- -+¶+=and two.=");
        assert_eq!(show("Intro† and more.", "Intro and more."), "=Intro=-†-= and more.=");
        assert_eq!(show("a, b, c", "x, y, z"), "-a, b, c-+x, y, z+");
    }
}
