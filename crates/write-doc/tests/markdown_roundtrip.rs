use write_doc::*;

fn roundtrip(md: &str) -> (Doc, String, Doc) {
    let doc = from_markdown(md);
    let out = to_markdown(&doc);
    let again = from_markdown(&out);
    (doc, out, again)
}

#[track_caller]
fn stable(md: &str) {
    let (doc, out, again) = roundtrip(md);
    assert_eq!(doc, again, "\n--- input\n{md}\n--- output\n{out}");
    let out2 = to_markdown(&again);
    assert_eq!(out, out2, "markdown not stable");
}

#[test]
fn basics() {
    stable("# Title\n\nHello **bold** and *italic* and ~~gone~~ and `code`.\n");
    stable("Para one\nstill one\n\nPara two\n");
    stable("- a\n- b\n  - c\n  - d\n- e\n");
    stable("1. one\n2. two\n\n10. ten\n");
    stable("- [ ] todo\n- [x] done\n");
    stable("> quote\n>\n> - list in quote\n");
    stable("```rust\nfn main() {}\n```\n");
    stable("---\n");
    stable("![alt text](https://x.test/a.png \"T\")\n");
    stable("| a | b |\n| --- | --- |\n| 1 | **2** |\n");
    stable("$$\nx^2\n$$\n\ninline $a+b$ math\n");
    stable("Footnote here[^1].\n\n[^1]: The *note*.\n");
    stable("See [[Other doc]] please.\n");
    stable("[[_TOC_]]\n\n# H\n");
    stable("[link](https://example.com) and <u>under</u> and <mark>hi</mark>\n");
    stable("<span style=\"color: #ff0000\">red</span> text\n");
    stable("line one\\\nline two\n");
}

#[test]
fn escapes() {
    for text in [
        "2 * 3 * 4",
        "snake_case and _under_",
        "a [b] c",
        "costs $5 and $x",
        "1. not a list",
        "# not a heading",
        "- not a list",
        "> not a quote",
        "a <b> c",
        "&amp; literal",
        "back\\slash",
        "tilde ~ here",
        "pipe | in text",
        "x**y",
        "+ plus",
        "=====",
    ] {
        let doc = Doc::new(vec![Block::text_paragraph(text)]);
        let md = to_markdown(&doc);
        let back = from_markdown(&md);
        assert_eq!(doc, back, "text {text:?} wrote {md:?}");
    }
}

#[test]
fn hard_marks() {
    let bold = Marks { bold: true, ..Default::default() };
    let italic = Marks { italic: true, ..Default::default() };
    let both = Marks { bold: true, italic: true, ..Default::default() };
    let link = Marks { link: Some("https://a.test/x y".into()), ..Default::default() };
    let under = Marks { underline: true, ..Default::default() };
    let cases: Vec<Vec<Inline>> = vec![
        vec![Inline::text("x"), Inline::marked("\"quoted\"", bold.clone()), Inline::text("y")],
        vec![Inline::marked("a", bold.clone()), Inline::marked("b", both.clone()), Inline::marked("c", italic.clone())],
        vec![Inline::text("pre"), Inline::marked("bold ", bold.clone()), Inline::text("after")],
        vec![Inline::marked("link", link.clone())],
        vec![Inline::text("x"), Inline::marked(" spaced ", under.clone()), Inline::text("y")],
        vec![Inline::text("a"), Inline::marked("(b)", italic.clone()), Inline::text("c")],
        vec![Inline::marked("code`tick", Marks { code: true, ..Default::default() })],
        vec![Inline::marked("both", Marks { bold: true, code: true, ..Default::default() })],
        vec![Inline::marked("hl", Marks { highlight: Some(Some("#ffee00".into())), color: Some("red".into()), ..Default::default() })],
    ];
    for content in cases {
        let doc = Doc::new(vec![Block::paragraph(content.clone())]);
        let md = to_markdown(&doc);
        let back = from_markdown(&md);
        assert_eq!(doc, back, "wrote {md:?}");
    }
}

#[test]
fn complex_table_and_lists() {
    let cell = |header: bool, text: &str, colspan: u32| TableCell {
        header,
        colspan,
        rowspan: 1,
        blocks: vec![Block::text_paragraph(text)],
    };
    let doc = Doc::new(vec![Block::Table {
        rows: vec![
            TableRow { cells: vec![cell(true, "wide", 2)] },
            TableRow {
                cells: vec![
                    cell(false, "a", 1),
                    TableCell {
                        header: false,
                        colspan: 1,
                        rowspan: 1,
                        blocks: vec![
                            Block::text_paragraph("first"),
                            Block::BulletList { items: vec![ListItem { blocks: vec![Block::text_paragraph("x")] }] },
                        ],
                    },
                ],
            },
        ],
    }]);
    let md = to_markdown(&doc);
    assert_eq!(doc, from_markdown(&md), "wrote:\n{md}");

    let lists = Doc::new(vec![
        Block::BulletList { items: vec![ListItem { blocks: vec![Block::text_paragraph("a")] }] },
        Block::BulletList { items: vec![ListItem { blocks: vec![Block::text_paragraph("b")] }] },
        Block::OrderedList { start: 3, items: vec![ListItem { blocks: vec![Block::text_paragraph("c"), Block::text_paragraph("c2")] }] },
        Block::OrderedList { start: 1, items: vec![ListItem { blocks: vec![Block::text_paragraph("d")] }] },
    ]);
    let md = to_markdown(&lists);
    assert_eq!(lists, from_markdown(&md), "wrote:\n{md}");
}

#[test]
fn suggestions_views() {
    let ins = Marks { suggestion: Some(Suggestion { kind: SuggestionKind::Insert, id: "s1".into(), author: "u1".into() }), ..Default::default() };
    let del = Marks { suggestion: Some(Suggestion { kind: SuggestionKind::Delete, id: "s2".into(), author: "u1".into() }), ..Default::default() };
    let doc = Doc::new(vec![Block::paragraph(vec![
        Inline::text("keep "),
        Inline::marked("new ", ins),
        Inline::marked("old ", del),
        Inline::text("end"),
    ])]);
    assert_eq!(to_markdown(&doc), "keep old end\n");
    let critic = to_markdown_with(&doc, &WriteOptions { suggestions: SuggestionView::Critic, ..Default::default() });
    assert_eq!(critic, "keep {++new ++}{--old --}end\n");
    assert_eq!(doc.suggestions().len(), 2);
}
