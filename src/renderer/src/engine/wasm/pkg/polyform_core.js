/* @ts-self-types="./polyform_core.d.ts" */

export class SceneHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SceneHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_scenehandle_free(ptr, 0);
    }
    /**
     * @param {string} ops_json
     */
    applyOps(ops_json) {
        const ptr0 = passStringToWasm0(ops_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.scenehandle_applyOps(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {string} id
     * @returns {Float64Array}
     */
    booleanRingsOf(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.scenehandle_booleanRingsOf(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v2;
    }
    /**
     * @returns {string}
     */
    docJson() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.scenehandle_docJson(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {string} exclude_json
     * @returns {string | undefined}
     */
    findDropFrame(x, y, exclude_json) {
        const ptr0 = passStringToWasm0(exclude_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.scenehandle_findDropFrame(this.__wbg_ptr, x, y, ptr0, len0);
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} tolerance_px
     * @param {number} zoom
     * @param {boolean} include_locked
     * @param {string} exclude_json
     * @returns {string}
     */
    hitTestAll(x, y, tolerance_px, zoom, include_locked, exclude_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(exclude_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.scenehandle_hitTestAll(this.__wbg_ptr, x, y, tolerance_px, zoom, include_locked, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} doc_json
     */
    constructor(doc_json) {
        const ptr0 = passStringToWasm0(doc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.scenehandle_new(ptr0, len0);
        this.__wbg_ptr = ret;
        SceneHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} min_x
     * @param {number} min_y
     * @param {number} max_x
     * @param {number} max_y
     * @param {number} tolerance_px
     * @param {number} zoom
     * @param {boolean} include_locked
     * @param {string} exclude_json
     * @returns {string}
     */
    nodesInRect(min_x, min_y, max_x, max_y, tolerance_px, zoom, include_locked, exclude_json) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(exclude_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.scenehandle_nodesInRect(this.__wbg_ptr, min_x, min_y, max_x, max_y, tolerance_px, zoom, include_locked, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} id
     * @returns {string | undefined}
     */
    parentOf(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.scenehandle_parentOf(this.__wbg_ptr, ptr0, len0);
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * @returns {string}
     */
    renderOrder() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.scenehandle_renderOrder(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    rootIds() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.scenehandle_rootIds(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Run instance sync + auto-layout + normalize + GC to fixpoint (text
     * auto-resize stays host-side). Materialized ids mint as
     * `{prefix}{counter}` — the host owns id uniqueness.
     * @param {string} id_prefix
     * @returns {boolean}
     */
    runDerivedPasses(id_prefix) {
        const ptr0 = passStringToWasm0(id_prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.scenehandle_runDerivedPasses(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * @param {string} ops_json
     */
    undoOps(ops_json) {
        const ptr0 = passStringToWasm0(ops_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.scenehandle_undoOps(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {number}
     */
    version() {
        const ret = wasm.scenehandle_version(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {string} id
     * @returns {Float64Array}
     */
    worldAabb(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.scenehandle_worldAabb(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v2;
    }
    /**
     * @param {string} id
     * @returns {Float64Array}
     */
    worldMatrix(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.scenehandle_worldMatrix(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v2;
    }
}
if (Symbol.dispose) SceneHandle.prototype[Symbol.dispose] = SceneHandle.prototype.free;

export class SpatialIndex {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SpatialIndexFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_spatialindex_free(ptr, 0);
    }
    /**
     * Bulk-load [minX, minY, maxX, maxY]*; entry id = chunk index.
     * @param {Float64Array} boxes
     */
    load(boxes) {
        const ptr0 = passArrayF64ToWasm0(boxes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.spatialindex_load(this.__wbg_ptr, ptr0, len0);
    }
    constructor() {
        const ret = wasm.spatialindex_new();
        this.__wbg_ptr = ret;
        SpatialIndexFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Entry ids intersecting the box (inclusive edges), ascending.
     * @param {number} min_x
     * @param {number} min_y
     * @param {number} max_x
     * @param {number} max_y
     * @returns {Uint32Array}
     */
    search(min_x, min_y, max_x, max_y) {
        const ret = wasm.spatialindex_search(this.__wbg_ptr, min_x, min_y, max_x, max_y);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) SpatialIndex.prototype[Symbol.dispose] = SpatialIndex.prototype.free;

export class TessMesh {
    static __wrap(ptr) {
        const obj = Object.create(TessMesh.prototype);
        obj.__wbg_ptr = ptr;
        TessMeshFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TessMeshFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tessmesh_free(ptr, 0);
    }
    /**
     * @returns {Uint32Array}
     */
    fillIndices() {
        const ret = wasm.tessmesh_fillIndices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    fillPositions() {
        const ret = wasm.tessmesh_fillPositions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    strokeIndices() {
        const ret = wasm.tessmesh_strokeIndices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    strokePositions() {
        const ret = wasm.tessmesh_strokePositions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) TessMesh.prototype[Symbol.dispose] = TessMesh.prototype.free;

/**
 * @param {Float64Array} pts
 * @returns {Float64Array}
 */
export function aabbOfPoints(pts) {
    const ptr0 = passArrayF64ToWasm0(pts, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.aabbOfPoints(ptr0, len0);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {Float64Array} m
 * @param {number} x
 * @param {number} y
 * @returns {Float64Array}
 */
export function applyMat(m, x, y) {
    const ptr0 = passArrayF64ToWasm0(m, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.applyMat(ptr0, len0, x, y);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {number} w
 * @param {number} h
 * @param {number} start
 * @param {number} sweep
 * @param {number} ratio
 * @returns {Float64Array}
 */
export function arcPath(w, h, start, sweep, ratio) {
    const ret = wasm.arcPath(w, h, start, sweep, ratio);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * data: [childCount, (blobLen, <SubPath blob of blobLen f64s>)*]
 * op: 0 union, 1 subtract, 2 intersect, 3 exclude.
 * Returns a rings blob: [ringCount, (len, (x, y) * len)*].
 * @param {Float64Array} data
 * @param {number} op
 * @param {number} accuracy
 * @param {number} flatten_tolerance
 * @returns {Float64Array}
 */
export function booleanOp(data, op, accuracy, flatten_tolerance) {
    const ptr0 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.booleanOp(ptr0, len0, op, accuracy, flatten_tolerance);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * [r, g, b, a] or empty (parse failure — TS returns null).
 * @param {string} hex
 * @param {number} alpha
 * @returns {Float64Array}
 */
export function colorHexToRgba(hex, alpha) {
    const ptr0 = passStringToWasm0(hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.colorHexToRgba(ptr0, len0, alpha);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {number} h
 * @param {number} s
 * @param {number} v
 * @returns {Float64Array}
 */
export function colorHsvToRgb(h, s, v) {
    const ret = wasm.colorHsvToRgb(h, s, v);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {Float64Array}
 */
export function colorRgbToHsv(r, g, b) {
    const ret = wasm.colorRgbToHsv(r, g, b);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} a
 * @param {number} extra_opacity
 * @returns {string}
 */
export function colorRgbaToCss(r, g, b, a, extra_opacity) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.colorRgbaToCss(r, g, b, a, extra_opacity);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function colorRgbaToHex(r, g, b) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.colorRgbaToHex(r, g, b);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * @param {string} child_json
 * @param {number} snap_x
 * @param {number} snap_y
 * @param {number} snap_w
 * @param {number} snap_h
 * @param {number} old_w
 * @param {number} old_h
 * @param {number} new_w
 * @param {number} new_h
 * @returns {string}
 */
export function constrainChildJson(child_json, snap_x, snap_y, snap_w, snap_h, old_w, old_h, new_w, new_h) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(child_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.constrainChildJson(ptr0, len0, snap_x, snap_y, snap_w, snap_h, old_w, old_h, new_w, new_h);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeSceneJson(bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.decodeSceneJson(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {number} px
 * @param {number} py
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number}
 */
export function distToSegment(px, py, ax, ay, bx, by) {
    const ret = wasm.distToSegment(px, py, ax, ay, bx, by);
    return ret;
}

/**
 * @param {number} w
 * @param {number} h
 * @returns {Float64Array}
 */
export function ellipsePath(w, h) {
    const ret = wasm.ellipsePath(w, h);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {string} doc_json
 * @param {string} saved_at
 * @returns {Uint8Array}
 */
export function encodeSceneBytes(doc_json, saved_at) {
    const ptr0 = passStringToWasm0(doc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(saved_at, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.encodeSceneBytes(ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * @param {Float64Array} coords
 * @param {number} tolerance
 * @returns {Float64Array}
 */
export function flattenCubic(coords, tolerance) {
    const ptr0 = passArrayF64ToWasm0(coords, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.flattenCubic(ptr0, len0, tolerance);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {Float64Array} blob
 * @param {number} tolerance
 * @returns {Float64Array}
 */
export function flattenSubPaths(blob, tolerance) {
    const ptr0 = passArrayF64ToWasm0(blob, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.flattenSubPaths(ptr0, len0, tolerance);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * {unitsPerEm, ascender, descender, lineGap} in font units; "null" on bad id.
 * @param {number} id
 * @returns {string}
 */
export function fontMetricsJson(id) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.fontMetricsJson(id);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Glyph outline as a SubPath blob in FONT UNITS, y-down (baseline at 0).
 * Empty for whitespace/missing glyphs or a bad font id.
 * @param {number} id
 * @param {number} glyph_id
 * @returns {Float64Array}
 */
export function glyphSubPaths(id, glyph_id) {
    const ret = wasm.glyphSubPaths(id, glyph_id);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {string} op_json
 * @returns {string}
 */
export function invertOpJson(op_json) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(op_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.invertOpJson(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Shaped layout. Params JSON: {text, size, lineHeight, letterSpacing,
 * width, height, alignH: 0|1|2, alignV: 0|1|2, autoResize: 0|1|2}.
 * Returns {ascent, lineHeightPx, totalWidth, totalHeight, lines: [{text,
 * width, x, baseline, glyphs: [gid, x, y]*flat}]} or "null".
 * @param {number} id
 * @param {string} params_json
 * @returns {string}
 */
export function layoutTextJson(id, params_json) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.layoutTextJson(id, ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * @param {number} w
 * @returns {Float64Array}
 */
export function linePath(w) {
    const ret = wasm.linePath(w);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Register font bytes; returns a font id, or -1 if the face fails to parse.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function loadFont(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.loadFont(ptr0, len0);
    return ret;
}

/**
 * @param {Float64Array} m
 * @returns {Float64Array}
 */
export function matInvert(m) {
    const ptr0 = passArrayF64ToWasm0(m, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.matInvert(ptr0, len0);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {Float64Array} m1
 * @param {Float64Array} m2
 * @returns {Float64Array}
 */
export function matMultiply(m1, m2) {
    const ptr0 = passArrayF64ToWasm0(m1, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(m2, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.matMultiply(ptr0, len0, ptr1, len1);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {number} deg
 * @returns {Float64Array}
 */
export function matRotateDeg(deg) {
    const ret = wasm.matRotateDeg(deg);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {string} doc_json
 * @returns {string}
 */
export function migrateDocumentJson(doc_json) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(doc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.migrateDocumentJson(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * @param {Float64Array} vertices
 * @param {Float64Array} edges
 * @returns {Float64Array}
 */
export function networkToSubPaths(vertices, edges) {
    const ptr0 = passArrayF64ToWasm0(vertices, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(edges, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.networkToSubPaths(ptr0, len0, ptr1, len1);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} rotation
 * @param {boolean} flip_h
 * @param {boolean} flip_v
 * @returns {Float64Array}
 */
export function nodeLocalMatrix(x, y, w, h, rotation, flip_h, flip_v) {
    const ret = wasm.nodeLocalMatrix(x, y, w, h, rotation, flip_h, flip_v);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {number} px
 * @param {number} py
 * @param {number} cx
 * @param {number} cy
 * @param {number} rx
 * @param {number} ry
 * @returns {boolean}
 */
export function pointInEllipse(px, py, cx, cy, rx, ry) {
    const ret = wasm.pointInEllipse(px, py, cx, cy, rx, ry);
    return ret !== 0;
}

/**
 * @param {number} px
 * @param {number} py
 * @param {Float64Array} ring_data
 * @param {Uint32Array} ring_lens
 * @param {boolean} even_odd
 * @returns {boolean}
 */
export function pointInPolygonRings(px, py, ring_data, ring_lens, even_odd) {
    const ptr0 = passArrayF64ToWasm0(ring_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(ring_lens, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.pointInPolygonRings(px, py, ptr0, len0, ptr1, len1, even_odd);
    return ret !== 0;
}

/**
 * @param {number} px
 * @param {number} py
 * @param {number} w
 * @param {number} h
 * @param {number} tl
 * @param {number} tr
 * @param {number} br
 * @param {number} bl
 * @returns {boolean}
 */
export function pointInRoundedRect(px, py, w, h, tl, tr, br, bl) {
    const ret = wasm.pointInRoundedRect(px, py, w, h, tl, tr, br, bl);
    return ret !== 0;
}

/**
 * @param {number} w
 * @param {number} h
 * @param {number} points
 * @returns {Float64Array}
 */
export function polygonPath(w, h, points) {
    const ret = wasm.polygonPath(w, h, points);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {number} w
 * @param {number} h
 * @param {number} tl
 * @param {number} tr
 * @param {number} br
 * @param {number} bl
 * @returns {Float64Array}
 */
export function roundedRectPath(w, h, tl, tr, br, bl) {
    const ret = wasm.roundedRectPath(w, h, tl, tr, br, bl);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @returns {Float32Array}
 */
export function signedDistanceField(mask, width, height) {
    const ptr0 = passArray8ToWasm0(mask, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.signedDistanceField(ptr0, len0, width, height);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * @param {number} w
 * @param {number} h
 * @param {number} points
 * @param {number} inner_ratio
 * @returns {Float64Array}
 */
export function starPath(w, h, points, inner_ratio) {
    const ret = wasm.starPath(w, h, points, inner_ratio);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {Float64Array} blob
 * @param {number} precision
 * @returns {string}
 */
export function subPathsToSvg(blob, precision) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passArrayF64ToWasm0(blob, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.subPathsToSvg(ptr0, len0, precision);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Tessellate one node's geometry from its SubPath blob.
 * stroke_align: 0 = CENTER, 1 = INSIDE, 2 = OUTSIDE (inside/outside meshes
 * are tessellated at double width; the renderer stencil-clips them against
 * the fill mesh). A dash pattern splits the outline before stroking.
 * @param {Float64Array} blob
 * @param {boolean} even_odd
 * @param {number} stroke_width
 * @param {number} stroke_align
 * @param {Float64Array} dash
 * @param {number} fill_tolerance
 * @param {boolean} want_fill
 * @param {boolean} want_stroke
 * @returns {TessMesh}
 */
export function tessellateNode(blob, even_odd, stroke_width, stroke_align, dash, fill_tolerance, want_fill, want_stroke) {
    const ptr0 = passArrayF64ToWasm0(blob, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(dash, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.tessellateNode(ptr0, len0, even_odd, stroke_width, stroke_align, ptr1, len1, fill_tolerance, want_fill, want_stroke);
    return TessMesh.__wrap(ret);
}

/**
 * @param {Float64Array} m
 * @param {number} w
 * @param {number} h
 * @returns {Float64Array}
 */
export function transformedRectAabb(m, w, h) {
    const ptr0 = passArrayF64ToWasm0(m, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.transformedRectAabb(ptr0, len0, w, h);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./polyform_core_bg.js": import0,
    };
}

const SceneHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_scenehandle_free(ptr, 1));
const SpatialIndexFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_spatialindex_free(ptr, 1));
const TessMeshFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tessmesh_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('polyform_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
