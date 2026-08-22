// The shader registry: every shader the app can name, built-in or from the
// open project's shaders/ directory, with a status the UI can repeat out loud.
//
// Two rules carried from the rest of the codebase:
//
//   - A value stored, shown and ignored is a lie (F-30). A material whose
//     shader is missing or broken must surface that state — so the registry
//     tracks status per shader, and `resolve()` never invents a silent
//     default for an id it does not know.
//   - Refuse loudly, never truncate. A manifest with 13 uniforms is an error
//     naming the shader, not a shader with 12 uniforms (the 8-gradient-stop
//     silent truncation is precedent we are deliberately not following).
//
// Validation is zod because the manifest is user-authored JSON off disk —
// the same reason agent inputs are zod-validated in main/mcp.ts.

import { z } from 'zod'
import type { MaterialRef, MaterialUniformValue, RGBA, Vec2 } from '../types'

export type ShaderClass = 'procedural' | 'base' | 'sdf' | 'backdrop'

export interface UniformSpec {
  key: string
  label: string
  type: 'float' | 'color' | 'vec2' | 'bool' | 'enum'
  default: MaterialUniformValue
  min?: number
  max?: number
  step?: number
  options?: string[]
}

export interface ShaderManifest {
  id: string
  name: string
  class: ShaderClass
  uniforms: UniformSpec[]
  /** What draws where the shader cannot (no GPU for a project shader). */
  fallback: RGBA
}

/** Class inputs a twin may read — the same data the island binds as textures. */
export interface TwinInputs {
  /** sdf class: signed distances, raster px, negative inside (edt.ts). */
  sdf?: Float32Array
  /** base class: the node's own fills, straight RGBA bytes. */
  src?: Uint8ClampedArray
  /** Device pixels per document unit at this raster (uniform block info.z). */
  pxScale: number
}

/** The per-pixel CPU twin every BUILT-IN shader ships. x/y in raster pixels. */
export type ShaderTwin = (
  x: number,
  y: number,
  width: number,
  height: number,
  uniforms: Record<string, MaterialUniformValue>,
  inputs: TwinInputs,
) => RGBA

export interface RegisteredShader {
  manifest: ShaderManifest
  /** WGSL body: `fn material(p: vec2f, size: vec2f) -> vec4f` plus helpers. */
  wgsl: string
  /** Present on built-ins only; project shaders are WGSL-only by design. */
  twin?: ShaderTwin
  builtin: boolean
}

export type ShaderStatus =
  | { kind: 'ready' }
  | { kind: 'failed'; message: string }
  | { kind: 'missing' }

/** How many uniforms one shader may declare — one vec4 slot each on the GPU. */
export const MAX_UNIFORMS = 12

const rgba = z.object({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
  a: z.number().min(0).max(1),
})
const vec2 = z.object({ x: z.number(), y: z.number() })

const uniformSpec = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/, 'keys are camelCase, 1-32 chars'),
    label: z.string().min(1).max(48),
    type: z.enum(['float', 'color', 'vec2', 'bool', 'enum']),
    default: z.union([z.number(), z.boolean(), rgba, vec2]),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    options: z.array(z.string().min(1).max(32)).min(2).max(16).optional(),
  })
  .superRefine((u, ctx) => {
    const bad = (msg: string) => ctx.addIssue({ code: 'custom', message: `uniform "${u.key}": ${msg}` })
    if (u.type === 'float' && typeof u.default !== 'number') bad('float default must be a number')
    if (u.type === 'bool' && typeof u.default !== 'boolean') bad('bool default must be true/false')
    if (u.type === 'enum') {
      if (!u.options) bad('enum needs options')
      if (typeof u.default !== 'number' || !Number.isInteger(u.default)) bad('enum default is an option index')
      else if (u.options && (u.default < 0 || u.default >= u.options.length)) bad('enum default out of range')
    }
    if (u.type === 'color' && (typeof u.default !== 'object' || !('r' in (u.default as object))))
      bad('color default must be {r,g,b,a}')
    if (u.type === 'vec2' && (typeof u.default !== 'object' || !('x' in (u.default as object))))
      bad('vec2 default must be {x,y}')
  })

const manifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'ids are lowercase, 1-64 chars'),
  name: z.string().min(1).max(48),
  class: z.enum(['procedural', 'base', 'sdf', 'backdrop']),
  uniforms: z
    .array(uniformSpec)
    .max(MAX_UNIFORMS, `a shader may declare at most ${MAX_UNIFORMS} uniforms`)
    .superRefine((list, ctx) => {
      const seen = new Set<string>()
      for (const u of list) {
        if (seen.has(u.key))
          ctx.addIssue({ code: 'custom', message: `duplicate uniform key "${u.key}"` })
        seen.add(u.key)
      }
    }),
  fallback: rgba,
})

// ---------------------------------------------------------------------------

const shaders = new Map<string, RegisteredShader>()
const statuses = new Map<string, ShaderStatus>()
let generation = 0

/** Bumps whenever the set of shaders changes — cache keys include it so a
 *  reloaded project shader cannot serve stale rasters. */
export function shaderGeneration(): number {
  return generation
}

export function registerBuiltin(shader: Omit<RegisteredShader, 'builtin'>): void {
  const parsed = manifestSchema.safeParse(shader.manifest)
  if (!parsed.success) {
    // A malformed BUILT-IN is a programming error; fail the session loudly
    // rather than shipping a shader whose manifest and twin disagree.
    throw new Error(`built-in shader "${shader.manifest?.id}" has an invalid manifest: ${parsed.error.message}`)
  }
  shaders.set(shader.manifest.id, { ...shader, builtin: true })
  statuses.set(shader.manifest.id, { kind: 'ready' })
  generation++
}

/**
 * Replace the project-shader set from the raw files main returned. Built-ins
 * are untouched. Every entry lands with a status — a shader that failed
 * validation is still listed, carrying its error, so the Inspector can name
 * it instead of showing a hole where the shader should be.
 */
export function loadProjectShaders(files: { name: string; manifestText?: string; wgsl?: string; error?: string }[]): void {
  for (const id of [...shaders.keys()]) {
    if (!shaders.get(id)!.builtin) shaders.delete(id)
  }
  for (const id of [...statuses.keys()]) {
    if (id.startsWith('project:')) statuses.delete(id)
  }
  for (const file of files) {
    const id = `project:${file.name}`
    if (file.error || !file.manifestText || !file.wgsl) {
      statuses.set(id, { kind: 'failed', message: file.error ?? 'missing shader.json or shader.wgsl' })
      continue
    }
    let manifestJson: unknown
    try {
      manifestJson = JSON.parse(file.manifestText)
    } catch (err) {
      statuses.set(id, { kind: 'failed', message: `shader.json is not valid JSON: ${(err as Error).message}` })
      continue
    }
    const parsed = manifestSchema.safeParse(manifestJson)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      statuses.set(id, { kind: 'failed', message: first ? `${first.path.join('.')}: ${first.message}` : 'invalid manifest' })
      continue
    }
    // v1 boundary: user shaders may not sample the backdrop or the SDF —
    // those classes carry renderer obligations (pass splits, distance
    // fields) that user content cannot be allowed to impose yet.
    if (parsed.data.class === 'backdrop' || parsed.data.class === 'sdf') {
      statuses.set(id, {
        kind: 'failed',
        message: `class "${parsed.data.class}" is reserved for built-in shaders in this release`,
      })
      continue
    }
    const manifest: ShaderManifest = { ...(parsed.data as ShaderManifest), id }
    shaders.set(id, { manifest, wgsl: file.wgsl, builtin: false })
    statuses.set(id, { kind: 'ready' })
  }
  generation++
}

export function getShader(id: string): RegisteredShader | null {
  return shaders.get(id) ?? null
}

export function shaderStatus(id: string): ShaderStatus {
  return statuses.get(id) ?? (shaders.has(id) ? { kind: 'ready' } : { kind: 'missing' })
}

/** Mark a shader failed after the fact (island compile errors land here). */
export function markShaderFailed(id: string, message: string): void {
  if (statuses.get(id)?.kind === 'failed') return
  statuses.set(id, { kind: 'failed', message })
  generation++
}

export function listShaders(): RegisteredShader[] {
  return [...shaders.values()]
}

/**
 * A material as the renderer consumes it: manifest defaults overlaid with the
 * node's stored values, clamped to the manifest's ranges. Unknown uniform
 * keys are DROPPED (a project shader may have removed one) and out-of-range
 * enum indexes snap to the default — stored garbage must not reach a shader.
 */
export function resolveUniforms(
  manifest: ShaderManifest,
  material: MaterialRef,
): Record<string, MaterialUniformValue> {
  const out: Record<string, MaterialUniformValue> = {}
  for (const spec of manifest.uniforms) {
    const stored = material.uniforms[spec.key]
    let value: MaterialUniformValue = stored ?? structuredClone(spec.default)
    if (spec.type === 'float' && typeof value === 'number') {
      if (spec.min !== undefined) value = Math.max(spec.min, value)
      if (spec.max !== undefined) value = Math.min(spec.max, value)
    } else if (spec.type === 'enum') {
      const n = typeof value === 'number' ? Math.floor(value) : -1
      value = spec.options && n >= 0 && n < spec.options.length ? n : (spec.default as number)
    } else if (spec.type === 'float' || spec.type === 'bool') {
      if (typeof value !== typeof spec.default) value = structuredClone(spec.default)
    } else if (spec.type === 'color') {
      value = isRgba(value) ? value : structuredClone(spec.default)
    } else if (spec.type === 'vec2') {
      value = isVec2(value) ? value : structuredClone(spec.default)
    }
    out[spec.key] = value
  }
  return out
}

function isRgba(v: MaterialUniformValue): v is RGBA {
  return typeof v === 'object' && v !== null && 'r' in v && 'g' in v && 'b' in v && 'a' in v
}
function isVec2(v: MaterialUniformValue): v is Vec2 {
  return typeof v === 'object' && v !== null && 'x' in v && 'y' in v && !('r' in v)
}

/** Test seam: forget everything, including built-ins. */
export function resetRegistryForTests(): void {
  shaders.clear()
  statuses.clear()
  generation++
}
