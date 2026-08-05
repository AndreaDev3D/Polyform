// Kiwi: a decoder for the binary serialization format `.fig` files use.
//
// Written rather than depended on, for three reasons: it is small and pure, it
// can be round-tripped against an encoder in its own test, and every dependency
// enters the installer and the third-party notices. See
// docs/research/Fig-Import-Spike.md.
//
// The format that matters here is that a `.fig` carries **its own schema**, so
// this decoder never hardcodes a field name or a version. It reads the schema
// out of the file, then decodes the message with it — which is why it is not
// coupled to whatever Figma shipped this week.
//
// Layout (verified byte-for-byte against three real exports, version 106: the
// schema reader consumes exactly 72042/72042 bytes and yields 629 definitions):
//
//   schema  := varuint count, then per definition:
//                name (NUL-terminated UTF-8), kind byte, varuint field count,
//                then per field: name, zigzag varint type, isArray byte,
//                varuint value (message field id, or enum member value)
//   message := per field: varuint id (0 ends the message), then the value
//   struct  := every field in declaration order, no ids and no terminator
//
// `type` is negative for a builtin and otherwise an index into the definition
// list, which is what makes nesting work without a compile step.

/** Builtin type tags. Negative by construction, so they cannot collide with a definition index. */
export const KIWI_TYPE = {
  BOOL: -1,
  BYTE: -2,
  INT: -3,
  UINT: -4,
  FLOAT: -5,
  STRING: -6,
  INT64: -7,
  UINT64: -8,
} as const

export type KiwiKind = 'ENUM' | 'STRUCT' | 'MESSAGE'

export interface KiwiField {
  name: string
  /** Builtin tag (negative) or an index into the definition list. */
  type: number
  isArray: boolean
  /** Field id for a MESSAGE, member value for an ENUM. */
  value: number
}

export interface KiwiDefinition {
  name: string
  kind: KiwiKind
  fields: KiwiField[]
}

export type KiwiValue = boolean | number | string | KiwiObject | KiwiValue[]
export interface KiwiObject {
  [key: string]: KiwiValue | undefined
}

const KINDS: KiwiKind[] = ['ENUM', 'STRUCT', 'MESSAGE']

/** Byte reader with Kiwi's variable-length encodings. */
export class KiwiReader {
  private i = 0

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.i
  }

  get done(): boolean {
    return this.i >= this.bytes.length
  }

  byte(): number {
    if (this.i >= this.bytes.length) throw new Error(`kiwi: read past end at ${this.i}`)
    return this.bytes[this.i++]
  }

  /**
   * LEB128, accumulated with multiplication rather than `<<`: a shift would wrap
   * at 32 bits and silently corrupt anything larger, and `.fig` files carry
   * 64-bit ids.
   */
  varuint(): number {
    let value = 0
    let shift = 0
    for (;;) {
      const b = this.byte()
      value += (b & 0x7f) * 2 ** shift
      shift += 7
      if (!(b & 0x80)) return value
      if (shift > 63) throw new Error('kiwi: varuint too long')
    }
  }

  /** Zigzag, so small negatives stay one byte. */
  varint(): number {
    const v = this.varuint()
    return v % 2 ? -((v + 1) / 2) : v / 2
  }

  /**
   * Kiwi's "var float": a single zero byte means 0, otherwise four bytes whose
   * exponent has been rotated into the low bits so that small round numbers
   * compress. Getting the rotation wrong yields plausible-looking garbage, so
   * the test pins exact values.
   */
  float(): number {
    if (this.bytes[this.i] === 0) {
      this.i++
      return 0
    }
    if (this.i + 4 > this.bytes.length) throw new Error(`kiwi: float past end at ${this.i}`)
    const bits =
      (this.bytes[this.i] | (this.bytes[this.i + 1] << 8) | (this.bytes[this.i + 2] << 16) | (this.bytes[this.i + 3] << 24)) >>> 0
    this.i += 4
    const rotated = ((bits << 23) | (bits >>> 9)) >>> 0
    const buf = new ArrayBuffer(4)
    new Uint32Array(buf)[0] = rotated
    return new Float32Array(buf)[0]
  }

  string(): string {
    const start = this.i
    while (this.byte() !== 0) {
      /* to the NUL */
    }
    return new TextDecoder().decode(this.bytes.subarray(start, this.i - 1))
  }

  bytesUntilEnd(): Uint8Array {
    const rest = this.bytes.subarray(this.i)
    this.i = this.bytes.length
    return rest
  }
}

/** Read the schema a `.fig` carries for itself. */
export function decodeKiwiSchema(bytes: Uint8Array): KiwiDefinition[] {
  const r = new KiwiReader(bytes)
  const count = r.varuint()
  const defs: KiwiDefinition[] = []
  for (let d = 0; d < count; d++) {
    const name = r.string()
    const kindByte = r.byte()
    const kind = KINDS[kindByte]
    if (!kind) throw new Error(`kiwi: unknown definition kind ${kindByte} for ${name}`)
    const fieldCount = r.varuint()
    const fields: KiwiField[] = []
    for (let f = 0; f < fieldCount; f++) {
      fields.push({ name: r.string(), type: r.varint(), isArray: !!r.byte(), value: r.varuint() })
    }
    defs.push({ name, kind, fields })
  }
  if (!r.done) throw new Error(`kiwi: ${bytes.length - r.offset} trailing bytes after the schema`)
  return defs
}

/**
 * A decoder bound to one schema.
 *
 * Enum values come back as their member NAME, not their number: a mapper that
 * switches on `'ROUNDED_RECTANGLE'` reads correctly, and one that switches on
 * `11` breaks silently the day the enum is renumbered.
 */
export class KiwiDecoder {
  private readonly byName: Map<string, KiwiDefinition>
  /** Field-id lookups, built once per definition rather than scanned per field. */
  private readonly fieldById: Map<KiwiDefinition, Map<number, KiwiField>> = new Map()
  private readonly enumByValue: Map<KiwiDefinition, Map<number, string>> = new Map()

  constructor(readonly definitions: KiwiDefinition[]) {
    this.byName = new Map(definitions.map((d) => [d.name, d]))
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  decode(bytes: Uint8Array, rootName: string): KiwiObject {
    const def = this.byName.get(rootName)
    if (!def) throw new Error(`kiwi: no definition named ${rootName}`)
    const value = this.readDefinition(new KiwiReader(bytes), def)
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`kiwi: ${rootName} is not a message or struct`)
    return value
  }

  private ids(def: KiwiDefinition): Map<number, KiwiField> {
    let map = this.fieldById.get(def)
    if (!map) {
      map = new Map(def.fields.map((f) => [f.value, f]))
      this.fieldById.set(def, map)
    }
    return map
  }

  private members(def: KiwiDefinition): Map<number, string> {
    let map = this.enumByValue.get(def)
    if (!map) {
      map = new Map(def.fields.map((f) => [f.value, f.name]))
      this.enumByValue.set(def, map)
    }
    return map
  }

  private readValue(r: KiwiReader, type: number): KiwiValue {
    switch (type) {
      case KIWI_TYPE.BOOL:
        return !!r.byte()
      case KIWI_TYPE.BYTE:
        return r.byte()
      case KIWI_TYPE.INT:
        return r.varint()
      case KIWI_TYPE.UINT:
        return r.varuint()
      case KIWI_TYPE.FLOAT:
        return r.float()
      case KIWI_TYPE.STRING:
        return r.string()
      case KIWI_TYPE.INT64:
        return r.varint()
      case KIWI_TYPE.UINT64:
        return r.varuint()
      default: {
        const def = this.definitions[type]
        if (!def) throw new Error(`kiwi: type index ${type} is not a definition`)
        return this.readDefinition(r, def)
      }
    }
  }

  private readDefinition(r: KiwiReader, def: KiwiDefinition): KiwiValue {
    if (def.kind === 'ENUM') {
      const v = r.varuint()
      // An unknown member is reported as the number: a file from a newer build
      // is a thing to notice, not a thing to crash on.
      return this.members(def).get(v) ?? v
    }
    const out: KiwiObject = {}
    if (def.kind === 'STRUCT') {
      for (const f of def.fields) out[f.name] = f.isArray ? this.readArray(r, f.type) : this.readValue(r, f.type)
      return out
    }
    const ids = this.ids(def)
    for (;;) {
      const id = r.varuint()
      if (id === 0) return out
      const f = ids.get(id)
      if (!f) throw new Error(`kiwi: unknown field id ${id} in ${def.name}`)
      out[f.name] = f.isArray ? this.readArray(r, f.type) : this.readValue(r, f.type)
    }
  }

  private readArray(r: KiwiReader, type: number): KiwiValue[] {
    const n = r.varuint()
    const out: KiwiValue[] = new Array(n)
    for (let i = 0; i < n; i++) out[i] = this.readValue(r, type)
    return out
  }
}
