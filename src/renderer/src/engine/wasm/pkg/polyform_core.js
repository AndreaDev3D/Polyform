/* @ts-self-types="./polyform_core.d.ts" */

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
 * @returns {Float64Array}
 */
export function nodeLocalMatrix(x, y, w, h, rotation) {
    const ret = wasm.nodeLocalMatrix(x, y, w, h, rotation);
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

const SpatialIndexFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_spatialindex_free(ptr, 1));

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
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

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
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

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
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
