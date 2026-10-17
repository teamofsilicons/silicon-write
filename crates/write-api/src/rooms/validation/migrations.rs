//! Tiptap records relative-position transfers when a paragraph is split or replaced.
//! These are shared map values, separate from the editor's XML content.

use std::collections::HashMap;

use yrs::{Any, Map, Out, ReadTxn, XmlFragment};

const ROOT: &str = "__tiptap_position_migrations:root:default";
const MAX_CLIENT: i64 = (1_i64 << 53) - 1;
const MAX_CLOCK: i64 = u32::MAX as i64;

pub(super) fn valid<T: ReadTxn>(txn: &T, name: &str) -> bool {
    name == ROOT
        // A root can have both sequence and map components. Only the map belongs here.
        && txn.get_xml_fragment(name).is_some_and(|root| root.len(txn) == 0)
        && txn.get_map(name).is_some_and(|map| {
            map.iter(txn).all(|(key, value)| match value {
                Out::Any(Any::Map(entry)) => migration(key, &entry),
                _ => false,
            })
        })
}

fn number(value: &Any, min: i64, max: i64) -> Option<i64> {
    if let Any::Number(value) = value {
        value.as_i64().filter(|n| *n >= min && *n <= max)
    } else {
        None
    }
}

fn field(map: &HashMap<String, Any>, key: &str, max: i64) -> Option<i64> {
    number(map.get(key)?, 0, max)
}

fn keys(map: &HashMap<String, Any>, allowed: &[&str]) -> bool {
    map.keys().all(|key| allowed.contains(&key.as_str()))
}

fn boundary(map: &HashMap<String, Any>) -> bool {
    map.get("boundary").is_none_or(
        |value| matches!(value, Any::String(s) if s.as_ref() == "start" || s.as_ref() == "end"),
    )
}

fn id(map: &HashMap<String, Any>) -> bool {
    field(map, "client", MAX_CLIENT).is_some() && field(map, "clock", MAX_CLOCK).is_some()
}

fn transfer(value: &Any) -> bool {
    let Any::Map(transfer) = value else {
        return false;
    };
    if !keys(transfer, &["source", "target"]) {
        return false;
    }
    let Some(Any::Map(source)) = transfer.get("source") else {
        return false;
    };
    if !keys(source, &["client", "clock", "length", "boundary"])
        || !id(source)
        || !source
            .get("length")
            .is_some_and(|n| number(n, 1, MAX_CLOCK).is_some())
        || !boundary(source)
    {
        return false;
    }
    match transfer.get("target") {
        Some(Any::Null) => true,
        Some(Any::Map(target)) => {
            keys(
                target,
                &["client", "clock", "type", "tname", "assoc", "boundary"],
            ) && id(target)
                && boundary(target)
                && match target.get("type") {
                    Some(Any::Null) => true,
                    Some(Any::Map(kind)) => keys(kind, &["client", "clock"]) && id(kind),
                    _ => false,
                }
                && target.get("tname").is_none_or(
                    |name| matches!(name, Any::String(name) if name.as_ref() == "default"),
                )
                && target
                    .get("assoc")
                    .is_none_or(|n| number(n, -1, 1).is_some())
        }
        _ => false,
    }
}

fn migration(key: &str, entry: &HashMap<String, Any>) -> bool {
    let (Some(client), Some(clock)) = (
        field(entry, "client", MAX_CLIENT),
        field(entry, "clock", MAX_CLOCK),
    ) else {
        return false;
    };
    keys(entry, &["version", "client", "clock", "seen", "transfers"])
        && key == format!("{client}:{clock}")
        && entry
            .get("version")
            .is_some_and(|n| number(n, 1, 1).is_some())
        && matches!(entry.get("seen"), Some(Any::Array(seen)) if seen.iter().all(|pair| {
            matches!(pair, Any::Array(pair) if pair.len() == 2
                && number(&pair[0], 0, MAX_CLIENT).is_some()
                && number(&pair[1], 0, MAX_CLOCK).is_some())
        }))
        && matches!(entry.get("transfers"), Some(Any::Array(transfers)) if !transfers.is_empty() && transfers.iter().all(transfer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Transact, XmlElementPrelim};

    fn replay(bytes: &[u8]) -> yrs::Doc {
        use yrs::updates::decoder::Decode;
        let doc = write_doc::ydoc::new_ydoc(19);
        doc.transact_mut()
            .apply_update(yrs::Update::decode_v1(bytes).unwrap())
            .unwrap();
        doc
    }

    #[test]
    fn real_browser_enter_and_bold_proposals_are_valid() {
        // Full states captured from the real Tiptap WebSocket, containing synthetic test text.
        for (before, after) in [
            (
                include_bytes!("fixtures/split-before.yjs").as_slice(),
                include_bytes!("fixtures/split-after.yjs").as_slice(),
            ),
            (
                include_bytes!("fixtures/proposal-before.yjs").as_slice(),
                include_bytes!("fixtures/proposal-after.yjs").as_slice(),
            ),
        ] {
            let before = replay(before);
            let after = replay(after);
            assert!(super::super::validate(&before).is_ok());
            assert!(super::super::validate(&after).is_ok());
            let author = "61b57673-3c96-4908-b532-fe976d767557";
            assert!(!super::super::foreign_suggestions(&before, &after, author));
            assert!(!super::super::unmodeled_changes(&before, &after, author));
            assert!(!super::super::new_code_marks(&before, &after));
        }
    }

    #[test]
    fn malformed_or_hidden_migration_content_is_rejected() {
        let valid = serde_json::json!({
            "version":1,"client":1,"clock":5,"seen":[[1,5]],
            "transfers":[{"source":{"client":1,"clock":0,"length":1,"boundary":"end"},
                "target":{"client":1,"clock":4,"type":null,"boundary":"end"}}]
        });
        let accepts = |key: &str, value: &serde_json::Value| {
            let doc = write_doc::ydoc::new_ydoc(1);
            doc.get_or_insert_map(ROOT).insert(
                &mut doc.transact_mut(),
                key,
                Any::from_json(&value.to_string()).unwrap(),
            );
            super::super::validate(&doc).is_ok()
        };
        assert!(accepts("1:5", &valid));
        assert!(!accepts("2:5", &valid));
        for pointer in [
            "/version",
            "/client",
            "/clock",
            "/seen/0/1",
            "/transfers/0/source/length",
            "/transfers/0/target/type",
            "/transfers/0/target/boundary",
        ] {
            let mut invalid = valid.clone();
            *invalid.pointer_mut(pointer).unwrap() = serde_json::json!("invalid");
            assert!(!accepts("1:5", &invalid), "{pointer}");
        }
        let mut extra = valid.clone();
        extra["content"] = serde_json::json!("hidden");
        assert!(!accepts("1:5", &extra));
        let doc = replay(include_bytes!("fixtures/split-after.yjs"));
        doc.get_or_insert_xml_fragment(ROOT).insert(
            &mut doc.transact_mut(),
            0,
            XmlElementPrelim::empty("paragraph"),
        );
        assert!(super::super::validate(&doc).is_err());
    }
}
