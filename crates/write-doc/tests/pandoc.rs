use std::io::Write;
use std::process::{Command, Stdio};

use write_doc::pandoc::*;
use write_doc::*;

fn pandoc(args: &[&str], input: &[u8]) -> Vec<u8> {
    let mut child = Command::new("pandoc").args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("pandoc");
    child.stdin.take().unwrap().write_all(input).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "pandoc failed: {}", String::from_utf8_lossy(&out.stderr));
    out.stdout
}

const SAMPLE: &str = "# Plan\n\nIntro with **bold**, *it*, <u>under</u> and [a link](https://x.test).\n\n- one\n- two\n\n1. first\n2. second\n\n- [ ] task\n- [x] done\n\n> quoted\n\n```js\nlet a = 1;\n```\n\n| h1 | h2 |\n| --- | --- |\n| a | b |\n\nMath $x^2$ and footnote[^1].\n\n$$\ny=mx\n$$\n\n[^1]: Note text.\n";

#[test]
fn through_pandoc_json() {
    let doc = from_markdown(SAMPLE);
    let (value, _) = to_pandoc(&doc, &PandocOut::default());
    let json = serde_json::to_vec(&value).unwrap();
    // Pandoc accepts our tree and gives the same tree back.
    let back = pandoc(&["-f", "json", "-t", "json"], &json);
    let read = from_pandoc(&serde_json::from_slice(&back).unwrap());
    assert_eq!(to_markdown(&read), to_markdown(&doc));
}

#[test]
fn through_docx_and_html() {
    let doc = from_markdown(SAMPLE);
    let (value, _) = to_pandoc(&doc, &PandocOut::default());
    let json = serde_json::to_vec(&value).unwrap();
    let dir = std::env::temp_dir().join(format!("write-doc-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let filter = dir.join("colors.lua");
    std::fs::write(&filter, DOCX_FILTER).unwrap();
    let docx = dir.join("out.docx");
    pandoc(&["-f", "json", "-t", "docx", "--lua-filter", filter.to_str().unwrap(), "-o", docx.to_str().unwrap()], &json);
    let back = pandoc(&[docx.to_str().unwrap(), "-t", "json"], b"");
    let read = from_pandoc(&serde_json::from_slice(&back).unwrap());
    let md = to_markdown(&read);
    for needle in ["# Plan", "**bold**", "<u>under</u>", "[a link](https://x.test)", "- [ ] task", "- [x] done", "1. first", "| h1 | h2 |", "Math $x^{2}$", "[^1]", "mx"] {
        assert!(md.contains(needle), "docx lost {needle:?}:\n{md}");
    }
    let html = pandoc(&["-f", "json", "-t", "html"], &json);
    let back = pandoc(&["-f", "html", "-t", "json"], &html);
    let read = from_pandoc(&serde_json::from_slice(&back).unwrap());
    assert!(to_markdown(&read).contains("**bold**"));
}

#[test]
fn colours_reach_word() {
    let doc = from_markdown("A <span style=\"color: #ff0000\">red</span> and <mark style=\"background-color: #ffee00\">lit</mark> word.\n");
    let (value, _) = to_pandoc(&doc, &PandocOut::default());
    let dir = std::env::temp_dir().join(format!("write-doc-color-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let filter = dir.join("colors.lua");
    std::fs::write(&filter, DOCX_FILTER).unwrap();
    let docx = dir.join("c.docx");
    pandoc(&["-f", "json", "-t", "docx", "--lua-filter", filter.to_str().unwrap(), "-o", docx.to_str().unwrap()], &serde_json::to_vec(&value).unwrap());
    let unzip = Command::new("unzip").args(["-p", docx.to_str().unwrap(), "word/document.xml"]).output().unwrap();
    let xml = String::from_utf8_lossy(&unzip.stdout);
    assert!(xml.contains("w:color w:val=\"FF0000\""), "{xml}");
    assert!(xml.contains("w:fill=\"FFEE00\""), "{xml}");
}

#[test]
fn plain_text() {
    let doc = from_plain_text("Line one\nline two\n\nPara two\r\n");
    assert_eq!(to_markdown(&doc), "Line one\\\nline two\n\nPara two\n");
}
