/* tslint:disable */
/* eslint-disable */

export class SceneHandle {
    free(): void;
    [Symbol.dispose](): void;
    applyOps(ops_json: string): void;
    booleanRingsOf(id: string): Float64Array;
    docJson(): string;
    findDropFrame(x: number, y: number, exclude_json: string): string | undefined;
    hitTestAll(x: number, y: number, tolerance_px: number, zoom: number, include_locked: boolean, exclude_json: string): string;
    constructor(doc_json: string);
    nodesInRect(min_x: number, min_y: number, max_x: number, max_y: number, tolerance_px: number, zoom: number, include_locked: boolean, exclude_json: string): string;
    parentOf(id: string): string | undefined;
    renderOrder(): string;
    rootIds(): string;
    /**
     * Run instance sync + auto-layout + normalize + GC to fixpoint (text
     * auto-resize stays host-side). Materialized ids mint as
     * `{prefix}{counter}` — the host owns id uniqueness.
     */
    runDerivedPasses(id_prefix: string): boolean;
    undoOps(ops_json: string): void;
    version(): number;
    worldAabb(id: string): Float64Array;
    worldMatrix(id: string): Float64Array;
}

export class SpatialIndex {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bulk-load [minX, minY, maxX, maxY]*; entry id = chunk index.
     */
    load(boxes: Float64Array): void;
    constructor();
    /**
     * Entry ids intersecting the box (inclusive edges), ascending.
     */
    search(min_x: number, min_y: number, max_x: number, max_y: number): Uint32Array;
}

export class TessMesh {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    fillIndices(): Uint32Array;
    fillPositions(): Float32Array;
    strokeIndices(): Uint32Array;
    strokePositions(): Float32Array;
}

export function aabbOfPoints(pts: Float64Array): Float64Array;

export function applyMat(m: Float64Array, x: number, y: number): Float64Array;

/**
 * data: [childCount, (blobLen, <SubPath blob of blobLen f64s>)*]
 * op: 0 union, 1 subtract, 2 intersect, 3 exclude.
 * Returns a rings blob: [ringCount, (len, (x, y) * len)*].
 */
export function booleanOp(data: Float64Array, op: number, accuracy: number, flatten_tolerance: number): Float64Array;

export function constrainChildJson(child_json: string, snap_x: number, snap_y: number, snap_w: number, snap_h: number, old_w: number, old_h: number, new_w: number, new_h: number): string;

export function decodeSceneJson(bytes: Uint8Array): string;

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number;

export function ellipsePath(w: number, h: number): Float64Array;

export function encodeSceneBytes(doc_json: string, saved_at: string): Uint8Array;

export function flattenCubic(coords: Float64Array, tolerance: number): Float64Array;

export function flattenSubPaths(blob: Float64Array, tolerance: number): Float64Array;

export function invertOpJson(op_json: string): string;

export function linePath(w: number): Float64Array;

export function matInvert(m: Float64Array): Float64Array;

export function matMultiply(m1: Float64Array, m2: Float64Array): Float64Array;

export function matRotateDeg(deg: number): Float64Array;

export function migrateDocumentJson(doc_json: string): string;

export function networkToSubPaths(vertices: Float64Array, edges: Float64Array): Float64Array;

export function nodeLocalMatrix(x: number, y: number, w: number, h: number, rotation: number): Float64Array;

export function pointInEllipse(px: number, py: number, cx: number, cy: number, rx: number, ry: number): boolean;

export function pointInPolygonRings(px: number, py: number, ring_data: Float64Array, ring_lens: Uint32Array, even_odd: boolean): boolean;

export function pointInRoundedRect(px: number, py: number, w: number, h: number, tl: number, tr: number, br: number, bl: number): boolean;

export function polygonPath(w: number, h: number, points: number): Float64Array;

export function roundedRectPath(w: number, h: number, tl: number, tr: number, br: number, bl: number): Float64Array;

export function starPath(w: number, h: number, points: number, inner_ratio: number): Float64Array;

export function subPathsToSvg(blob: Float64Array, precision: number): string;

/**
 * Tessellate one node's geometry from its SubPath blob.
 * stroke_align: 0 = CENTER, 1 = INSIDE, 2 = OUTSIDE (inside/outside meshes
 * are tessellated at double width; the renderer stencil-clips them against
 * the fill mesh). A dash pattern splits the outline before stroking.
 */
export function tessellateNode(blob: Float64Array, even_odd: boolean, stroke_width: number, stroke_align: number, dash: Float64Array, fill_tolerance: number, want_fill: boolean, want_stroke: boolean): TessMesh;

export function transformedRectAabb(m: Float64Array, w: number, h: number): Float64Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_scenehandle_free: (a: number, b: number) => void;
    readonly __wbg_spatialindex_free: (a: number, b: number) => void;
    readonly __wbg_tessmesh_free: (a: number, b: number) => void;
    readonly aabbOfPoints: (a: number, b: number) => [number, number];
    readonly applyMat: (a: number, b: number, c: number, d: number) => [number, number];
    readonly booleanOp: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly constrainChildJson: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly decodeSceneJson: (a: number, b: number) => [number, number, number, number];
    readonly distToSegment: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly ellipsePath: (a: number, b: number) => [number, number];
    readonly encodeSceneBytes: (a: number, b: number, c: number, d: number) => [number, number];
    readonly flattenCubic: (a: number, b: number, c: number) => [number, number];
    readonly flattenSubPaths: (a: number, b: number, c: number) => [number, number];
    readonly invertOpJson: (a: number, b: number) => [number, number];
    readonly linePath: (a: number) => [number, number];
    readonly matInvert: (a: number, b: number) => [number, number];
    readonly matMultiply: (a: number, b: number, c: number, d: number) => [number, number];
    readonly matRotateDeg: (a: number) => [number, number];
    readonly migrateDocumentJson: (a: number, b: number) => [number, number];
    readonly networkToSubPaths: (a: number, b: number, c: number, d: number) => [number, number];
    readonly nodeLocalMatrix: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly pointInEllipse: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly pointInPolygonRings: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly pointInRoundedRect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly polygonPath: (a: number, b: number, c: number) => [number, number];
    readonly roundedRectPath: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly scenehandle_applyOps: (a: number, b: number, c: number) => void;
    readonly scenehandle_booleanRingsOf: (a: number, b: number, c: number) => [number, number];
    readonly scenehandle_docJson: (a: number) => [number, number];
    readonly scenehandle_findDropFrame: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly scenehandle_hitTestAll: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly scenehandle_new: (a: number, b: number) => number;
    readonly scenehandle_nodesInRect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly scenehandle_parentOf: (a: number, b: number, c: number) => [number, number];
    readonly scenehandle_renderOrder: (a: number) => [number, number];
    readonly scenehandle_rootIds: (a: number) => [number, number];
    readonly scenehandle_runDerivedPasses: (a: number, b: number, c: number) => number;
    readonly scenehandle_undoOps: (a: number, b: number, c: number) => void;
    readonly scenehandle_version: (a: number) => number;
    readonly scenehandle_worldAabb: (a: number, b: number, c: number) => [number, number];
    readonly scenehandle_worldMatrix: (a: number, b: number, c: number) => [number, number];
    readonly spatialindex_load: (a: number, b: number, c: number) => void;
    readonly spatialindex_new: () => number;
    readonly spatialindex_search: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly starPath: (a: number, b: number, c: number, d: number) => [number, number];
    readonly subPathsToSvg: (a: number, b: number, c: number) => [number, number];
    readonly tessellateNode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly tessmesh_fillIndices: (a: number) => [number, number];
    readonly tessmesh_fillPositions: (a: number) => [number, number];
    readonly tessmesh_strokeIndices: (a: number) => [number, number];
    readonly tessmesh_strokePositions: (a: number) => [number, number];
    readonly transformedRectAabb: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
