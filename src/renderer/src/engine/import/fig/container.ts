// The `.fig` container: a ZIP holding a `canvas.fig`, which holds the schema and
// the document.
//
// Pure functions over bytes, with no Node and no DOM: the same code has to work
// in the renderer (File → Import) and in the headless CLI. Decompression is the
// one thing it cannot do itself, so it is injected — the caller passes the two
// primitives its platform has (`zlib` in Electron, DecompressionStream in a
// browser), and this file stays testable without either.
//
// Verified against three real exports (version 106). Two corrections to what the
// public write-ups say, both from the bytes rather than from reading:
//   - the ZIP entries are STORED, not deflated, including canvas.fig;
//   - chunk 0 is RAW deflate (no 78 da zlib header), not zlib-wrapped.

import { decodeKiwiSchema, KiwiDecoder, type KiwiObject } from './kiwi'

export interface FigInflators {
  /** Raw DEFLATE, no zlib wrapper — the schema chunk. */
  inflateRaw: (bytes: Uint8Array) => Uint8Array
  /** Zstandard — the message chunk on recent versions. */
  zstd: (bytes: Uint8Array) => Uint8Array
}

export interface FigArchive {
  /** Entry name → bytes, already decompressed. */
  entries: Map<string, Uint8Array>
  /** `images/<sha1>` payloads, keyed by the hash Figma named them with. */
  images: Map<string, Uint8Array>
  meta: KiwiObject | null
}

export interface FigDocument {
  /** Container version from canvas.fig (106 in every file seen so far). */
  version: number
  /** The schema the file carries for itself. */
  definitions: ReturnType<typeof decodeKiwiSchema>
  /** Root message — `NODE_CHANGES` in an exported file. */
  root: KiwiObject
  archive: FigArchive
}

const MAGIC = 'fig-kiwi'
const ZIP_EOCD = 0x06054b50
const ZIP_CENTRAL = 0x02014b50
const ZSTD_MAGIC = 0xfd2fb528

function u16(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8)
}
function u32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
}

/**
 * Read a ZIP by its central directory.
 *
 * Deliberately not by scanning for local headers: a local header's sizes can be
 * zero with the real values in a trailing data descriptor, and a scanner then
 * reads the wrong length. The central directory is the authority.
 */
export function readZip(buf: Uint8Array, inflateRaw: FigInflators['inflateRaw']): Map<string, Uint8Array> {
  let eocd = -1
  const floor = Math.max(0, buf.length - 66000) // 22-byte record + up to 64 KB comment
  for (let i = buf.length - 22; i >= floor; i--) {
    if (u32(buf, i) === ZIP_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a .fig file: no ZIP end-of-central-directory record')
  const count = u16(buf, eocd + 10)
  let off = u32(buf, eocd + 16)
  const entries = new Map<string, Uint8Array>()
  for (let i = 0; i < count; i++) {
    if (u32(buf, off) !== ZIP_CENTRAL) throw new Error(`corrupt .fig: bad central directory entry ${i}`)
    const method = u16(buf, off + 10)
    const compSize = u32(buf, off + 20)
    const nameLen = u16(buf, off + 28)
    const extraLen = u16(buf, off + 30)
    const commentLen = u16(buf, off + 32)
    const localOff = u32(buf, off + 42)
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen))
    const dataStart = localOff + 30 + u16(buf, localOff + 26) + u16(buf, localOff + 28)
    const raw = buf.subarray(dataStart, dataStart + compSize)
    if (name.endsWith('/')) {
      // A directory entry, which carries no data.
    } else if (method === 0) {
      entries.set(name, raw)
    } else if (method === 8) {
      entries.set(name, inflateRaw(raw))
    } else {
      throw new Error(`unsupported .fig compression method ${method} for ${name}`)
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Split `canvas.fig` into its length-prefixed chunks. */
export function readCanvasChunks(canvas: Uint8Array): { version: number; chunks: Uint8Array[] } {
  const magic = new TextDecoder().decode(canvas.subarray(0, 8))
  if (magic !== MAGIC) throw new Error(`not a Figma canvas: expected "${MAGIC}", found ${JSON.stringify(magic)}`)
  const version = u32(canvas, 8)
  const chunks: Uint8Array[] = []
  let off = 12
  while (off + 4 <= canvas.length) {
    const len = u32(canvas, off)
    off += 4
    if (off + len > canvas.length) throw new Error(`corrupt .fig: chunk claims ${len} bytes, ${canvas.length - off} remain`)
    chunks.push(canvas.subarray(off, off + len))
    off += len
  }
  if (chunks.length < 2) throw new Error(`corrupt .fig: expected a schema chunk and a message chunk, found ${chunks.length}`)
  return { version, chunks }
}

/**
 * Decompress a chunk by looking at what it IS rather than at the file version:
  * the magic bytes are a fact about these bytes, while a version threshold is a
 * guess about the history of somebody else's product.
 */
function inflateChunk(chunk: Uint8Array, inflators: FigInflators): Uint8Array {
  if (chunk.length >= 4 && u32(chunk, 0) === ZSTD_MAGIC) return inflators.zstd(chunk)
  return inflators.inflateRaw(chunk)
}

/** Read a whole `.fig` into its schema, its root message and its assets. */
export function readFig(bytes: Uint8Array, inflators: FigInflators): FigDocument {
  const entries = readZip(bytes, inflators.inflateRaw)
  const canvas = entries.get('canvas.fig')
  if (!canvas) throw new Error('not a .fig file: no canvas.fig inside')

  const { version, chunks } = readCanvasChunks(canvas)
  const definitions = decodeKiwiSchema(inflateChunk(chunks[0], inflators))
  const decoder = new KiwiDecoder(definitions)
  const root = decoder.decode(inflateChunk(chunks[1], inflators), 'Message')

  const images = new Map<string, Uint8Array>()
  for (const [name, data] of entries) {
    if (name.startsWith('images/') && data.length > 0) images.set(name.slice('images/'.length), data)
  }

  let meta: KiwiObject | null = null
  const metaBytes = entries.get('meta.json')
  if (metaBytes) {
    try {
      meta = JSON.parse(new TextDecoder().decode(metaBytes)) as KiwiObject
    } catch {
      meta = null // Informational only; a malformed meta.json must not stop an import.
    }
  }

  return { version, definitions, root, archive: { entries, images, meta } }
}
