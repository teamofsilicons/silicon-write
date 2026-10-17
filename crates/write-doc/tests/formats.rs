//! Formats through Pandoc: what Silicon Write's Word reader keeps, heading identifiers, code
//! languages from web pages, and colours keeping the doc's own spelling.

use std::io::Write;
use std::path::{Path, PathBuf};
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

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("write-doc-formats-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The doc as a Word file, written the way downloads write it.
fn to_docx(doc: &Doc, dir: &Path) -> PathBuf {
    let (value, _) = to_pandoc(doc, &PandocOut { title: Some("A title".into()), ..PandocOut::default() });
    let filter = dir.join("colours.lua");
    std::fs::write(&filter, DOCX_FILTER).unwrap();
    let docx = dir.join("doc.docx");
    pandoc(&["-f", "json", "-t", "docx", "--lua-filter", filter.to_str().unwrap(), "-o", docx.to_str().unwrap()], &serde_json::to_vec(&value).unwrap());
    docx
}

/// A Word file read the way opening a file reads it.
fn read_docx(docx: &Path, dir: &Path) -> Doc {
    let reader = dir.join("docx.lua");
    std::fs::write(&reader, DOCX_READER).unwrap();
    let json = pandoc(&["-f", reader.to_str().unwrap(), "-t", "json", docx.to_str().unwrap()], b"");
    from_pandoc(&serde_json::from_slice(&json).unwrap())
}

#[test]
fn word_files_keep_colour_and_highlight() {
    let markdown = "# Title with <span style=\"color: #b42318\">red</span>\n\nPlain <span style=\"color: #ff0000\">red words</span>, <mark style=\"background-color: #FFF1A8\">lit</mark>, <mark>marked</mark> and **bold <span style=\"color: #1F5CB1\">blue</span>**.\n\n| A | B |\n| --- | --- |\n| <span style=\"color: rgb(43, 113, 72)\">green</span> | b |\n\nA note.[^1]\n\n[^1]: Plain note.\n";
    let doc = from_markdown(markdown);
    let dir = scratch("colours");
    let read = read_docx(&to_docx(&doc, &dir), &dir);
    let md = to_markdown(&read);
    for kept in [
        "<span style=\"color: #B42318\">red</span>",
        "<span style=\"color: #FF0000\">red words</span>",
        "<mark style=\"background-color: #FFF1A8\">lit</mark>",
        "<mark>marked</mark>",
        "**bold <span style=\"color: #1F5CB1\">blue</span>**",
        "<span style=\"color: #2B7148\">green</span>",
    ] {
        assert!(md.contains(kept), "the Word file lost {kept:?}:\n{md}");
    }
    assert!(!md.contains('\u{f0000}') && !md.contains('\u{f0001}'), "no marker is left: {md:?}");
    // Opened again on top of the doc, the colours are written the doc's way: nothing changed.
    let mut again = read.clone();
    respell_colours(&mut again, &doc);
    assert_eq!(to_markdown(&again), to_markdown(&doc));
}

#[test]
fn word_files_keep_their_title_block_as_text() {
    let dir = scratch("title");
    let docx = dir.join("meta.docx");
    let source = "---\ntitle: The Big Report\nsubtitle: A subtitle line\nauthor: Ada Lovelace\ndate: 17 October 2026\n---\n\n# First Heading\n\nBody text.\n";
    pandoc(&["-f", "markdown", "-t", "docx", "-o", docx.to_str().unwrap()], source.as_bytes());
    let md = to_markdown(&read_docx(&docx, &dir));
    assert!(md.starts_with("# The Big Report\n\nA subtitle line\n\nAda Lovelace\n\n17 October 2026\n\n# First Heading\n\nBody text.\n"), "{md}");
}

#[test]
fn downloads_never_put_the_title_in_the_text() {
    let doc = from_markdown("# Plan\n\nText.\n");
    let dir = scratch("no-title");
    let md = to_markdown(&read_docx(&to_docx(&doc, &dir), &dir));
    assert_eq!(md, "# Plan\n\nText.\n");
    let (value, _) = to_pandoc(&doc, &PandocOut { title: Some("A title".into()), ..PandocOut::default() });
    let html = String::from_utf8(pandoc(&["-f", "json", "-t", "html5", "--standalone"], &serde_json::to_vec(&value).unwrap())).unwrap();
    assert!(html.contains("<title>A title</title>"), "the page's title: {html}");
    assert!(!html.contains("title-block-header") && !html.contains(">A title</h1>"), "no title in the text: {html}");
}

#[test]
fn colours_written_with_rgb_reach_word() {
    let doc = from_markdown("A <span style=\"color: rgb(180, 35, 24)\">red</span> word.\n");
    let dir = scratch("rgb");
    let docx = to_docx(&doc, &dir);
    let unzip = Command::new("unzip").args(["-p", docx.to_str().unwrap(), "word/document.xml"]).output().unwrap();
    assert!(String::from_utf8_lossy(&unzip.stdout).contains("<w:color w:val=\"B42318\"/>"));
}

#[test]
fn headings_get_the_identifiers_a_table_of_contents_links_to() {
    let doc = from_markdown("[[_TOC_]]\n\n# Alpha\n\n## Beta: the *second*!\n\n# Alpha\n\n# 2026 plans\n\n# ?!\n");
    let (value, toc) = to_pandoc(&doc, &PandocOut::default());
    assert!(toc);
    let ids: Vec<&str> = value["blocks"].as_array().unwrap().iter().filter(|b| b["t"] == "Header").map(|b| b["c"][1][0].as_str().unwrap()).collect();
    assert_eq!(ids, ["alpha", "beta-the-second", "alpha-1", "plans", "section"]);
    let html = String::from_utf8(pandoc(&["-f", "json", "-t", "html5", "--standalone", "--toc", "--metadata", "pagetitle=T"], &serde_json::to_vec(&value).unwrap())).unwrap();
    assert!(html.contains("<a href=\"#alpha\""), "{html}");
    assert!(html.contains("<h1 id=\"alpha\">Alpha</h1>"), "{html}");
}

#[test]
fn code_blocks_from_web_pages_keep_their_language() {
    let html = pandoc(&["-f", "markdown", "-t", "html5"], b"```python\nprint(\"hello\")\n```\n\n``` {.js .numberLines}\nlet x = 1;\n```\n");
    let json = pandoc(&["-f", "html", "-t", "json"], &html);
    let md = to_markdown(&from_pandoc(&serde_json::from_slice(&json).unwrap()));
    assert!(md.contains("```python\nprint(\"hello\")\n```"), "{md}");
    assert!(md.contains("```js\nlet x = 1;\n```"), "{md}");
}

#[test]
fn colours_keep_the_doc_s_spelling() {
    let like = from_markdown("<span style=\"color: #ff0000\">a</span> <span style=\"color: red\">b</span> <mark style=\"background-color: #fff1a8\">c</mark>\n");
    let mut doc = from_markdown("<span style=\"color: #FF0000\">x</span> <mark style=\"background-color: #FFF1A8\">y</mark> <span style=\"color: #00FF00\">z</span> <span style=\"color: #F00\">w</span>\n");
    respell_colours(&mut doc, &like);
    assert_eq!(
        to_markdown(&doc),
        "<span style=\"color: #ff0000\">x</span> <mark style=\"background-color: #fff1a8\">y</mark> <span style=\"color: #00FF00\">z</span> <span style=\"color: #ff0000\">w</span>\n"
    );
}

#[test]
fn word_reader_does_not_confuse_text_with_its_colour_delimiters() {
    let doc = from_markdown("A <span style=\"color: #ff0000\">close</span> call and <span style=\"color: #0000ff\">other words</span>.\n");
    let dir = scratch("delimiter-text");
    let read = read_docx(&to_docx(&doc, &dir), &dir);
    let md = to_markdown(&read);
    assert_eq!(md, "A <span style=\"color: #FF0000\">close</span> call and <span style=\"color: #0000FF\">other words</span>.\n");
}
