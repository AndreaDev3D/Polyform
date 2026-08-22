// The registry's promises: loud refusals with the shader named, statuses the
// UI can repeat verbatim, and uniform resolution that never lets stored
// garbage reach a shader.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_UNIFORMS,
  getShader,
  listShaders,
  loadProjectShaders,
  markShaderFailed,
  registerBuiltin,
  resetRegistryForTests,
  resolveUniforms,
  shaderGeneration,
  shaderStatus,
  type ShaderManifest,
} from './registry'
import { stripes } from './builtins/stripes'

const gray = { r: 0.5, g: 0.5, b: 0.5, a: 1 }

function manifest(over: Partial<ShaderManifest> = {}): ShaderManifest {
  return { id: 'thing', name: 'Thing', class: 'procedural', uniforms: [], fallback: gray, ...over }
}

beforeEach(() => {
  resetRegistryForTests()
})

describe('shader registry', () => {
  it('registers a built-in and reports it ready', () => {
    registerBuiltin(stripes)
    expect(getShader('stripes')?.builtin).toBe(true)
    expect(shaderStatus('stripes')).toEqual({ kind: 'ready' })
  })

  it('throws on a malformed built-in — a programming error, not a status', () => {
    expect(() =>
      registerBuiltin({ manifest: manifest({ id: 'BAD ID' }), wgsl: '' }),
    ).toThrow(/invalid manifest/)
  })

  it('an unknown id is missing, not silently defaulted', () => {
    expect(shaderStatus('nope')).toEqual({ kind: 'missing' })
    expect(getShader('nope')).toBeNull()
  })

  it('loads a valid project shader under the project: namespace', () => {
    loadProjectShaders([
      { name: 'gold', manifestText: JSON.stringify(manifest({ id: 'gold' })), wgsl: 'fn material() {}' },
    ])
    expect(getShader('project:gold')).not.toBeNull()
    expect(getShader('project:gold')?.builtin).toBe(false)
    expect(shaderStatus('project:gold')).toEqual({ kind: 'ready' })
  })

  it('carries main-side errors through as failed status', () => {
    loadProjectShaders([{ name: 'big', error: 'shader.wgsl is larger than 64 KiB' }])
    expect(shaderStatus('project:big')).toEqual({ kind: 'failed', message: 'shader.wgsl is larger than 64 KiB' })
  })

  it('names the schema violation instead of truncating', () => {
    const tooMany = manifest({
      uniforms: Array.from({ length: MAX_UNIFORMS + 1 }, (_, i) => ({
        key: `u${i}`,
        label: `U${i}`,
        type: 'float' as const,
        default: 0,
      })),
    })
    loadProjectShaders([{ name: 'greedy', manifestText: JSON.stringify(tooMany), wgsl: 'x' }])
    const status = shaderStatus('project:greedy')
    expect(status.kind).toBe('failed')
    expect((status as { message: string }).message).toMatch(/at most 12 uniforms/)
  })

  it('rejects duplicate uniform keys and bad enum defaults', () => {
    const dup = manifest({
      uniforms: [
        { key: 'a', label: 'A', type: 'float', default: 0 },
        { key: 'a', label: 'A again', type: 'float', default: 1 },
      ],
    })
    loadProjectShaders([{ name: 'dup', manifestText: JSON.stringify(dup), wgsl: 'x' }])
    expect((shaderStatus('project:dup') as { message: string }).message).toMatch(/duplicate uniform key/)

    const badEnum = manifest({
      uniforms: [{ key: 'mode', label: 'Mode', type: 'enum', default: 5, options: ['One', 'Two'] }],
    })
    loadProjectShaders([{ name: 'oor', manifestText: JSON.stringify(badEnum), wgsl: 'x' }])
    expect((shaderStatus('project:oor') as { message: string }).message).toMatch(/out of range/)
  })

  it('reserves backdrop and sdf classes for built-ins in v1', () => {
    loadProjectShaders([
      { name: 'myglass', manifestText: JSON.stringify(manifest({ id: 'myglass', class: 'backdrop' })), wgsl: 'x' },
    ])
    expect((shaderStatus('project:myglass') as { message: string }).message).toMatch(/reserved for built-in/)
  })

  it('reload replaces project shaders and bumps the generation, built-ins untouched', () => {
    registerBuiltin(stripes)
    loadProjectShaders([{ name: 'one', manifestText: JSON.stringify(manifest({ id: 'one' })), wgsl: 'x' }])
    const g = shaderGeneration()
    loadProjectShaders([{ name: 'two', manifestText: JSON.stringify(manifest({ id: 'two' })), wgsl: 'x' }])
    expect(getShader('project:one')).toBeNull()
    expect(shaderStatus('project:one')).toEqual({ kind: 'missing' })
    expect(getShader('project:two')).not.toBeNull()
    expect(getShader('stripes')).not.toBeNull()
    expect(shaderGeneration()).toBeGreaterThan(g)
    expect(listShaders().map((s) => s.manifest.id).sort()).toEqual(['project:two', 'stripes'])
  })

  it('markShaderFailed records island compile errors after the fact', () => {
    loadProjectShaders([{ name: 'comp', manifestText: JSON.stringify(manifest({ id: 'comp' })), wgsl: 'x' }])
    markShaderFailed('project:comp', 'wgsl: unresolved identifier at 3:14')
    expect(shaderStatus('project:comp')).toEqual({
      kind: 'failed',
      message: 'wgsl: unresolved identifier at 3:14',
    })
  })
})

describe('resolveUniforms', () => {
  it('fills defaults, clamps floats, snaps bad enums, drops unknown keys', () => {
    const m = manifest({
      uniforms: [
        { key: 'amount', label: 'Amount', type: 'float', default: 0.5, min: 0, max: 1 },
        { key: 'mode', label: 'Mode', type: 'enum', default: 1, options: ['A', 'B', 'C'] },
        { key: 'tint', label: 'Tint', type: 'color', default: gray },
      ],
    })
    const resolved = resolveUniforms(m, {
      shaderId: 'thing',
      uniforms: { amount: 7, mode: 99, ghost: 3, tint: true },
    })
    expect(resolved).toEqual({ amount: 1, mode: 1, tint: gray })
  })
})

describe('the stripes twin', () => {
  const uniforms = Object.fromEntries(stripes.manifest.uniforms.map((u) => [u.key, u.default]))

  it('is deterministic and varies along exactly one axis in stripe mode', () => {
    const flat = { ...uniforms, angle: 0, softness: 0, width: 10 }
    const a = stripes.twin!(3, 0, 100, 100, flat)
    const b = stripes.twin!(3, 57, 100, 100, flat)
    expect(a).toEqual(b) // angle 0 stripes run vertically: y must not matter
    // sin(t·π) flips sign when t crosses 1, i.e. one full width later — the
    // opposite band at width 10 lives at x∈(10,20), not at x=8.
    const c = stripes.twin!(13, 0, 100, 100, flat)
    expect(Math.abs(c.r - a.r)).toBeGreaterThan(0.5)
  })

  it('checker mode varies along both axes', () => {
    const flat = { ...uniforms, mode: 1, angle: 0, softness: 0, width: 10 }
    const a = stripes.twin!(3, 3, 100, 100, flat)
    const d = stripes.twin!(3, 13, 100, 100, flat)
    expect(Math.abs(d.r - a.r)).toBeGreaterThan(0.5)
  })
})
