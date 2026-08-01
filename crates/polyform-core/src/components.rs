//! Components & instances — a port of `components.ts` (materialized
//! instances, ADR-012). The sync hash uses canonical JSON (sorted keys,
//! JS-compatible number rendering) so TS and Rust compute identical
//! staleness; materialized ids come from an injected mint function
//! ("newId stays host-side").

use serde_json::{Map, Value};

use crate::constraints::{constrain_frame_children, ChildRect};
use crate::scene::SceneGraph;

type Obj = Map<String, Value>;

const STRUCTURAL_KEYS: [&str; 8] = [
    "id",
    "type",
    "children",
    "sourceId",
    "componentId",
    "overrides",
    "syncedHash",
    "origin",
];

pub const ROOT_INHERITED_KEYS: [&str; 9] = [
    "fills",
    "strokes",
    "strokeWeight",
    "strokeAlign",
    "strokeDash",
    "effects",
    "cornerRadius",
    "clipsContent",
    "layout",
];

fn f64_of(obj: &Obj, key: &str) -> f64 {
    obj.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn str_of<'a>(obj: &'a Obj, key: &str) -> &'a str {
    obj.get(key).and_then(Value::as_str).unwrap_or("")
}

fn children_of(node: &Obj) -> Vec<String> {
    node.get("children")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default()
}

fn is_container_type(t: &str) -> bool {
    matches!(t, "FRAME" | "GROUP" | "BOOLEAN" | "COMPONENT" | "INSTANCE")
}

/// JS-compatible number in a JSON tree: integral doubles become JSON
/// integers (JS has one number type and renders 5.0 as "5").
pub fn json_num(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9007199254740992.0 {
        Value::from(v as i64)
    } else {
        serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
    }
}

// ---------------------------------------------------------------------------
// Canonical JSON (mirrors components.ts stableStringify)
// ---------------------------------------------------------------------------

fn write_stable(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else {
                // Rust f64 Display = shortest round-trip without exponent,
                // matching JS String(n) for the value ranges documents hold.
                let f = n.as_f64().unwrap_or(0.0);
                out.push_str(&format!("{f}"));
            }
        }
        Value::String(s) => {
            out.push_str(&serde_json::to_string(s).expect("string serializes"));
        }
        Value::Array(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_stable(item, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            out.push('{');
            let mut first = true;
            for k in keys {
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&serde_json::to_string(k).expect("key serializes"));
                out.push(':');
                write_stable(&o[k], out);
            }
            out.push('}');
        }
    }
}

pub fn stable_stringify(v: &Value) -> String {
    let mut out = String::new();
    write_stable(v, &mut out);
    out
}

/// djb2 over UTF-16 code units, base-36 — identical to the TS hashString.
fn hash_string(s: &str) -> String {
    let mut h: i32 = 5381;
    for unit in s.encode_utf16() {
        h = h.wrapping_shl(5).wrapping_add(h).wrapping_add(unit as i32);
    }
    let mut n = h as u32;
    if n == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 is ascii")
}

pub fn instance_sync_hash(scene: &SceneGraph, inst_id: &str, comp_id: &str) -> String {
    let inst = scene.get_node(inst_id).expect("instance exists");
    let comp = scene.get_node(comp_id).expect("component exists");
    let mut parts: Vec<Value> = vec![
        Value::String(comp_id.to_string()),
        inst.get("width").cloned().unwrap_or(Value::Null),
        inst.get("height").cloned().unwrap_or(Value::Null),
        inst.get("overrides").cloned().unwrap_or_else(|| Value::Object(Obj::new())),
    ];
    parts.push(Value::Object(comp.clone()));
    fn walk(scene: &SceneGraph, id: &str, parts: &mut Vec<Value>) {
        let Some(n) = scene.get_node(id) else { return };
        parts.push(Value::Object(n.clone()));
        if is_container_type(str_of(n, "type")) {
            for cid in children_of(n) {
                walk(scene, &cid, parts);
            }
        }
    }
    for cid in children_of(comp) {
        walk(scene, &cid, &mut parts);
    }
    hash_string(&stable_stringify(&Value::Array(parts)))
}

fn would_cycle(scene: &SceneGraph, inst_id: &str, component_id: &str) -> bool {
    let mut chain = vec![inst_id.to_string()];
    chain.extend(scene.ancestors(inst_id));
    for aid in chain {
        let Some(a) = scene.get_node(&aid) else { continue };
        let t = str_of(a, "type");
        if t == "COMPONENT" && aid == component_id {
            return true;
        }
        if t == "INSTANCE" && aid != inst_id && str_of(a, "componentId") == component_id {
            return true;
        }
    }
    false
}

fn sanitize_override(props: &Obj) -> Obj {
    let mut out = Obj::new();
    for (k, v) in props {
        if !STRUCTURAL_KEYS.contains(&k.as_str()) {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

/// Pre-order descendants of a node (excluding itself).
fn descendants(scene: &SceneGraph, id: &str) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(scene: &SceneGraph, id: &str, out: &mut Vec<String>) {
        let Some(n) = scene.get_node(id) else { return };
        if is_container_type(str_of(n, "type")) {
            for cid in children_of(n) {
                out.push(cid.clone());
                walk(scene, &cid, out);
            }
        }
    }
    walk(scene, id, &mut out);
    out
}

fn materialize_instance(
    scene: &mut SceneGraph,
    inst_id: &str,
    comp_id: &str,
    mint: &mut dyn FnMut() -> String,
) {
    use std::collections::HashMap;
    let mut existing_by_source: HashMap<String, String> = HashMap::new();
    for did in descendants(scene, inst_id) {
        if let Some(n) = scene.get_node(&did) {
            if let Some(src) = n.get("sourceId").and_then(Value::as_str) {
                existing_by_source.insert(src.to_string(), did.clone());
            }
        }
    }
    let old_descendants = descendants(scene, inst_id);
    for did in old_descendants.iter().rev() {
        scene.remove_node(did);
    }

    let overrides: Obj = scene
        .get_node(inst_id)
        .and_then(|i| i.get("overrides"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // Recursive build; comp children first.
    fn build(
        scene: &mut SceneGraph,
        src_id: &str,
        parent_id: &str,
        index: usize,
        overrides: &Obj,
        existing: &std::collections::HashMap<String, String>,
        mint: &mut dyn FnMut() -> String,
    ) {
        let Some(src) = scene.get_node(src_id).cloned() else { return };
        let mut copy = src.clone();
        let new_id = existing.get(src_id).cloned().unwrap_or_else(|| mint());
        copy.insert("id".into(), Value::String(new_id.clone()));
        copy.insert("sourceId".into(), Value::String(src_id.to_string()));
        let t = str_of(&copy, "type").to_string();
        if is_container_type(&t) {
            copy.insert("children".into(), Value::Array(Vec::new()));
        }
        let t = if t == "COMPONENT" {
            copy.insert("type".into(), Value::String("FRAME".into()));
            "FRAME".to_string()
        } else {
            t
        };
        if t == "INSTANCE" {
            if !copy.get("overrides").map(Value::is_object).unwrap_or(false) {
                copy.insert("overrides".into(), Value::Object(Obj::new()));
            }
            // JS sets syncedHash = undefined (invisible to JSON) — remove.
            copy.remove("syncedHash");
        }
        if let Some(ov) = overrides.get(src_id).and_then(Value::as_object) {
            for (k, v) in sanitize_override(ov) {
                copy.insert(k, v);
            }
        }
        scene.add_node(Value::Object(copy), Some(parent_id), index);
        // Nested instances materialize themselves on their own sync turn.
        if is_container_type(str_of(&src, "type")) && str_of(&src, "type") != "INSTANCE" {
            for (i, cid) in children_of(&src).iter().enumerate() {
                build(scene, cid, &new_id, i, overrides, existing, mint);
            }
        }
    }

    let comp = scene.get_node(comp_id).cloned().expect("component exists");
    for (i, cid) in children_of(&comp).iter().enumerate() {
        build(scene, cid, inst_id, i, &overrides, &existing_by_source, mint);
    }

    // Instance root inherits the component's visual props, then root overrides.
    let mut root_props: Vec<(String, Value)> = Vec::new();
    for key in ROOT_INHERITED_KEYS {
        root_props.push((key.to_string(), comp.get(key).cloned().unwrap_or(Value::Null)));
    }
    let root_ov = overrides.get(comp_id).and_then(Value::as_object).map(sanitize_override);
    {
        let inst = scene.get_node_mut(inst_id).expect("instance exists");
        for (k, v) in root_props {
            inst.insert(k, v);
        }
        if let Some(ov) = root_ov {
            for (k, v) in ov {
                inst.insert(k, v);
            }
        }
    }

    // Fit component-space children to the instance's size via constraints.
    let inst = scene.get_node(inst_id).expect("instance exists");
    let layout_none = inst
        .get("layout")
        .and_then(Value::as_object)
        .map(|l| str_of(l, "mode") == "NONE")
        .unwrap_or(true);
    let iw = f64_of(inst, "width");
    let ih = f64_of(inst, "height");
    let cw = f64_of(&comp, "width");
    let ch = f64_of(&comp, "height");
    if layout_none && ((iw - cw).abs() > 0.01 || (ih - ch).abs() > 0.01) {
        // Snapshot lookup: materialized child -> its SOURCE rect.
        let mut snaps: std::collections::HashMap<String, ChildRect> =
            std::collections::HashMap::new();
        let ids: Vec<String> = descendants(scene, inst_id);
        for cid in ids {
            let Some(child) = scene.get_node(&cid) else { continue };
            let Some(src_id) = child.get("sourceId").and_then(Value::as_str) else { continue };
            let Some(src) = scene.get_node(src_id) else { continue };
            snaps.insert(
                cid.clone(),
                ChildRect {
                    x: f64_of(src, "x"),
                    y: f64_of(src, "y"),
                    width: f64_of(src, "width"),
                    height: f64_of(src, "height"),
                },
            );
        }
        let snap = move |id: &str| snaps.get(id).copied();
        constrain_frame_children(scene, inst_id, &snap, cw, ch);
    }
}

/// Regenerate stale instances. Returns true when anything changed.
pub fn sync_instances(scene: &mut SceneGraph, mint: &mut dyn FnMut() -> String) -> bool {
    let mut changed = false;
    // Snapshot of instance ids (JS iterates an Object.values snapshot).
    let ids: Vec<String> = scene
        .doc
        .get("nodes")
        .and_then(Value::as_object)
        .map(|nodes| {
            nodes
                .iter()
                .filter(|(_, n)| {
                    n.as_object().map(|o| str_of(o, "type") == "INSTANCE").unwrap_or(false)
                })
                .map(|(id, _)| id.clone())
                .collect()
        })
        .unwrap_or_default();
    for id in ids {
        let Some(node) = scene.get_node(&id) else { continue };
        let comp_id = str_of(node, "componentId").to_string();
        if comp_id.is_empty() {
            continue;
        }
        let comp_is_component = scene
            .get_node(&comp_id)
            .map(|c| str_of(c, "type") == "COMPONENT")
            .unwrap_or(false);
        if !comp_is_component {
            continue; // detached-in-place
        }
        if would_cycle(scene, &id, &comp_id) {
            continue;
        }
        let hash = instance_sync_hash(scene, &id, &comp_id);
        let current = scene
            .get_node(&id)
            .and_then(|n| n.get("syncedHash"))
            .and_then(Value::as_str)
            .map(String::from);
        if current.as_deref() == Some(hash.as_str()) {
            continue;
        }
        materialize_instance(scene, &id, &comp_id, mint);
        let new_hash = instance_sync_hash(scene, &id, &comp_id);
        if let Some(inst) = scene.get_node_mut(&id) {
            inst.insert("syncedHash".into(), Value::String(new_hash));
        }
        changed = true;
    }
    changed
}

/// Remove nodes unreachable from any page. Returns true when any removed.
pub fn collect_garbage(scene: &mut SceneGraph) -> bool {
    use std::collections::HashSet;
    let mut reachable: HashSet<String> = HashSet::new();
    let all_roots: Vec<String> = scene
        .doc
        .get("pages")
        .and_then(Value::as_array)
        .map(|pages| {
            pages
                .iter()
                .filter_map(|p| p.get("rootIds").and_then(Value::as_array))
                .flat_map(|a| a.iter().filter_map(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    fn walk(scene: &SceneGraph, id: &str, reachable: &mut HashSet<String>) {
        if reachable.contains(id) {
            return;
        }
        reachable.insert(id.to_string());
        if let Some(n) = scene.get_node(id) {
            if is_container_type(str_of(n, "type")) {
                for cid in children_of(n) {
                    walk(scene, &cid, reachable);
                }
            }
        }
    }
    for rid in all_roots {
        walk(scene, &rid, &mut reachable);
    }
    let nodes = scene
        .doc
        .get_mut("nodes")
        .and_then(Value::as_object_mut)
        .expect("document has nodes");
    let before = nodes.len();
    nodes.retain(|id, _| reachable.contains(id));
    nodes.len() != before
}
