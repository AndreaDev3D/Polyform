//! SceneGraph + PatchOp command engine — a port of `scene.ts` and
//! `commands.ts` (V0.4-Porting-Plan P2, API contracts #1 and #2).
//!
//! Representation decision (documented in the porting plan): nodes and pages
//! live as schema-agnostic JSON trees (`serde_json::Value` with
//! `preserve_order`), manipulated through typed accessors. This guarantees
//! byte-exact document round-trips — unknown or future fields pass through
//! untouched, exactly what journal compatibility demands — and makes the
//! `update` op's shallow-merge semantics trivial. The fully-typed struct
//! model arrives with the Sprint C serialization work (rmp-serde), where the
//! type layer actually pays for itself.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::geometry::{
    aabb_expand, aabb_is_empty, aabb_of_points, aabb_union, apply_mat, empty_aabb, mat_multiply,
    node_local_matrix, transformed_rect_aabb, vec2, Aabb, Mat, Vec2, IDENTITY,
};
use crate::shapes::{flatten_sub_path, network_to_sub_paths, NetEdge, NetVertex};

type Obj = Map<String, Value>;

fn f64_of(obj: &Obj, key: &str) -> f64 {
    obj.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn str_of<'a>(obj: &'a Obj, key: &str) -> &'a str {
    obj.get(key).and_then(Value::as_str).unwrap_or("")
}

fn bool_of(obj: &Obj, key: &str, default: bool) -> bool {
    obj.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn is_container_type(t: &str) -> bool {
    matches!(t, "FRAME" | "GROUP" | "BOOLEAN" | "COMPONENT" | "INSTANCE")
}

fn is_frame_like_type(t: &str) -> bool {
    matches!(t, "FRAME" | "COMPONENT" | "INSTANCE")
}

fn children_ids(node: &Obj) -> Vec<String> {
    node.get("children")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default()
}

pub struct SceneGraph {
    pub doc: Value,
    /// child id -> parent id (node id or page id). Mirrors the TS map,
    /// including its non-cascading remove semantics.
    parents: HashMap<String, Option<String>>,
    pub version: u64,
}

impl SceneGraph {
    pub fn new(doc: Value) -> SceneGraph {
        let mut sg = SceneGraph { doc, parents: HashMap::new(), version: 0 };
        sg.rebuild_parents();
        sg
    }

    fn rebuild_parents(&mut self) {
        self.parents.clear();
        let mut entries: Vec<(String, Option<String>)> = Vec::new();
        if let Some(pages) = self.doc.get("pages").and_then(Value::as_array) {
            for page in pages {
                let pid = page.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                if let Some(roots) = page.get("rootIds").and_then(Value::as_array) {
                    for id in roots.iter().filter_map(Value::as_str) {
                        entries.push((id.to_string(), Some(pid.clone())));
                    }
                }
            }
        }
        if let Some(nodes) = self.doc.get("nodes").and_then(Value::as_object) {
            for (id, node) in nodes {
                if let Some(obj) = node.as_object() {
                    if is_container_type(str_of(obj, "type")) {
                        for cid in children_ids(obj) {
                            entries.push((cid, Some(id.clone())));
                        }
                    }
                }
            }
        }
        for (k, v) in entries {
            self.parents.insert(k, v);
        }
    }

    pub fn bump(&mut self) {
        self.version += 1;
    }

    // -----------------------------------------------------------------------
    // Pages
    // -----------------------------------------------------------------------

    fn pages(&self) -> &Vec<Value> {
        self.doc.get("pages").and_then(Value::as_array).expect("document has pages")
    }

    fn pages_mut(&mut self) -> &mut Vec<Value> {
        self.doc
            .get_mut("pages")
            .and_then(Value::as_array_mut)
            .expect("document has pages")
    }

    pub fn is_page(&self, id: &str) -> bool {
        self.pages().iter().any(|p| p.get("id").and_then(Value::as_str) == Some(id))
    }

    pub fn active_page_id(&self) -> String {
        let active = self.doc.get("activePageId").and_then(Value::as_str).unwrap_or("");
        if self.is_page(active) {
            active.to_string()
        } else {
            self.pages()
                .first()
                .and_then(|p| p.get("id").and_then(Value::as_str))
                .expect("document has no pages")
                .to_string()
        }
    }

    /// Root z-order of the ACTIVE page, bottom to top.
    pub fn root_ids(&self) -> Vec<String> {
        let active = self.active_page_id();
        self.pages()
            .iter()
            .find(|p| p.get("id").and_then(Value::as_str) == Some(active.as_str()))
            .and_then(|p| p.get("rootIds").and_then(Value::as_array))
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------

    pub fn get_node(&self, id: &str) -> Option<&Obj> {
        self.doc.get("nodes")?.get(id)?.as_object()
    }

    pub fn get_node_mut(&mut self, id: &str) -> Option<&mut Obj> {
        self.doc.get_mut("nodes")?.get_mut(id)?.as_object_mut()
    }

    pub fn parent_of(&self, id: &str) -> Option<String> {
        self.parents.get(id).cloned().flatten()
    }

    /// The child-id list for a node id, a page id, or None (= active page).
    fn child_list_mut(&mut self, parent_id: Option<&str>) -> &mut Vec<Value> {
        let resolved = match parent_id {
            None => self.active_page_id(),
            Some(p) => p.to_string(),
        };
        if self.is_page(&resolved) {
            let pages = self.pages_mut();
            let page = pages
                .iter_mut()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(resolved.as_str()))
                .expect("page exists");
            return page
                .get_mut("rootIds")
                .and_then(Value::as_array_mut)
                .expect("page has rootIds");
        }
        let node = self
            .doc
            .get_mut("nodes")
            .and_then(|n| n.get_mut(&resolved))
            .unwrap_or_else(|| panic!("Node not found: {resolved}"));
        node.get_mut("children")
            .and_then(Value::as_array_mut)
            .unwrap_or_else(|| panic!("Not a container: {resolved}"))
    }

    pub fn child_list(&self, parent_id: Option<&str>) -> Vec<String> {
        let resolved = match parent_id {
            None => self.active_page_id(),
            Some(p) => p.to_string(),
        };
        if self.is_page(&resolved) {
            return self
                .pages()
                .iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(resolved.as_str()))
                .and_then(|p| p.get("rootIds").and_then(Value::as_array))
                .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                .unwrap_or_default();
        }
        self.get_node(&resolved).map(|n| children_ids(n)).unwrap_or_default()
    }

    /// All ancestor NODE ids from the direct parent up to a page root.
    pub fn ancestors(&self, id: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = self.parent_of(id);
        while let Some(pid) = cur {
            if self.is_page(&pid) {
                break;
            }
            out.push(pid.clone());
            cur = self.parent_of(&pid);
        }
        out
    }

    pub fn is_ancestor_of(&self, maybe_ancestor: &str, id: &str) -> bool {
        self.ancestors(id).iter().any(|a| a == maybe_ancestor)
    }

    /// The page-root-level ancestor of a node (the node itself if at root).
    pub fn top_level_ancestor(&self, id: &str) -> String {
        let mut cur = id.to_string();
        loop {
            match self.parent_of(&cur) {
                Some(pid) if !self.is_page(&pid) => cur = pid,
                _ => return cur,
            }
        }
    }

    pub(crate) fn local_matrix_of(node: &Obj) -> Mat {
        Self::local_matrix(node)
    }

    // -----------------------------------------------------------------------
    // Mutations (mirror scene.ts exactly, including clamping)
    // -----------------------------------------------------------------------

    pub fn add_node(&mut self, node: Value, parent_id: Option<&str>, index: usize) {
        let obj = node.as_object().expect("node is an object");
        let id = str_of(obj, "id").to_string();
        if self.get_node(&id).is_some() {
            panic!("Duplicate node id: {id}");
        }
        let child_ids: Vec<String> = if is_container_type(str_of(obj, "type")) {
            children_ids(obj)
        } else {
            Vec::new()
        };
        let resolved = match parent_id {
            None => self.active_page_id(),
            Some(p) => p.to_string(),
        };
        self.doc
            .get_mut("nodes")
            .and_then(Value::as_object_mut)
            .expect("document has nodes")
            .insert(id.clone(), node);
        let list = self.child_list_mut(Some(&resolved));
        let i = index.min(list.len());
        list.insert(i, Value::String(id.clone()));
        self.parents.insert(id.clone(), Some(resolved));
        for cid in child_ids {
            self.parents.insert(cid, Some(id.clone()));
        }
        self.bump();
    }

    /// Detach a single node (children ops are the caller's responsibility).
    pub fn remove_node(&mut self, id: &str) {
        let parent = self.parent_of(id);
        let list = self.child_list_mut(parent.as_deref());
        if let Some(i) = list.iter().position(|v| v.as_str() == Some(id)) {
            list.remove(i);
        }
        self.doc
            .get_mut("nodes")
            .and_then(Value::as_object_mut)
            .expect("document has nodes")
            .remove(id);
        self.parents.remove(id);
        self.bump();
    }

    pub fn move_node(&mut self, id: &str, to_parent: Option<&str>, to_index: usize) {
        let from_parent = self.parent_of(id);
        let from_list = self.child_list_mut(from_parent.as_deref());
        if let Some(i) = from_list.iter().position(|v| v.as_str() == Some(id)) {
            from_list.remove(i);
        }
        let resolved = match to_parent {
            None => self.active_page_id(),
            Some(p) => p.to_string(),
        };
        let to_list = self.child_list_mut(Some(&resolved));
        let i = to_index.min(to_list.len());
        to_list.insert(i, Value::String(id.to_string()));
        self.parents.insert(id.to_string(), Some(resolved));
        self.bump();
    }

    /// Shallow merge, exactly like `Object.assign(node, patch)`.
    pub fn update_node(&mut self, id: &str, patch: &Obj) {
        let node = self
            .doc
            .get_mut("nodes")
            .and_then(|n| n.get_mut(id))
            .and_then(Value::as_object_mut)
            .unwrap_or_else(|| panic!("Node not found: {id}"));
        for (k, v) in patch {
            node.insert(k.clone(), v.clone());
        }
        self.bump();
    }

    // -----------------------------------------------------------------------
    // Transforms & bounds
    // -----------------------------------------------------------------------

    fn local_matrix(node: &Obj) -> Mat {
        node_local_matrix(
            f64_of(node, "x"),
            f64_of(node, "y"),
            f64_of(node, "width"),
            f64_of(node, "height"),
            f64_of(node, "rotation"),
        )
    }

    pub fn world_matrix(&self, id: &str) -> Mat {
        let Some(node) = self.get_node(id) else { return IDENTITY };
        let parent_mat = match self.parent_of(id) {
            Some(pid) if !self.is_page(&pid) => self.world_matrix(&pid),
            _ => IDENTITY,
        };
        mat_multiply(parent_mat, Self::local_matrix(node))
    }

    /// Extra padding for strokes and effects (scene.ts nodePad).
    fn node_pad(node: &Obj) -> f64 {
        let mut pad = 0.0f64;
        let any_stroke = node
            .get("strokes")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_object)
                    .any(|s| bool_of(s, "visible", false))
            })
            .unwrap_or(false);
        if any_stroke {
            let weight = f64_of(node, "strokeWeight");
            pad = match str_of(node, "strokeAlign") {
                "INSIDE" => 0.0,
                "CENTER" => weight / 2.0,
                _ => weight,
            };
        }
        if let Some(effects) = node.get("effects").and_then(Value::as_array) {
            for fx in effects.iter().filter_map(Value::as_object) {
                if !bool_of(fx, "visible", false) {
                    continue;
                }
                match str_of(fx, "type") {
                    "DROP_SHADOW" => {
                        let off = fx.get("offset").and_then(Value::as_object);
                        let ox = off.map(|o| f64_of(o, "x")).unwrap_or(0.0);
                        let oy = off.map(|o| f64_of(o, "y")).unwrap_or(0.0);
                        let blur = f64_of(fx, "blur");
                        pad = pad.max(ox.abs() + blur).max(oy.abs() + blur);
                    }
                    "LAYER_BLUR" => {
                        pad = pad.max(f64_of(fx, "radius") * 2.0);
                    }
                    _ => {}
                }
            }
        }
        pad
    }

    fn vector_outline_points(node: &Obj) -> Vec<Vec2> {
        let Some(network) = node.get("network").and_then(Value::as_object) else {
            return Vec::new();
        };
        let vertices: Vec<NetVertex> = network
            .get("vertices")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_object)
                    .map(|v| NetVertex { id: f64_of(v, "id"), x: f64_of(v, "x"), y: f64_of(v, "y") })
                    .collect()
            })
            .unwrap_or_default();
        let cp = |v: Option<&Value>| -> Option<Vec2> {
            v.and_then(Value::as_object).map(|o| vec2(f64_of(o, "x"), f64_of(o, "y")))
        };
        let edges: Vec<NetEdge> = network
            .get("edges")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_object)
                    .map(|e| NetEdge {
                        v0: f64_of(e, "v0"),
                        v1: f64_of(e, "v1"),
                        cp0: cp(e.get("cp0")),
                        cp1: cp(e.get("cp1")),
                    })
                    .collect()
            })
            .unwrap_or_default();
        network_to_sub_paths(&vertices, &edges)
            .iter()
            .flat_map(|sp| flatten_sub_path(sp, 1.0))
            .collect()
    }

    /// World-space AABB including descendants, strokes and effects.
    pub fn world_aabb(&self, id: &str) -> Aabb {
        let Some(node) = self.get_node(id) else { return empty_aabb() };
        let m = self.world_matrix(id);
        let node_type = str_of(node, "type").to_string();
        let mut aabb: Aabb;

        if node_type == "VECTOR" {
            let pts = Self::vector_outline_points(node);
            let local = if pts.is_empty() {
                Aabb {
                    min_x: 0.0,
                    min_y: 0.0,
                    max_x: f64_of(node, "width"),
                    max_y: f64_of(node, "height"),
                }
            } else {
                aabb_of_points(&pts)
            };
            let pad = Self::node_pad(node);
            aabb = aabb_of_points(&[
                apply_mat(m, vec2(local.min_x - pad, local.min_y - pad)),
                apply_mat(m, vec2(local.max_x + pad, local.min_y - pad)),
                apply_mat(m, vec2(local.max_x + pad, local.max_y + pad)),
                apply_mat(m, vec2(local.min_x - pad, local.max_y + pad)),
            ]);
        } else {
            let pad = Self::node_pad(node);
            aabb = transformed_rect_aabb(m, f64_of(node, "width"), f64_of(node, "height"));
            aabb = aabb_expand(aabb, pad);
        }

        if is_container_type(&node_type) && node_type != "BOOLEAN" {
            let clips = is_frame_like_type(&node_type) && bool_of(node, "clipsContent", false);
            if !clips {
                for cid in children_ids(node) {
                    let Some(child) = self.get_node(&cid) else { continue };
                    if !bool_of(child, "visible", true) {
                        continue;
                    }
                    let cb = self.world_aabb(&cid);
                    if !aabb_is_empty(cb) {
                        aabb = aabb_union(aabb, cb);
                    }
                }
            }
        }
        aabb
    }

    // -----------------------------------------------------------------------
    // Z-order
    // -----------------------------------------------------------------------

    /// Render order of the ACTIVE page: parents before children, roots
    /// bottom -> top; BOOLEAN children excluded.
    pub fn render_order(&self) -> Vec<String> {
        let mut out = Vec::new();
        fn walk(sg: &SceneGraph, id: &str, out: &mut Vec<String>) {
            let Some(node) = sg.get_node(id) else { return };
            out.push(id.to_string());
            let t = str_of(node, "type");
            if is_container_type(t) && t != "BOOLEAN" {
                for cid in children_ids(node) {
                    walk(sg, &cid, out);
                }
            }
        }
        for id in self.root_ids() {
            walk(self, &id, &mut out);
        }
        out
    }

    // -----------------------------------------------------------------------
    // PatchOp engine (commands.ts)
    // -----------------------------------------------------------------------

    pub fn apply_op(&mut self, op: &Value) {
        let obj = op.as_object().expect("op is an object");
        let kind = str_of(obj, "kind");
        match kind {
            "add" => {
                let node = obj.get("node").expect("add has node").clone();
                let parent = obj.get("parentId").and_then(Value::as_str).map(String::from);
                let index = f64_of(obj, "index").max(0.0) as usize;
                self.add_node(node, parent.as_deref(), index);
            }
            "remove" => {
                let id = obj
                    .get("node")
                    .and_then(Value::as_object)
                    .map(|n| str_of(n, "id").to_string())
                    .expect("remove has node.id");
                self.remove_node(&id);
            }
            "update" => {
                let id = str_of(obj, "id").to_string();
                let after = obj
                    .get("after")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                self.update_node(&id, &after);
            }
            "move" => {
                let id = str_of(obj, "id").to_string();
                let to = obj.get("to").and_then(Value::as_object).expect("move has to");
                let parent = to.get("parentId").and_then(Value::as_str).map(String::from);
                let index = f64_of(to, "index").max(0.0) as usize;
                self.move_node(&id, parent.as_deref(), index);
            }
            "page-add" => {
                let mut page = obj.get("page").expect("page-add has page").clone();
                if let Some(p) = page.as_object_mut() {
                    p.insert("rootIds".into(), Value::Array(Vec::new()));
                }
                let index = (f64_of(obj, "index").max(0.0) as usize).min(self.pages().len());
                self.pages_mut().insert(index, page);
                self.bump();
            }
            "page-remove" => {
                let pid = obj
                    .get("page")
                    .and_then(Value::as_object)
                    .map(|p| str_of(p, "id").to_string())
                    .expect("page-remove has page.id");
                let idx = self
                    .pages()
                    .iter()
                    .position(|p| p.get("id").and_then(Value::as_str) == Some(pid.as_str()));
                if let Some(idx) = idx {
                    self.pages_mut().remove(idx);
                    let active = self.doc.get("activePageId").and_then(Value::as_str).unwrap_or("");
                    if active == pid && !self.pages().is_empty() {
                        let i = idx.min(self.pages().len() - 1);
                        let new_active = self.pages()[i]
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        self.doc
                            .as_object_mut()
                            .expect("doc")
                            .insert("activePageId".into(), Value::String(new_active));
                    }
                }
                self.bump();
            }
            "page-rename" => {
                let pid = str_of(obj, "pageId").to_string();
                let after = obj.get("after").cloned().unwrap_or(Value::Null);
                for page in self.pages_mut() {
                    if page.get("id").and_then(Value::as_str) == Some(pid.as_str()) {
                        if let Some(p) = page.as_object_mut() {
                            p.insert("name".into(), after.clone());
                        }
                    }
                }
                self.bump();
            }
            "styles-set" => {
                let after = obj.get("after").cloned().unwrap_or(Value::Null);
                self.doc.as_object_mut().expect("doc").insert("styles".into(), after);
                self.bump();
            }
            other => panic!("Unknown op kind: {other}"),
        }
    }

    pub fn apply_ops(&mut self, ops: &[Value]) {
        for op in ops {
            self.apply_op(op);
        }
    }

    pub fn undo_ops(&mut self, ops: &[Value]) {
        for op in ops.iter().rev() {
            let inv = invert_op(op);
            self.apply_op(&inv);
        }
    }
}

pub fn invert_op(op: &Value) -> Value {
    let obj = op.as_object().expect("op is an object");
    let kind = str_of(obj, "kind");
    let mut out = Obj::new();
    match kind {
        "add" | "remove" => {
            out.insert(
                "kind".into(),
                Value::String(if kind == "add" { "remove".into() } else { "add".into() }),
            );
            out.insert("parentId".into(), obj.get("parentId").cloned().unwrap_or(Value::Null));
            out.insert("index".into(), obj.get("index").cloned().unwrap_or(Value::Null));
            out.insert("node".into(), obj.get("node").cloned().unwrap_or(Value::Null));
        }
        "update" => {
            out.insert("kind".into(), Value::String("update".into()));
            out.insert("id".into(), obj.get("id").cloned().unwrap_or(Value::Null));
            out.insert("before".into(), obj.get("after").cloned().unwrap_or(Value::Null));
            out.insert("after".into(), obj.get("before").cloned().unwrap_or(Value::Null));
        }
        "move" => {
            out.insert("kind".into(), Value::String("move".into()));
            out.insert("id".into(), obj.get("id").cloned().unwrap_or(Value::Null));
            out.insert("from".into(), obj.get("to").cloned().unwrap_or(Value::Null));
            out.insert("to".into(), obj.get("from").cloned().unwrap_or(Value::Null));
        }
        "page-add" | "page-remove" => {
            out.insert(
                "kind".into(),
                Value::String(if kind == "page-add" { "page-remove".into() } else { "page-add".into() }),
            );
            out.insert("index".into(), obj.get("index").cloned().unwrap_or(Value::Null));
            out.insert("page".into(), obj.get("page").cloned().unwrap_or(Value::Null));
        }
        "page-rename" => {
            out.insert("kind".into(), Value::String("page-rename".into()));
            out.insert("pageId".into(), obj.get("pageId").cloned().unwrap_or(Value::Null));
            out.insert("before".into(), obj.get("after").cloned().unwrap_or(Value::Null));
            out.insert("after".into(), obj.get("before").cloned().unwrap_or(Value::Null));
        }
        "styles-set" => {
            out.insert("kind".into(), Value::String("styles-set".into()));
            out.insert("before".into(), obj.get("after").cloned().unwrap_or(Value::Null));
            out.insert("after".into(), obj.get("before").cloned().unwrap_or(Value::Null));
        }
        other => panic!("Unknown op kind: {other}"),
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn empty_doc() -> Value {
        json!({
            "schemaVersion": 3,
            "nodes": {},
            "pages": [{ "id": "p1", "name": "Page 1", "rootIds": [], "guides": [], "viewport": null }],
            "activePageId": "p1",
            "styles": { "colors": [], "texts": [], "effects": [] }
        })
    }

    fn rect(id: &str, x: f64, y: f64, w: f64, h: f64) -> Value {
        json!({
            "id": id, "type": "RECTANGLE", "name": id,
            "visible": true, "locked": false, "opacity": 1, "blendMode": "NORMAL",
            "x": x, "y": y, "width": w, "height": h, "rotation": 0,
            "fills": [], "strokes": [], "strokeWeight": 1, "strokeAlign": "INSIDE",
            "strokeDash": [], "effects": [],
            "cornerRadius": { "tl": 0, "tr": 0, "br": 0, "bl": 0 }
        })
    }

    #[test]
    fn add_update_move_remove_roundtrip() {
        let mut sg = SceneGraph::new(empty_doc());
        let initial = sg.doc.clone();
        let ops = vec![
            json!({ "kind": "add", "parentId": "p1", "index": 0, "node": rect("r1", 0.0, 0.0, 100.0, 50.0) }),
            json!({ "kind": "update", "id": "r1", "before": { "x": 0.0 }, "after": { "x": 25.0 } }),
        ];
        sg.apply_ops(&ops);
        assert_eq!(sg.root_ids(), vec!["r1"]);
        assert_eq!(f64_of(sg.get_node("r1").unwrap(), "x"), 25.0);
        sg.undo_ops(&ops);
        assert_eq!(sg.doc, initial);
    }

    #[test]
    fn world_matrix_composes_through_parents() {
        let mut sg = SceneGraph::new(empty_doc());
        let mut frame = rect("f1", 10.0, 20.0, 200.0, 200.0);
        frame["type"] = json!("FRAME");
        frame["children"] = json!([]);
        frame["clipsContent"] = json!(true);
        sg.apply_op(&json!({ "kind": "add", "parentId": "p1", "index": 0, "node": frame }));
        sg.apply_op(&json!({ "kind": "add", "parentId": "f1", "index": 0, "node": rect("r1", 5.0, 6.0, 50.0, 50.0) }));
        let m = sg.world_matrix("r1");
        assert_eq!((m.e, m.f), (15.0, 26.0));
        // clipping frame ignores child bounds
        let fb = sg.world_aabb("f1");
        assert_eq!((fb.min_x, fb.min_y, fb.max_x, fb.max_y), (10.0, 20.0, 210.0, 220.0));
    }

    #[test]
    fn render_order_skips_boolean_children() {
        let mut sg = SceneGraph::new(empty_doc());
        let mut b = rect("b1", 0.0, 0.0, 10.0, 10.0);
        b["type"] = json!("BOOLEAN");
        b["children"] = json!([]);
        b["booleanOp"] = json!("UNION");
        sg.apply_op(&json!({ "kind": "add", "parentId": "p1", "index": 0, "node": b }));
        sg.apply_op(&json!({ "kind": "add", "parentId": "b1", "index": 0, "node": rect("r1", 0.0, 0.0, 5.0, 5.0) }));
        assert_eq!(sg.render_order(), vec!["b1"]);
    }
}
