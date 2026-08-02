//! scene.bin encoding — a port of `serialization.ts`.
//! 'PFRM' magic + format byte 0x01 + MessagePack payload
//! `{ schemaVersion, savedAt, doc }`.
//!
//! Byte-identity with @msgpack/msgpack holds because both sides encode
//! minimal-size ints, float64 for fractional numbers, and maps in insertion
//! order (serde_json `preserve_order`). `savedAt` is host-injected so output
//! is deterministic (same philosophy as host-side `newId`). Known corner: a
//! JS document holding `-0` encodes as float64 there but parses from JSON as
//! integer 0 here — JSON-normalized documents never carry -0.

use serde_json::{Map, Value};

pub const MAGIC: [u8; 4] = [0x50, 0x46, 0x52, 0x4d]; // "PFRM"
pub const FORMAT_MSGPACK: u8 = 1;
pub const SCHEMA_VERSION: u64 = 4;

#[derive(Debug)]
pub enum SceneDecodeError {
    Truncated,
    BadMagic,
    BadFormat(u8),
    Malformed(String),
    TooNew(u64),
}

impl std::fmt::Display for SceneDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SceneDecodeError::Truncated => write!(f, "scene.bin is truncated"),
            SceneDecodeError::BadMagic => write!(f, "scene.bin has an unknown magic header"),
            SceneDecodeError::BadFormat(b) => write!(f, "Unsupported scene.bin format byte: {b}"),
            SceneDecodeError::Malformed(m) => write!(f, "scene.bin payload is malformed: {m}"),
            SceneDecodeError::TooNew(v) => write!(
                f,
                "Project schema v{v} is newer than this build supports (v{SCHEMA_VERSION})"
            ),
        }
    }
}

pub fn encode_scene(doc: &Value, saved_at: &str) -> Vec<u8> {
    let mut payload_map = Map::new();
    payload_map.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
    payload_map.insert("savedAt".into(), Value::String(saved_at.to_string()));
    payload_map.insert("doc".into(), doc.clone());
    let payload =
        rmp_serde::to_vec_named(&Value::Object(payload_map)).expect("document serializes");
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&MAGIC);
    out.push(FORMAT_MSGPACK);
    out.extend_from_slice(&payload);
    out
}

pub fn decode_scene(bytes: &[u8]) -> Result<Value, SceneDecodeError> {
    if bytes.len() < 6 {
        return Err(SceneDecodeError::Truncated);
    }
    if bytes[0..4] != MAGIC {
        return Err(SceneDecodeError::BadMagic);
    }
    if bytes[4] != FORMAT_MSGPACK {
        return Err(SceneDecodeError::BadFormat(bytes[4]));
    }
    let payload: Value = rmp_serde::from_slice(&bytes[5..])
        .map_err(|e| SceneDecodeError::Malformed(e.to_string()))?;
    let obj = payload
        .as_object()
        .ok_or_else(|| SceneDecodeError::Malformed("payload is not a map".into()))?;
    let version = obj.get("schemaVersion").and_then(Value::as_u64).unwrap_or(0);
    if version > SCHEMA_VERSION {
        return Err(SceneDecodeError::TooNew(version));
    }
    let doc = obj
        .get("doc")
        .cloned()
        .ok_or_else(|| SceneDecodeError::Malformed("missing doc".into()))?;
    if !doc.is_object() || doc.get("nodes").is_none() {
        return Err(SceneDecodeError::Malformed("document is missing nodes".into()));
    }
    Ok(migrate_document(doc))
}

/// Upgrade any older document shape to the current schema in place.
/// Mirrors serialization.ts `migrateDocument`, except the v1 fallback page id
/// is deterministic ("page-1") where TS generates a random id — semantically
/// equivalent; parity gates compare v1 migrations with ids masked.
pub fn migrate_document(mut doc: Value) -> Value {
    let obj = doc.as_object_mut().expect("document is an object");

    let pages_ok = obj
        .get("pages")
        .and_then(Value::as_array)
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if !pages_ok {
        let root_ids = obj.get("rootIds").cloned().unwrap_or_else(|| Value::Array(Vec::new()));
        let root_ids = if root_ids.is_array() { root_ids } else { Value::Array(Vec::new()) };
        let mut page = Map::new();
        page.insert("id".into(), Value::String("page-1".into()));
        page.insert("name".into(), Value::String("Page 1".into()));
        page.insert("rootIds".into(), root_ids);
        page.insert("guides".into(), Value::Array(Vec::new()));
        page.insert("viewport".into(), Value::Null);
        obj.insert("pages".into(), Value::Array(vec![Value::Object(page)]));
        obj.insert("activePageId".into(), Value::String("page-1".into()));
        obj.remove("rootIds");
    }
    if let Some(pages) = obj.get_mut("pages").and_then(Value::as_array_mut) {
        for page in pages.iter_mut() {
            if let Some(p) = page.as_object_mut() {
                if !p.get("rootIds").map(Value::is_array).unwrap_or(false) {
                    p.insert("rootIds".into(), Value::Array(Vec::new()));
                }
                if !p.get("guides").map(Value::is_array).unwrap_or(false) {
                    p.insert("guides".into(), Value::Array(Vec::new()));
                }
            }
        }
    }
    let active_ok = {
        let active = obj.get("activePageId").and_then(Value::as_str).unwrap_or("");
        !active.is_empty()
            && obj
                .get("pages")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter().any(|p| p.get("id").and_then(Value::as_str) == Some(active))
                })
                .unwrap_or(false)
    };
    if !active_ok {
        let first = obj
            .get("pages")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|p| p.get("id").and_then(Value::as_str))
            .unwrap_or("page-1")
            .to_string();
        obj.insert("activePageId".into(), Value::String(first));
    }
    let styles_is_obj = obj.get("styles").map(Value::is_object).unwrap_or(false);
    if !styles_is_obj {
        let mut styles = Map::new();
        styles.insert("colors".into(), Value::Array(Vec::new()));
        styles.insert("texts".into(), Value::Array(Vec::new()));
        styles.insert("effects".into(), Value::Array(Vec::new()));
        obj.insert("styles".into(), Value::Object(styles));
    } else if let Some(styles) = obj.get_mut("styles").and_then(Value::as_object_mut) {
        for key in ["colors", "texts", "effects"] {
            if !styles.get(key).map(Value::is_array).unwrap_or(false) {
                styles.insert(key.into(), Value::Array(Vec::new()));
            }
        }
    }
    if !obj.get("libraries").map(Value::is_array).unwrap_or(false) {
        obj.insert("libraries".into(), Value::Array(Vec::new()));
    }
    // v4: the MODEL3D node type (ADR-020). Purely additive — v3 documents
    // contain no such nodes, so nothing needs rewriting.
    obj.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
    doc
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_preserves_document() {
        let doc = json!({
            "schemaVersion": 4,
            "nodes": { "r1": { "id": "r1", "type": "RECTANGLE", "x": 0.5, "width": 100 } },
            "pages": [{ "id": "p1", "name": "Page 1", "rootIds": ["r1"], "guides": [], "viewport": null }],
            "activePageId": "p1",
            "styles": { "colors": [], "texts": [], "effects": [] },
            "libraries": []
        });
        let bytes = encode_scene(&doc, "2026-08-01T00:00:00.000Z");
        assert_eq!(&bytes[0..4], &MAGIC);
        assert_eq!(bytes[4], FORMAT_MSGPACK);
        let decoded = decode_scene(&bytes).unwrap();
        assert_eq!(decoded, doc);
    }

    #[test]
    fn migrates_v1_single_page() {
        let doc = json!({
            "schemaVersion": 1,
            "nodes": {},
            "rootIds": ["a", "b"]
        });
        let migrated = migrate_document(doc);
        assert_eq!(migrated["schemaVersion"], json!(4));
        assert_eq!(migrated["pages"][0]["rootIds"], json!(["a", "b"]));
        assert_eq!(migrated["activePageId"], migrated["pages"][0]["id"]);
        assert!(migrated.get("rootIds").is_none());
        assert_eq!(migrated["styles"]["colors"], json!([]));
        assert_eq!(migrated["libraries"], json!([]));
    }

    #[test]
    fn rejects_bad_headers() {
        assert!(matches!(decode_scene(&[0, 1]), Err(SceneDecodeError::Truncated)));
        assert!(matches!(
            decode_scene(&[1, 2, 3, 4, 1, 0x80]),
            Err(SceneDecodeError::BadMagic)
        ));
        let mut bytes = MAGIC.to_vec();
        bytes.push(9);
        bytes.push(0x80);
        assert!(matches!(decode_scene(&bytes), Err(SceneDecodeError::BadFormat(9))));
    }
}
