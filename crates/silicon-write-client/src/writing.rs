//! Opt-in normalization for CLI-authored text. SDK callers preserve text by default.
use serde_json::Value;

/// Rewrites authored text only. Exact-match selectors, anchors, IDs, URLs and formatting
/// attributes are deliberately not writing; changing them would break edits or references.
pub(crate) fn normalize(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(normalize),
        Value::Object(fields) => {
            for (key, value) in fields {
                match key.as_str() {
                    "anchor" | "old" | "find" | "quote" | "attrs" | "attributes" => (),
                    "title" | "name" | "markdown" | "body" | "new" | "replace" | "text"
                    | "insert" | "notes" | "section" | "summary" | "label" | "labels"
                    | "caption" | "alt" | "html" => text(value),
                    _ => normalize(value),
                }
            }
        }
        _ => (),
    }
}

fn text(value: &mut Value) {
    match value {
        Value::String(s) => *s = s.replace('—', "-"),
        Value::Array(items) => items.iter_mut().for_each(text),
        _ => normalize(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writing_changes_but_match_text_anchors_and_links_do_not() {
        let mut request = json!({
            "title":"One—two", "markdown":"A — B – C", "body":"Reply—yes",
            "anchor":{"quote":"Original—text"}, "edits":[{"old":"Original—text","new":"Better—text"}],
            "ops":[{"op":"replace_text","find":"Old—text","replace":"New—text"},
                {"op":"update_element","element":"id—unchanged","set":{"text":[{"insert":"Hello—world","attributes":{"link":"https://example.com/—"}}],"notes":"Note—one","chart":{"labels":["A—B"]}}}],
            "src":"https://example.com/—", "folder_id":"folder—id"
        });
        normalize(&mut request);
        assert_eq!(request["title"], "One-two");
        assert_eq!(request["markdown"], "A - B – C");
        assert_eq!(request["body"], "Reply-yes");
        assert_eq!(request["anchor"]["quote"], "Original—text");
        assert_eq!(request["edits"][0]["old"], "Original—text");
        assert_eq!(request["edits"][0]["new"], "Better-text");
        assert_eq!(request["ops"][0]["find"], "Old—text");
        assert_eq!(request["ops"][0]["replace"], "New-text");
        assert_eq!(request["ops"][1]["set"]["text"][0]["insert"], "Hello-world");
        assert_eq!(
            request["ops"][1]["set"]["text"][0]["attributes"]["link"],
            "https://example.com/—"
        );
        assert_eq!(request["ops"][1]["set"]["notes"], "Note-one");
        assert_eq!(request["ops"][1]["set"]["chart"]["labels"][0], "A-B");
        assert_eq!(request["src"], "https://example.com/—");
        assert_eq!(request["folder_id"], "folder—id");
    }
}
