//! wasm-bindgen boundary. Batch-only APIs over flat Float64Arrays — no
//! per-node getter chatter (V0.4-Porting-Plan "WASM embedding plan").
//!
//! Encodings (mirrored by src/renderer/src/engine/wasm/codec.ts):
//! - Mat:   [a, b, c, d, e, f]
//! - AABB:  [minX, minY, maxX, maxY]
//! - Points: interleaved [x, y]*
//! - SubPath blob: repeating [closed(0|1), anchorCount,
//!     (px, py, cpInX, cpInY, cpOutX, cpOutY) * anchorCount]
//!   where NaN,NaN encodes a null control point (real control points are
//!   always finite; scene documents never carry NaN coordinates).
//! - Network: vertices [id, x, y]*, edges [v0, v1, cp0x, cp0y, cp1x, cp1y]*
//!   with NaN,NaN for null control points.
//! - Flattened rings blob: [ringCount, (len, (x, y) * len)*]

use wasm_bindgen::prelude::*;

use crate::geometry as g;
use crate::shapes as s;
use crate::spatial;

fn mat_from(m: &[f64]) -> g::Mat {
    g::Mat { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }
}

fn mat_out(m: g::Mat) -> Vec<f64> {
    vec![m.a, m.b, m.c, m.d, m.e, m.f]
}

fn aabb_out(b: g::Aabb) -> Vec<f64> {
    vec![b.min_x, b.min_y, b.max_x, b.max_y]
}

fn points_out(pts: &[g::Vec2]) -> Vec<f64> {
    let mut out = Vec::with_capacity(pts.len() * 2);
    for p in pts {
        out.push(p.x);
        out.push(p.y);
    }
    out
}

fn points_in(data: &[f64]) -> Vec<g::Vec2> {
    data.chunks_exact(2).map(|c| g::vec2(c[0], c[1])).collect()
}

fn cp_out(cp: Option<g::Vec2>, out: &mut Vec<f64>) {
    match cp {
        Some(c) => {
            out.push(c.x);
            out.push(c.y);
        }
        None => {
            out.push(f64::NAN);
            out.push(f64::NAN);
        }
    }
}

fn cp_in(x: f64, y: f64) -> Option<g::Vec2> {
    if x.is_nan() && y.is_nan() {
        None
    } else {
        Some(g::vec2(x, y))
    }
}

fn encode_sub_paths(paths: &[s::SubPath]) -> Vec<f64> {
    let mut out = Vec::new();
    for sp in paths {
        out.push(if sp.closed { 1.0 } else { 0.0 });
        out.push(sp.anchors.len() as f64);
        for a in &sp.anchors {
            out.push(a.p.x);
            out.push(a.p.y);
            cp_out(a.cp_in, &mut out);
            cp_out(a.cp_out, &mut out);
        }
    }
    out
}

fn decode_sub_paths(buf: &[f64]) -> Vec<s::SubPath> {
    let mut paths = Vec::new();
    let mut i = 0;
    while i + 2 <= buf.len() {
        let closed = buf[i] != 0.0;
        let n = buf[i + 1] as usize;
        i += 2;
        let mut anchors = Vec::with_capacity(n);
        for _ in 0..n {
            if i + 6 > buf.len() {
                break;
            }
            anchors.push(s::Anchor {
                p: g::vec2(buf[i], buf[i + 1]),
                cp_in: cp_in(buf[i + 2], buf[i + 3]),
                cp_out: cp_in(buf[i + 4], buf[i + 5]),
            });
            i += 6;
        }
        paths.push(s::SubPath { closed, anchors });
    }
    paths
}

// ---------------------------------------------------------------------------
// geometry.ts exports
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = matMultiply)]
pub fn mat_multiply(m1: &[f64], m2: &[f64]) -> Vec<f64> {
    mat_out(g::mat_multiply(mat_from(m1), mat_from(m2)))
}

#[wasm_bindgen(js_name = matInvert)]
pub fn mat_invert(m: &[f64]) -> Vec<f64> {
    mat_out(g::mat_invert(mat_from(m)))
}

#[wasm_bindgen(js_name = matRotateDeg)]
pub fn mat_rotate_deg(deg: f64) -> Vec<f64> {
    mat_out(g::mat_rotate_deg(deg))
}

#[wasm_bindgen(js_name = applyMat)]
pub fn apply_mat(m: &[f64], x: f64, y: f64) -> Vec<f64> {
    let p = g::apply_mat(mat_from(m), g::vec2(x, y));
    vec![p.x, p.y]
}

#[wasm_bindgen(js_name = nodeLocalMatrix)]
pub fn node_local_matrix(x: f64, y: f64, w: f64, h: f64, rotation: f64) -> Vec<f64> {
    mat_out(g::node_local_matrix(x, y, w, h, rotation))
}

#[wasm_bindgen(js_name = transformedRectAabb)]
pub fn transformed_rect_aabb(m: &[f64], w: f64, h: f64) -> Vec<f64> {
    aabb_out(g::transformed_rect_aabb(mat_from(m), w, h))
}

#[wasm_bindgen(js_name = aabbOfPoints)]
pub fn aabb_of_points(pts: &[f64]) -> Vec<f64> {
    aabb_out(g::aabb_of_points(&points_in(pts)))
}

#[wasm_bindgen(js_name = flattenCubic)]
pub fn flatten_cubic(coords: &[f64], tolerance: f64) -> Vec<f64> {
    let p = points_in(coords);
    points_out(&g::flatten_cubic(p[0], p[1], p[2], p[3], tolerance))
}

#[wasm_bindgen(js_name = distToSegment)]
pub fn dist_to_segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    g::dist_to_segment(g::vec2(px, py), g::vec2(ax, ay), g::vec2(bx, by))
}

#[wasm_bindgen(js_name = pointInPolygonRings)]
pub fn point_in_polygon_rings(
    px: f64,
    py: f64,
    ring_data: &[f64],
    ring_lens: &[u32],
    even_odd: bool,
) -> bool {
    let mut rings: Vec<Vec<g::Vec2>> = Vec::with_capacity(ring_lens.len());
    let mut offset = 0usize;
    for &len in ring_lens {
        let end = offset + (len as usize) * 2;
        if end > ring_data.len() {
            break;
        }
        rings.push(points_in(&ring_data[offset..end]));
        offset = end;
    }
    g::point_in_polygon_rings(g::vec2(px, py), &rings, even_odd)
}

#[wasm_bindgen(js_name = pointInEllipse)]
pub fn point_in_ellipse(px: f64, py: f64, cx: f64, cy: f64, rx: f64, ry: f64) -> bool {
    g::point_in_ellipse(g::vec2(px, py), cx, cy, rx, ry)
}

#[wasm_bindgen(js_name = pointInRoundedRect)]
pub fn point_in_rounded_rect(
    px: f64,
    py: f64,
    w: f64,
    h: f64,
    tl: f64,
    tr: f64,
    br: f64,
    bl: f64,
) -> bool {
    g::point_in_rounded_rect(g::vec2(px, py), w, h, g::CornerRadius { tl, tr, br, bl })
}

// ---------------------------------------------------------------------------
// shapes.ts exports (SubPath blob encoding)
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = roundedRectPath)]
pub fn rounded_rect_path(w: f64, h: f64, tl: f64, tr: f64, br: f64, bl: f64) -> Vec<f64> {
    encode_sub_paths(&[s::rounded_rect_path(w, h, tl, tr, br, bl)])
}

#[wasm_bindgen(js_name = ellipsePath)]
pub fn ellipse_path(w: f64, h: f64) -> Vec<f64> {
    encode_sub_paths(&[s::ellipse_path(w, h)])
}

#[wasm_bindgen(js_name = linePath)]
pub fn line_path(w: f64) -> Vec<f64> {
    encode_sub_paths(&[s::line_path(w)])
}

#[wasm_bindgen(js_name = polygonPath)]
pub fn polygon_path(w: f64, h: f64, points: f64) -> Vec<f64> {
    encode_sub_paths(&[s::polygon_path(w, h, points)])
}

#[wasm_bindgen(js_name = starPath)]
pub fn star_path(w: f64, h: f64, points: f64, inner_ratio: f64) -> Vec<f64> {
    encode_sub_paths(&[s::star_path(w, h, points, inner_ratio)])
}

#[wasm_bindgen(js_name = networkToSubPaths)]
pub fn network_to_sub_paths(vertices: &[f64], edges: &[f64]) -> Vec<f64> {
    let verts: Vec<s::NetVertex> = vertices
        .chunks_exact(3)
        .map(|c| s::NetVertex { id: c[0], x: c[1], y: c[2] })
        .collect();
    let es: Vec<s::NetEdge> = edges
        .chunks_exact(6)
        .map(|c| s::NetEdge { v0: c[0], v1: c[1], cp0: cp_in(c[2], c[3]), cp1: cp_in(c[4], c[5]) })
        .collect();
    encode_sub_paths(&s::network_to_sub_paths(&verts, &es))
}

#[wasm_bindgen(js_name = flattenSubPaths)]
pub fn flatten_sub_paths(blob: &[f64], tolerance: f64) -> Vec<f64> {
    let paths = decode_sub_paths(blob);
    let mut out = vec![paths.len() as f64];
    for sp in &paths {
        let pts = s::flatten_sub_path(sp, tolerance);
        out.push(pts.len() as f64);
        for p in pts {
            out.push(p.x);
            out.push(p.y);
        }
    }
    out
}

#[wasm_bindgen(js_name = subPathsToSvg)]
pub fn sub_paths_to_svg(blob: &[f64], precision: u32) -> String {
    s::sub_paths_to_svg(&decode_sub_paths(blob), precision as usize)
}

// ---------------------------------------------------------------------------
// booleans.ts exports — exact bezier CSG
// ---------------------------------------------------------------------------

/// data: [childCount, (blobLen, <SubPath blob of blobLen f64s>)*]
/// op: 0 union, 1 subtract, 2 intersect, 3 exclude.
/// Returns a rings blob: [ringCount, (len, (x, y) * len)*].
#[wasm_bindgen(js_name = booleanOp)]
pub fn boolean_op(data: &[f64], op: u32, accuracy: f64, flatten_tolerance: f64) -> Vec<f64> {
    let mut children: Vec<Vec<s::SubPath>> = Vec::new();
    if !data.is_empty() {
        let child_count = data[0] as usize;
        let mut i = 1usize;
        for _ in 0..child_count {
            if i >= data.len() {
                break;
            }
            let blob_len = data[i] as usize;
            i += 1;
            let end = (i + blob_len).min(data.len());
            children.push(decode_sub_paths(&data[i..end]));
            i = end;
        }
    }
    let rings = crate::booleans::boolean_rings(
        &children,
        crate::booleans::BoolOp::from_u32(op),
        accuracy,
        flatten_tolerance,
    );
    let mut out = vec![rings.len() as f64];
    for ring in &rings {
        out.push(ring.len() as f64);
        for p in ring {
            out.push(p.x);
            out.push(p.y);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// SceneGraph + PatchOp engine (scene.ts / commands.ts twins)
// ---------------------------------------------------------------------------
//
// JSON-string boundary: this surface exists for differential testing and as
// the substrate for the Sprint C/worker embedding — the runtime app still
// runs the TS SceneGraph. Bulk msgpack replaces the JSON strings when
// serialization.rs lands.

#[wasm_bindgen(js_name = SceneHandle)]
pub struct WasmSceneHandle {
    inner: crate::scene::SceneGraph,
    mint_counter: u64,
}

#[wasm_bindgen(js_class = SceneHandle)]
impl WasmSceneHandle {
    #[wasm_bindgen(constructor)]
    pub fn new(doc_json: &str) -> WasmSceneHandle {
        let doc: serde_json::Value = serde_json::from_str(doc_json).expect("valid document JSON");
        WasmSceneHandle { inner: crate::scene::SceneGraph::new(doc), mint_counter: 0 }
    }

    /// Run instance sync + auto-layout + normalize + GC to fixpoint (text
    /// auto-resize stays host-side). Materialized ids mint as
    /// `{prefix}{counter}` — the host owns id uniqueness.
    #[wasm_bindgen(js_name = runDerivedPasses)]
    pub fn run_derived_passes(&mut self, id_prefix: &str) -> bool {
        let counter = &mut self.mint_counter;
        let prefix = id_prefix.to_string();
        let mut mint = move || {
            *counter += 1;
            format!("{prefix}{counter}")
        };
        crate::layout::run_derived_passes(&mut self.inner, &mut mint)
    }

    #[wasm_bindgen(js_name = applyOps)]
    pub fn apply_ops(&mut self, ops_json: &str) {
        let ops: Vec<serde_json::Value> = serde_json::from_str(ops_json).expect("valid ops JSON");
        self.inner.apply_ops(&ops);
    }

    #[wasm_bindgen(js_name = undoOps)]
    pub fn undo_ops(&mut self, ops_json: &str) {
        let ops: Vec<serde_json::Value> = serde_json::from_str(ops_json).expect("valid ops JSON");
        self.inner.undo_ops(&ops);
    }

    #[wasm_bindgen(js_name = docJson)]
    pub fn doc_json(&self) -> String {
        serde_json::to_string(&self.inner.doc).expect("document serializes")
    }

    #[wasm_bindgen(js_name = worldMatrix)]
    pub fn world_matrix(&self, id: &str) -> Vec<f64> {
        mat_out(self.inner.world_matrix(id))
    }

    #[wasm_bindgen(js_name = worldAabb)]
    pub fn world_aabb(&self, id: &str) -> Vec<f64> {
        aabb_out(self.inner.world_aabb(id))
    }

    #[wasm_bindgen(js_name = renderOrder)]
    pub fn render_order(&self) -> String {
        serde_json::to_string(&self.inner.render_order()).expect("render order serializes")
    }

    #[wasm_bindgen(js_name = parentOf)]
    pub fn parent_of(&self, id: &str) -> Option<String> {
        self.inner.parent_of(id)
    }

    #[wasm_bindgen(js_name = rootIds)]
    pub fn root_ids(&self) -> String {
        serde_json::to_string(&self.inner.root_ids()).expect("root ids serialize")
    }

    pub fn version(&self) -> f64 {
        self.inner.version as f64
    }
}

#[wasm_bindgen(js_name = invertOpJson)]
pub fn invert_op_json(op_json: &str) -> String {
    let op: serde_json::Value = serde_json::from_str(op_json).expect("valid op JSON");
    serde_json::to_string(&crate::scene::invert_op(&op)).expect("op serializes")
}

// ---------------------------------------------------------------------------
// Hit-testing over the Rust scene (hit-test.ts twin, test/flip surface)
// ---------------------------------------------------------------------------

fn hit_opts(tolerance_px: f64, zoom: f64, include_locked: bool, exclude_json: &str) -> crate::hit_test::HitOptions {
    let exclude: Vec<String> = if exclude_json.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(exclude_json).unwrap_or_default()
    };
    crate::hit_test::HitOptions {
        tolerance_px,
        zoom,
        exclude: exclude.into_iter().collect(),
        include_locked,
    }
}

#[wasm_bindgen(js_class = SceneHandle)]
impl WasmSceneHandle {
    #[wasm_bindgen(js_name = hitTestAll)]
    pub fn hit_test_all(
        &self,
        x: f64,
        y: f64,
        tolerance_px: f64,
        zoom: f64,
        include_locked: bool,
        exclude_json: &str,
    ) -> String {
        let opts = hit_opts(tolerance_px, zoom, include_locked, exclude_json);
        let hits = crate::hit_test::hit_test_all(&self.inner, crate::geometry::vec2(x, y), &opts);
        serde_json::to_string(&hits).expect("hits serialize")
    }

    #[wasm_bindgen(js_name = nodesInRect)]
    pub fn nodes_in_rect(
        &self,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        tolerance_px: f64,
        zoom: f64,
        include_locked: bool,
        exclude_json: &str,
    ) -> String {
        let opts = hit_opts(tolerance_px, zoom, include_locked, exclude_json);
        let rect = crate::geometry::Aabb { min_x, min_y, max_x, max_y };
        let ids = crate::hit_test::nodes_in_rect(&self.inner, rect, &opts);
        serde_json::to_string(&ids).expect("ids serialize")
    }

    #[wasm_bindgen(js_name = findDropFrame)]
    pub fn find_drop_frame(&self, x: f64, y: f64, exclude_json: &str) -> Option<String> {
        let exclude: Vec<String> = if exclude_json.is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(exclude_json).unwrap_or_default()
        };
        crate::hit_test::find_drop_frame(
            &self.inner,
            crate::geometry::vec2(x, y),
            &exclude.into_iter().collect(),
        )
    }

    #[wasm_bindgen(js_name = booleanRingsOf)]
    pub fn boolean_rings_of(&self, id: &str) -> Vec<f64> {
        let rings = crate::hit_test::boolean_rings(&self.inner, id);
        let mut out = vec![rings.len() as f64];
        for ring in &rings {
            out.push(ring.len() as f64);
            for p in ring {
                out.push(p.x);
                out.push(p.y);
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// GPU tessellation (Sprint D — WebGPU backend geometry)
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct TessMesh {
    fill_positions: Vec<f32>,
    fill_indices: Vec<u32>,
    stroke_positions: Vec<f32>,
    stroke_indices: Vec<u32>,
}

#[wasm_bindgen]
impl TessMesh {
    #[wasm_bindgen(js_name = fillPositions)]
    pub fn fill_positions(&self) -> Vec<f32> {
        self.fill_positions.clone()
    }
    #[wasm_bindgen(js_name = fillIndices)]
    pub fn fill_indices(&self) -> Vec<u32> {
        self.fill_indices.clone()
    }
    #[wasm_bindgen(js_name = strokePositions)]
    pub fn stroke_positions(&self) -> Vec<f32> {
        self.stroke_positions.clone()
    }
    #[wasm_bindgen(js_name = strokeIndices)]
    pub fn stroke_indices(&self) -> Vec<u32> {
        self.stroke_indices.clone()
    }
}

/// Tessellate one node's geometry from its SubPath blob.
/// stroke_align: 0 = CENTER, 1 = INSIDE, 2 = OUTSIDE (inside/outside meshes
/// are tessellated at double width; the renderer stencil-clips them against
/// the fill mesh). A dash pattern splits the outline before stroking.
#[wasm_bindgen(js_name = tessellateNode)]
#[allow(clippy::too_many_arguments)]
pub fn tessellate_node(
    blob: &[f64],
    even_odd: bool,
    stroke_width: f64,
    stroke_align: u32,
    dash: &[f64],
    fill_tolerance: f64,
    want_fill: bool,
    want_stroke: bool,
) -> TessMesh {
    let subpaths = decode_sub_paths(blob);
    let fill = if want_fill || (want_stroke && stroke_align != 0) {
        crate::tess::tessellate_fill(&subpaths, even_odd, fill_tolerance)
    } else {
        crate::tess::Mesh { positions: Vec::new(), indices: Vec::new() }
    };
    let stroke = if want_stroke && stroke_width > 0.0 {
        let width = if stroke_align == 0 { stroke_width } else { stroke_width * 2.0 };
        let stroked_paths = if dash.is_empty() {
            subpaths
        } else {
            crate::tess::dash_sub_paths(&subpaths, dash)
        };
        crate::tess::tessellate_stroke(&stroked_paths, width, fill_tolerance)
    } else {
        crate::tess::Mesh { positions: Vec::new(), indices: Vec::new() }
    };
    TessMesh {
        fill_positions: fill.positions,
        fill_indices: fill.indices,
        stroke_positions: stroke.positions,
        stroke_indices: stroke.indices,
    }
}

// ---------------------------------------------------------------------------
// Serialization (serialization.ts twin)
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = encodeSceneBytes)]
pub fn encode_scene_bytes(doc_json: &str, saved_at: &str) -> Vec<u8> {
    let doc: serde_json::Value = serde_json::from_str(doc_json).expect("valid document JSON");
    crate::serialization::encode_scene(&doc, saved_at)
}

#[wasm_bindgen(js_name = decodeSceneJson)]
pub fn decode_scene_json(bytes: &[u8]) -> Result<String, JsError> {
    match crate::serialization::decode_scene(bytes) {
        Ok(doc) => Ok(serde_json::to_string(&doc).expect("document serializes")),
        Err(e) => Err(JsError::new(&e.to_string())),
    }
}

#[wasm_bindgen(js_name = migrateDocumentJson)]
pub fn migrate_document_json(doc_json: &str) -> String {
    let doc: serde_json::Value = serde_json::from_str(doc_json).expect("valid document JSON");
    serde_json::to_string(&crate::serialization::migrate_document(doc)).expect("doc serializes")
}

// ---------------------------------------------------------------------------
// Constraints (constraints.ts twin, parity surface)
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = constrainChildJson)]
pub fn constrain_child_json(
    child_json: &str,
    snap_x: f64,
    snap_y: f64,
    snap_w: f64,
    snap_h: f64,
    old_w: f64,
    old_h: f64,
    new_w: f64,
    new_h: f64,
) -> String {
    let mut child: serde_json::Value = serde_json::from_str(child_json).expect("valid child JSON");
    let obj = child.as_object_mut().expect("child is an object");
    crate::constraints::constrain_child(
        obj,
        crate::constraints::ChildRect { x: snap_x, y: snap_y, width: snap_w, height: snap_h },
        old_w,
        old_h,
        new_w,
        new_h,
    );
    serde_json::to_string(&child).expect("child serializes")
}

// ---------------------------------------------------------------------------
// Spatial index
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = SpatialIndex)]
pub struct WasmSpatialIndex {
    inner: spatial::SpatialIndex,
}

#[wasm_bindgen(js_class = SpatialIndex)]
impl WasmSpatialIndex {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmSpatialIndex {
        WasmSpatialIndex { inner: spatial::SpatialIndex::new() }
    }

    /// Bulk-load [minX, minY, maxX, maxY]*; entry id = chunk index.
    pub fn load(&mut self, boxes: &[f64]) {
        self.inner.load(boxes);
    }

    /// Entry ids intersecting the box (inclusive edges), ascending.
    pub fn search(&self, min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Vec<u32> {
        self.inner.search(min_x, min_y, max_x, max_y)
    }
}

impl Default for WasmSpatialIndex {
    fn default() -> Self {
        Self::new()
    }
}
