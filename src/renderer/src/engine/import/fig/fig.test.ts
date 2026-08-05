// The `.fig` reader, tested against bytes this file writes itself.
//
// There is no committed .fig fixture on purpose: a real export is somebody's
// design, and the format's own self-description means a synthetic file exercises
// the same code paths. What a synthetic file cannot prove is that the LAYOUT
// guess is right — so the encoder here is the inverse of the decoder, and the
// float cases are pinned to exact bytes. The layout itself was checked against
// three real exports (version 106): the schema reader consumed exactly
// 72042/72042 bytes and produced 629 definitions, and the decoded sizes came out
// as round numbers (1024×1024, 2048×2048), which is what a wrong float rotation
// would not do.

import { describe, expect, it } from 'vitest'
import { decodeKiwiSchema, KiwiDecoder, KIWI_TYPE, type KiwiDefinition } from '../../../../../shared/fig/kiwi'
import { readCanvasChunks, readZip, readFig, type FigInflators } from '../../../../../shared/fig/container'

// --- a minimal Kiwi writer, only for tests ---------------------------------

class Writer {
  private bytes: number[] = []
  get out(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
  byte(b: number): this {
    this.bytes.push(b & 0xff)
    return this
  }
  varuint(v: number): this {
    let value = v
    for (;;) {
      const b = value % 128
      value = Math.floor(value / 128)
      if (value === 0) return this.byte(b)
      this.byte(b | 0x80)
    }
  }
  varint(v: number): this {
    return this.varuint(v < 0 ? -v * 2 - 1 : v * 2)
  }
  /** Inverse of KiwiReader.float: rotate the exponent down, and collapse anything whose low byte is zero. */
  float(v: number): this {
    const buf = new ArrayBuffer(4)
    new Float32Array(buf)[0] = v
    const bits = new Uint32Array(buf)[0]
    const rotated = ((bits >>> 23) | (bits << 9)) >>> 0
    if ((rotated & 0xff) === 0) return this.byte(0)
    return this.byte(rotated).byte(rotated >>> 8).byte(rotated >>> 16).byte(rotated >>> 24)
  }
  string(s: string): this {
    for (const b of new TextEncoder().encode(s)) this.byte(b)
    return this.byte(0)
  }
}

function encodeSchema(defs: KiwiDefinition[]): Uint8Array {
  const w = new Writer()
  w.varuint(defs.length)
  const kinds = { ENUM: 0, STRUCT: 1, MESSAGE: 2 }
  for (const d of defs) {
    w.string(d.name).byte(kinds[d.kind]).varuint(d.fields.length)
    for (const f of d.fields) w.string(f.name).varint(f.type).byte(f.isArray ? 1 : 0).varuint(f.value)
  }
  return w.out
}

// A schema with one of everything the real files use.
const SCHEMA: KiwiDefinition[] = [
  {
    name: 'NodeType',
    kind: 'ENUM',
    fields: [
      { name: 'FRAME', type: 0, isArray: false, value: 1 },
      { name: 'ROUNDED_RECTANGLE', type: 0, isArray: false, value: 11 },
    ],
  },
  {
    name: 'Vector',
    kind: 'STRUCT',
    fields: [
      { name: 'x', type: KIWI_TYPE.FLOAT, isArray: false, value: 1 },
      { name: 'y', type: KIWI_TYPE.FLOAT, isArray: false, value: 2 },
    ],
  },
  {
    name: 'NodeChange',
    kind: 'MESSAGE',
    fields: [
      { name: 'name', type: KIWI_TYPE.STRING, isArray: false, value: 1 },
      { name: 'type', type: 0, isArray: false, value: 2 },
      { name: 'size', type: 1, isArray: false, value: 3 },
      { name: 'visible', type: KIWI_TYPE.BOOL, isArray: false, value: 4 },
      { name: 'opacity', type: KIWI_TYPE.FLOAT, isArray: false, value: 5 },
      { name: 'weights', type: KIWI_TYPE.INT, isArray: true, value: 6 },
      { name: 'localID', type: KIWI_TYPE.UINT64, isArray: false, value: 7 },
    ],
  },
  {
    name: 'Message',
    kind: 'MESSAGE',
    fields: [
      { name: 'nodeChanges', type: 2, isArray: true, value: 1 },
      { name: 'blobs', type: KIWI_TYPE.STRING, isArray: true, value: 2 },
    ],
  },
]

const SCHEMA_INDEX = { NodeType: 0, Vector: 1, NodeChange: 2, Message: 3 }

describe('kiwi schema', () => {
  it('round-trips a schema through the real decoder', () => {
    const defs = decodeKiwiSchema(encodeSchema(SCHEMA))
    expect(defs).toEqual(SCHEMA)
  })

  it('rejects trailing bytes rather than ignoring them', () => {
    const good = encodeSchema(SCHEMA)
    const padded = new Uint8Array(good.length + 3)
    padded.set(good)
    expect(() => decodeKiwiSchema(padded)).toThrow(/trailing bytes/)
  })

  it('rejects an unknown definition kind', () => {
    const bytes = encodeSchema([{ name: 'X', kind: 'ENUM', fields: [] }])
    bytes[bytes.length - 2] = 7 // the kind byte
    expect(() => decodeKiwiSchema(bytes)).toThrow(/unknown definition kind/)
  })
})

describe('kiwi messages', () => {
  const decoder = new KiwiDecoder(SCHEMA)

  it('decodes a message with every value shape in it', () => {
    const w = new Writer()
    w.varuint(1) // Message.nodeChanges
    w.varuint(2) // two nodes
    // node 1
    w.varuint(1).string('logo-large-dark-text')
    w.varuint(2).varuint(1) // type = FRAME
    w.varuint(3).float(1024).float(1024) // size struct: fields in order, no ids
    w.varuint(4).byte(1) // visible
    w.varuint(5).float(0.5)
    w.varuint(6).varuint(3).varint(-2).varint(0).varint(7) // weights array
    w.varuint(7).varuint(4294967296) // a 64-bit id, past what a shift would survive
    w.varuint(0) // end of node 1
    // node 2
    w.varuint(2).varuint(11) // type = ROUNDED_RECTANGLE
    w.varuint(0)
    w.varuint(0) // end of Message

    const root = decoder.decode(w.out, 'Message')
    expect(root.nodeChanges).toEqual([
      {
        name: 'logo-large-dark-text',
        type: 'FRAME',
        size: { x: 1024, y: 1024 },
        visible: true,
        opacity: 0.5,
        weights: [-2, 0, 7],
        localID: 4294967296,
      },
      { type: 'ROUNDED_RECTANGLE' },
    ])
  })

  it('returns enum MEMBER NAMES, and the number when a member is unknown', () => {
    const w = new Writer()
    w.varuint(1).varuint(1)
    w.varuint(2).varuint(99) // not in the enum
    w.varuint(0).varuint(0)
    const root = decoder.decode(w.out, 'Message')
    expect((root.nodeChanges as Record<string, unknown>[])[0].type).toBe(99)
  })

  it('refuses an unknown field id instead of guessing', () => {
    const w = new Writer()
    w.varuint(1).varuint(1)
    w.varuint(42).varuint(0) // no field 42 in NodeChange
    expect(() => decoder.decode(w.out, 'Message')).toThrow(/unknown field id 42 in NodeChange/)
  })

  it('names the definition when the root is missing', () => {
    expect(() => decoder.decode(new Uint8Array([0]), 'Nope')).toThrow(/no definition named Nope/)
  })
})

describe('kiwi floats', () => {
  const decoder = new KiwiDecoder(SCHEMA)
  const decodeFloat = (bytes: number[]) => {
    const w = new Writer()
    w.varuint(1).varuint(1).varuint(5)
    for (const b of bytes) w.byte(b)
    w.varuint(0).varuint(0)
    const root = decoder.decode(w.out, 'Message')
    return (root.nodeChanges as Record<string, unknown>[])[0].opacity
  }

  // Pinned bytes, so a rotation error cannot hide behind a symmetric encoder.
  it('reads the one-byte zero', () => {
    expect(decodeFloat([0])).toBe(0)
  })
  it('reads 1024 as the real files encode it', () => {
    expect(decodeFloat([0x89, 0x00, 0x00, 0x00])).toBe(1024)
  })
  it('reads 1', () => {
    expect(decodeFloat([0x7f, 0x00, 0x00, 0x00])).toBe(1)
  })
  it('reads -1 (the sign rides in the SECOND byte after the rotation)', () => {
    expect(decodeFloat([0x7f, 0x01, 0x00, 0x00])).toBe(-1)
  })
  it('reads 2048.5, whose mantissa survives the rotation', () => {
    expect(decodeFloat([0x8a, 0x00, 0x10, 0x00])).toBe(2048.5)
  })

  it('round-trips the values a design actually contains, EXACTLY', () => {
    // Compared against Math.fround(v), not v: the wire format is float32, so
    // -159.1 comes back as -159.10000610351562 and that is correct rather than
    // approximate. An epsilon here would hide a real rotation bug in the noise.
    for (const v of [0, 1, -1, 0.5, 24, 64, 205, 515, 1024, 2048.5, 0.8509804010391235, -159.1, 3296, 1e-7]) {
      const w = new Writer()
      w.float(v)
      expect(decodeFloat([...w.out])).toBe(Math.fround(v))
    }
  })
})

// --- container --------------------------------------------------------------

/** Build a STORED-only ZIP, which is what Figma writes. */
function makeZip(files: Record<string, Uint8Array>): Uint8Array {
  const parts: number[] = []
  const central: number[] = []
  const push16 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff)
  const push32 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = [...new TextEncoder().encode(name)]
    const localOff = parts.length
    push32(parts, 0x04034b50)
    push16(parts, 20)
    push16(parts, 0)
    push16(parts, 0) // stored
    push16(parts, 0)
    push16(parts, 0)
    push32(parts, 0) // crc, unchecked by the reader
    push32(parts, data.length)
    push32(parts, data.length)
    push16(parts, nameBytes.length)
    push16(parts, 0)
    parts.push(...nameBytes, ...data)

    push32(central, 0x02014b50)
    push16(central, 20)
    push16(central, 20)
    push16(central, 0)
    push16(central, 0) // stored
    push16(central, 0)
    push16(central, 0)
    push32(central, 0)
    push32(central, data.length)
    push32(central, data.length)
    push16(central, nameBytes.length)
    push16(central, 0)
    push16(central, 0)
    push16(central, 0)
    push16(central, 0)
    push32(central, 0)
    push32(central, localOff)
    central.push(...nameBytes)
  }
  const centralOff = parts.length
  const out = [...parts, ...central]
  push32(out, 0x06054b50)
  push16(out, 0)
  push16(out, 0)
  push16(out, Object.keys(files).length)
  push16(out, Object.keys(files).length)
  push32(out, central.length)
  push32(out, centralOff)
  push16(out, 0)
  return new Uint8Array(out)
}

function makeCanvas(version: number, chunks: Uint8Array[]): Uint8Array {
  const head = [...new TextEncoder().encode('fig-kiwi')]
  const push32 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
  push32(head, version)
  for (const c of chunks) {
    push32(head, c.length)
    head.push(...c)
  }
  return new Uint8Array(head)
}

/** Identity "decompression", so the container is tested without a codec. */
const PASSTHROUGH: FigInflators = { inflateRaw: (b) => b, zstd: (b) => b }

describe('fig container', () => {
  it('reads a stored ZIP through its central directory', () => {
    const zip = makeZip({ 'canvas.fig': new Uint8Array([1, 2, 3]), 'meta.json': new TextEncoder().encode('{"a":1}') })
    const entries = readZip(zip, PASSTHROUGH.inflateRaw)
    expect([...entries.keys()].sort()).toEqual(['canvas.fig', 'meta.json'])
    expect([...entries.get('canvas.fig')!]).toEqual([1, 2, 3])
  })

  it('says what is wrong when it is not a ZIP at all', () => {
    expect(() => readZip(new Uint8Array(40), PASSTHROUGH.inflateRaw)).toThrow(/no ZIP end-of-central-directory/)
  })

  it('splits canvas.fig into version and chunks', () => {
    const canvas = makeCanvas(106, [new Uint8Array([9, 9]), new Uint8Array([7])])
    const { version, chunks } = readCanvasChunks(canvas)
    expect(version).toBe(106)
    expect(chunks.map((c) => [...c])).toEqual([[9, 9], [7]])
  })

  it('rejects a canvas whose magic is not fig-kiwi', () => {
    const canvas = makeCanvas(106, [new Uint8Array([1]), new Uint8Array([2])])
    canvas[0] = 0x50
    expect(() => readCanvasChunks(canvas)).toThrow(/not a Figma canvas/)
  })

  it('rejects a chunk length that runs past the end', () => {
    const canvas = makeCanvas(106, [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5])])
    canvas[12] = 0xff // chunk 0 now claims 255 bytes
    expect(() => readCanvasChunks(canvas)).toThrow(/chunk claims 255 bytes/)
  })

  it('reads a whole synthetic .fig, schema and message and images', () => {
    const w = new Writer()
    w.varuint(1).varuint(1) // Message.nodeChanges, one node
    w.varuint(1).string('Frame 1')
    w.varuint(2).varuint(1)
    w.varuint(3).float(2048).float(2048)
    w.varuint(0).varuint(0)
    const fig = makeZip({
      'canvas.fig': makeCanvas(106, [encodeSchema(SCHEMA), w.out]),
      'meta.json': new TextEncoder().encode('{"fileName":"Synthetic"}'),
      'images/abc123': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
    const doc = readFig(fig, PASSTHROUGH)
    expect(doc.version).toBe(106)
    expect(doc.definitions).toHaveLength(SCHEMA.length)
    expect(doc.root.nodeChanges).toEqual([{ name: 'Frame 1', type: 'FRAME', size: { x: 2048, y: 2048 } }])
    expect(doc.archive.images.get('abc123')).toBeDefined()
    expect((doc.archive.meta as { fileName?: string } | null)?.fileName).toBe('Synthetic')
    expect(SCHEMA_INDEX.Message).toBe(3)
  })

  it('refuses a ZIP with no canvas.fig', () => {
    expect(() => readFig(makeZip({ 'meta.json': new Uint8Array([1]) }), PASSTHROUGH)).toThrow(/no canvas.fig/)
  })
})

// --- optional: report on a real export -------------------------------------
//
// Skipped unless POLYFORM_FIG points at one, because a real .fig is somebody's
// design and cannot be committed. This is how the reader gets checked against
// files it did not write:
//
//   POLYFORM_FIG="D:/…/OmniTecta.fig" npx vitest run fig.test.ts --reporter=verbose
//
// It asserts nothing about the CONTENT (that is the file's business) — only that
// the reader gets through it, and it prints an inventory, which is the input the
// node mapper and the fidelity report are built from.
const REAL = process.env.POLYFORM_FIG
describe.skipIf(!REAL)('a real .fig export', () => {
  it('reads end to end and reports what is inside', async () => {
    const [{ readFileSync }, zlib] = await Promise.all([import('node:fs'), import('node:zlib')])
    const inflators: FigInflators = {
      inflateRaw: (b) => new Uint8Array(zlib.inflateRawSync(b)),
      zstd: (b) => new Uint8Array(zlib.zstdDecompressSync(b)),
    }
    const doc = readFig(new Uint8Array(readFileSync(REAL!)), inflators)
    const nodes = (doc.root.nodeChanges ?? []) as Record<string, unknown>[]
    const byType = new Map<string, number>()
    for (const n of nodes) {
      const t = String(n.type ?? '(none)')
      byType.set(t, (byType.get(t) ?? 0) + 1)
    }
    const has = (key: string) => nodes.filter((n) => n[key] !== undefined).length
    console.log(
      [
        `  file:        ${REAL}`,
        `  version:     ${doc.version}   definitions: ${doc.definitions.length}`,
        `  nodes:       ${nodes.length}`,
        `  types:       ${[...byType].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}`,
        `  blobs:       ${((doc.root.blobs ?? []) as unknown[]).length}   images: ${doc.archive.images.size}`,
        `  fills:${has('fillPaints')} strokes:${has('strokePaints')} effects:${has('effects')} text:${has('textData')} vector:${has('vectorData')} autolayout:${has('stackMode')}`,
      ].join('\n'),
    )
    expect(doc.version).toBeGreaterThan(0)
    expect(nodes.length).toBeGreaterThan(0)
  })
})
