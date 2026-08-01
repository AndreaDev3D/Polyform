//! Derived-state passes — a port of `layout.ts` minus text auto-resize,
//! which stays host-side until the HarfBuzz stack lands (Sprint E): the host
//! interleaves its text pass with this loop when driving the Rust engine.
//! All computed numbers go through `json_num` so integral results serialize
//! exactly like JS numbers (msgpack ints, "5" not "5.0" in canonical JSON).

use serde_json::{Map, Value};

use crate::components::{collect_garbage, json_num, sync_instances};
use crate::geometry::{aabb_of_points, apply_mat, node_local_matrix, vec2, Vec2};
use crate::hit_test::boolean_rings;
use crate::scene::SceneGraph;

type Obj = Map<String, Value>;

const EPS: f64 = 0.01;

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < EPS
}

fn f64_of(obj: &Obj, key: &str) -> f64 {
    obj.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn str_of<'a>(obj: &'a Obj, key: &str) -> &'a str {
    obj.get(key).and_then(Value::as_str).unwrap_or("")
}

fn bool_of(obj: &Obj, key: &str, default: bool) -> bool {
    obj.get(key).and_then(Value::as_bool).unwrap_or(default)
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

fn is_frame_like_type(t: &str) -> bool {
    matches!(t, "FRAME" | "COMPONENT" | "INSTANCE")
}

struct LayoutSpec {
    horizontal: bool,
    gap: f64,
    pad_top: f64,
    pad_right: f64,
    pad_bottom: f64,
    pad_left: f64,
    counter_align: String,
    primary_sizing: String,
    counter_sizing: String,
}

fn layout_spec(frame: &Obj) -> Option<LayoutSpec> {
    let l = frame.get("layout")?.as_object()?;
    let mode = str_of(l, "mode");
    if mode == "NONE" {
        return None;
    }
    Some(LayoutSpec {
        horizontal: mode == "HORIZONTAL",
        gap: f64_of(l, "gap"),
        pad_top: f64_of(l, "paddingTop"),
        pad_right: f64_of(l, "paddingRight"),
        pad_bottom: f64_of(l, "paddingBottom"),
        pad_left: f64_of(l, "paddingLeft"),
        counter_align: str_of(l, "counterAlign").to_string(),
        primary_sizing: str_of(l, "primarySizing").to_string(),
        counter_sizing: str_of(l, "counterSizing").to_string(),
    })
}

fn layout_frame(scene: &mut SceneGraph, frame_id: &str) -> bool {
    let Some(frame) = scene.get_node(frame_id) else { return false };
    let Some(l) = layout_spec(frame) else { return false };
    let mut changed = false;

    let children: Vec<(String, f64, f64)> = children_of(frame)
        .into_iter()
        .filter_map(|cid| {
            let n = scene.get_node(&cid)?;
            if !bool_of(n, "visible", true) {
                return None;
            }
            Some((cid, f64_of(n, "width"), f64_of(n, "height")))
        })
        .collect();

    let mut primary = if l.horizontal { l.pad_left } else { l.pad_top };
    let mut max_counter = 0.0f64;
    for (_, w, h) in &children {
        let primary_size = if l.horizontal { *w } else { *h };
        let counter_size = if l.horizontal { *h } else { *w };
        max_counter = max_counter.max(counter_size);
        primary += primary_size + l.gap;
    }
    if !children.is_empty() {
        primary -= l.gap;
    }
    primary += if l.horizontal { l.pad_right } else { l.pad_bottom };

    let counter_pad_start = if l.horizontal { l.pad_top } else { l.pad_left };
    let counter_pad_end = if l.horizontal { l.pad_bottom } else { l.pad_right };

    // Hug sizing.
    let (mut fw, mut fh) = {
        let f = scene.get_node(frame_id).expect("frame exists");
        (f64_of(f, "width"), f64_of(f, "height"))
    };
    if l.primary_sizing == "HUG" {
        let pads = if l.horizontal { l.pad_left + l.pad_right } else { l.pad_top + l.pad_bottom };
        let target = primary.max(pads);
        let current = if l.horizontal { fw } else { fh };
        if !near(current, target) {
            let frame = scene.get_node_mut(frame_id).expect("frame exists");
            if l.horizontal {
                frame.insert("width".into(), json_num(target));
                fw = target;
            } else {
                frame.insert("height".into(), json_num(target));
                fh = target;
            }
            changed = true;
        }
    }
    if l.counter_sizing == "HUG" {
        let target = max_counter + counter_pad_start + counter_pad_end;
        let current = if l.horizontal { fh } else { fw };
        if !near(current, target) {
            let frame = scene.get_node_mut(frame_id).expect("frame exists");
            if l.horizontal {
                frame.insert("height".into(), json_num(target));
                fh = target;
            } else {
                frame.insert("width".into(), json_num(target));
                fw = target;
            }
            changed = true;
        }
    }

    // Position children.
    let counter_space =
        (if l.horizontal { fh } else { fw }) - counter_pad_start - counter_pad_end;
    let mut cursor = if l.horizontal { l.pad_left } else { l.pad_top };
    for (cid, w, h) in &children {
        let counter_size = if l.horizontal { *h } else { *w };
        let mut counter_pos = counter_pad_start;
        if l.counter_align == "CENTER" {
            counter_pos = counter_pad_start + (counter_space - counter_size) / 2.0;
        } else if l.counter_align == "MAX" {
            counter_pos = counter_pad_start + counter_space - counter_size;
        }
        let nx = if l.horizontal { cursor } else { counter_pos };
        let ny = if l.horizontal { counter_pos } else { cursor };
        let (cx, cy) = {
            let c = scene.get_node(cid).expect("child exists");
            (f64_of(c, "x"), f64_of(c, "y"))
        };
        if !near(cx, nx) || !near(cy, ny) {
            let c = scene.get_node_mut(cid).expect("child exists");
            c.insert("x".into(), json_num(nx));
            c.insert("y".into(), json_num(ny));
            changed = true;
        }
        cursor += (if l.horizontal { *w } else { *h }) + l.gap;
    }
    changed
}

fn layout_frames(scene: &mut SceneGraph, id: &str) -> bool {
    let Some(node) = scene.get_node(id) else { return false };
    let t = str_of(node, "type").to_string();
    let children = children_of(node);
    let mut changed = false;
    if is_container_type(&t) {
        for cid in children {
            changed = layout_frames(scene, &cid) || changed;
        }
    }
    if is_frame_like_type(&t) {
        changed = layout_frame(scene, id) || changed;
    }
    changed
}

/// Shift children by (-minX, -minY) and grow the container to fit — the
/// shared tail of both normalize branches.
fn apply_normalize(
    scene: &mut SceneGraph,
    id: &str,
    children: &[String],
    min_x: f64,
    min_y: f64,
    w: f64,
    h: f64,
) {
    for cid in children {
        let Some(c) = scene.get_node_mut(cid) else { continue };
        let cx = f64_of(c, "x");
        let cy = f64_of(c, "y");
        c.insert("x".into(), json_num(cx - min_x));
        c.insert("y".into(), json_num(cy - min_y));
    }
    let node = scene.get_node_mut(id).expect("node exists");
    let nx = f64_of(node, "x");
    let ny = f64_of(node, "y");
    node.insert("x".into(), json_num(nx + min_x));
    node.insert("y".into(), json_num(ny + min_y));
    node.insert("width".into(), json_num(w));
    node.insert("height".into(), json_num(h));
}

fn normalize_containers(scene: &mut SceneGraph, id: &str) -> bool {
    let Some(node) = scene.get_node(id) else { return false };
    let t = str_of(node, "type").to_string();
    let children = children_of(node);
    let mut changed = false;
    if is_container_type(&t) {
        for cid in &children {
            changed = normalize_containers(scene, cid) || changed;
        }
    }
    let rotation = scene.get_node(id).map(|n| f64_of(n, "rotation")).unwrap_or(0.0);
    if (t == "GROUP" || t == "BOOLEAN") && rotation == 0.0 {
        if t == "BOOLEAN" {
            let rings = boolean_rings(scene, id);
            if !rings.is_empty() {
                let pts: Vec<Vec2> = rings.into_iter().flatten().collect();
                let bounds = aabb_of_points(&pts);
                let w = (bounds.max_x - bounds.min_x).max(1.0);
                let h = (bounds.max_y - bounds.min_y).max(1.0);
                let node = scene.get_node(id).expect("node exists");
                if !near(bounds.min_x, 0.0)
                    || !near(bounds.min_y, 0.0)
                    || !near(f64_of(node, "width"), w)
                    || !near(f64_of(node, "height"), h)
                {
                    apply_normalize(scene, id, &children, bounds.min_x, bounds.min_y, w, h);
                    changed = true;
                }
            }
        } else if !children.is_empty() {
            let mut pts: Vec<Vec2> = Vec::new();
            for cid in &children {
                let Some(c) = scene.get_node(cid) else { continue };
                if !bool_of(c, "visible", true) {
                    continue;
                }
                let (cx, cy, cw, ch, cr) = (
                    f64_of(c, "x"),
                    f64_of(c, "y"),
                    f64_of(c, "width"),
                    f64_of(c, "height"),
                    f64_of(c, "rotation"),
                );
                let m = node_local_matrix(cx, cy, cw, ch, cr);
                pts.push(apply_mat(m, vec2(0.0, 0.0)));
                pts.push(apply_mat(m, vec2(cw, 0.0)));
                pts.push(apply_mat(m, vec2(cw, ch)));
                pts.push(apply_mat(m, vec2(0.0, ch)));
            }
            if !pts.is_empty() {
                let bounds = aabb_of_points(&pts);
                let w = (bounds.max_x - bounds.min_x).max(1.0);
                let h = (bounds.max_y - bounds.min_y).max(1.0);
                let node = scene.get_node(id).expect("node exists");
                if !near(bounds.min_x, 0.0)
                    || !near(bounds.min_y, 0.0)
                    || !near(f64_of(node, "width"), w)
                    || !near(f64_of(node, "height"), h)
                {
                    apply_normalize(scene, id, &children, bounds.min_x, bounds.min_y, w, h);
                    changed = true;
                }
            }
        }
    }
    changed
}

/// The derived-pass fixpoint loop (layout.ts runDerivedPasses) WITHOUT the
/// text auto-resize pass — the host owns text measurement until Sprint E.
pub fn run_derived_passes(scene: &mut SceneGraph, mint: &mut dyn FnMut() -> String) -> bool {
    let mut changed_any = false;
    for _ in 0..5 {
        let mut changed = false;
        changed = sync_instances(scene, mint) || changed;
        for rid in scene.root_ids() {
            changed = layout_frames(scene, &rid) || changed;
        }
        for rid in scene.root_ids() {
            changed = normalize_containers(scene, &rid) || changed;
        }
        if changed {
            scene.bump();
            changed_any = true;
        } else {
            break;
        }
    }
    if collect_garbage(scene) {
        scene.bump();
        changed_any = true;
    }
    changed_any
}
