//! Constraint resolution — a port of `src/renderer/src/engine/constraints.ts`.
//! Operates on JSON node trees (same representation as scene.rs); the scene
//! recursion (`constrain_frame_children`) works over a SceneGraph.

use serde_json::{Map, Value};

use crate::scene::SceneGraph;

type Obj = Map<String, Value>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChildRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn f64_of(obj: &Obj, key: &str) -> f64 {
    obj.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn str_or<'a>(obj: &'a Obj, key: &str, default: &'a str) -> &'a str {
    obj.get(key).and_then(Value::as_str).unwrap_or(default)
}

fn set_f64(obj: &mut Obj, key: &str, v: f64) {
    obj.insert(key.to_string(), serde_json::json!(v));
}

/// Apply one child's constraints given its rect at the OLD frame size and the
/// old/new frame dimensions. Mutates the live child object.
pub fn constrain_child(child: &mut Obj, snap: ChildRect, old_w: f64, old_h: f64, new_w: f64, new_h: f64) {
    let h = str_or(child, "constraintsH", "MIN").to_string();
    let v = str_or(child, "constraintsV", "MIN").to_string();
    let dw = new_w - old_w;
    let dh = new_h - old_h;

    match h.as_str() {
        "MAX" => {
            set_f64(child, "x", snap.x + dw);
            set_f64(child, "width", snap.width);
        }
        "CENTER" => {
            set_f64(child, "x", snap.x + dw / 2.0);
            set_f64(child, "width", snap.width);
        }
        "STRETCH" => {
            set_f64(child, "x", snap.x);
            set_f64(child, "width", (snap.width + dw).max(0.5));
        }
        "SCALE" if old_w > 0.01 => {
            let s = new_w / old_w;
            set_f64(child, "x", snap.x * s);
            set_f64(child, "width", (snap.width * s).max(0.5));
        }
        _ => {
            set_f64(child, "x", snap.x);
            set_f64(child, "width", snap.width);
        }
    }

    let is_line = str_or(child, "type", "") == "LINE";
    match v.as_str() {
        "MAX" => {
            set_f64(child, "y", snap.y + dh);
            if !is_line {
                set_f64(child, "height", snap.height);
            }
        }
        "CENTER" => {
            set_f64(child, "y", snap.y + dh / 2.0);
            if !is_line {
                set_f64(child, "height", snap.height);
            }
        }
        "STRETCH" => {
            set_f64(child, "y", snap.y);
            if !is_line {
                set_f64(child, "height", (snap.height + dh).max(0.5));
            }
        }
        "SCALE" if old_h > 0.01 => {
            let s = new_h / old_h;
            set_f64(child, "y", snap.y * s);
            if !is_line {
                set_f64(child, "height", (snap.height * s).max(0.5));
            }
        }
        _ => {
            set_f64(child, "y", snap.y);
            if !is_line {
                set_f64(child, "height", snap.height);
            }
        }
    }
}

fn is_frame_like(t: &str) -> bool {
    matches!(t, "FRAME" | "COMPONENT" | "INSTANCE")
}

/// Recursively constrain `frame_id`'s children against snapshots captured
/// BEFORE the resize. The frame itself must already carry its new size.
pub fn constrain_frame_children(
    scene: &mut SceneGraph,
    frame_id: &str,
    snap: &dyn Fn(&str) -> Option<ChildRect>,
    old_w: f64,
    old_h: f64,
) {
    let Some(frame) = scene.get_node(frame_id) else { return };
    let layout_mode = frame
        .get("layout")
        .and_then(Value::as_object)
        .map(|l| str_or(l, "mode", "NONE").to_string())
        .unwrap_or_else(|| "NONE".to_string());
    if layout_mode != "NONE" {
        return;
    }
    let new_w = f64_of(frame, "width");
    let new_h = f64_of(frame, "height");
    let children: Vec<String> = frame
        .get("children")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default();

    for cid in children {
        let Some(s) = snap(&cid) else { continue };
        let Some(child) = scene.get_node_mut(&cid) else { continue };
        constrain_child(child, s, old_w, old_h, new_w, new_h);
        let t = str_or(child, "type", "").to_string();
        let cw = f64_of(child, "width");
        let ch = f64_of(child, "height");
        if is_frame_like(&t) && (cw != s.width || ch != s.height) {
            constrain_frame_children(scene, &cid, snap, s.width, s.height);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn child(h: &str, v: &str) -> Obj {
        json!({
            "type": "RECTANGLE",
            "x": 10.0, "y": 20.0, "width": 30.0, "height": 40.0,
            "constraintsH": h, "constraintsV": v
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn stretch_grows_with_frame() {
        let mut c = child("STRETCH", "STRETCH");
        let snap = ChildRect { x: 10.0, y: 20.0, width: 30.0, height: 40.0 };
        constrain_child(&mut c, snap, 100.0, 100.0, 150.0, 130.0);
        assert_eq!(f64_of(&c, "x"), 10.0);
        assert_eq!(f64_of(&c, "width"), 80.0);
        assert_eq!(f64_of(&c, "height"), 70.0);
    }

    #[test]
    fn scale_is_proportional() {
        let mut c = child("SCALE", "MIN");
        let snap = ChildRect { x: 10.0, y: 20.0, width: 30.0, height: 40.0 };
        constrain_child(&mut c, snap, 100.0, 100.0, 200.0, 100.0);
        assert_eq!(f64_of(&c, "x"), 20.0);
        assert_eq!(f64_of(&c, "width"), 60.0);
    }

    #[test]
    fn line_height_is_never_touched() {
        let mut c = child("MIN", "STRETCH");
        c.insert("type".into(), json!("LINE"));
        c.insert("height".into(), json!(0.0));
        let snap = ChildRect { x: 10.0, y: 20.0, width: 30.0, height: 0.0 };
        constrain_child(&mut c, snap, 100.0, 100.0, 100.0, 300.0);
        assert_eq!(f64_of(&c, "height"), 0.0);
        assert_eq!(f64_of(&c, "y"), 20.0);
    }
}
