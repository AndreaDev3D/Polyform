// scene.bin encoding: 'PFRM' magic + format byte + MessagePack payload.
// Binary, compact, zero-config. FlatBuffers (docs/schema.fbs) is the target
// format once flatc codegen is wired into the build (see ADR-004).

import { decode, encode } from '@msgpack/msgpack'
import type { NodeId, PolyformDocument } from './types'
import { SCHEMA_VERSION, createPage, emptyStyles } from './types'

const MAGIC = [0x50, 0x46, 0x52, 0x4d] // "PFRM"
const FORMAT_MSGPACK = 1

export function encodeScene(doc: PolyformDocument): Uint8Array {
  const payload = encode({
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    doc,
  })
  const out = new Uint8Array(5 + payload.byteLength)
  out.set(MAGIC, 0)
  out[4] = FORMAT_MSGPACK
  out.set(payload, 5)
  return out
}

export class SceneDecodeError extends Error {}

export function decodeScene(bytes: Uint8Array): PolyformDocument {
  if (bytes.length < 6) throw new SceneDecodeError('scene.bin is truncated')
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) throw new SceneDecodeError('scene.bin has an unknown magic header')
  }
  if (bytes[4] !== FORMAT_MSGPACK) {
    throw new SceneDecodeError(`Unsupported scene.bin format byte: ${bytes[4]}`)
  }
  const payload = decode(bytes.subarray(5)) as {
    schemaVersion?: number
    doc?: PolyformDocument
  }
  if (!payload || typeof payload !== 'object' || !payload.doc) {
    throw new SceneDecodeError('scene.bin payload is malformed')
  }
  const version = payload.schemaVersion ?? 0
  if (version > SCHEMA_VERSION) {
    throw new SceneDecodeError(
      `Project schema v${version} is newer than this build supports (v${SCHEMA_VERSION})`,
    )
  }
  const doc = payload.doc
  if (!doc.nodes) {
    throw new SceneDecodeError('scene.bin document is missing nodes')
  }
  return migrateDocument(doc as PolyformDocument & { rootIds?: NodeId[] })
}

/**
 * Upgrade any older document shape to the current schema in place.
 * v1 -> v2: single implicit page becomes pages[]; styles added.
 */
export function migrateDocument(doc: PolyformDocument & { rootIds?: NodeId[] }): PolyformDocument {
  if (!Array.isArray(doc.pages) || doc.pages.length === 0) {
    const page = createPage('Page 1')
    page.rootIds = Array.isArray(doc.rootIds) ? doc.rootIds : []
    doc.pages = [page]
    doc.activePageId = page.id
    delete doc.rootIds
  }
  for (const page of doc.pages) {
    if (!Array.isArray(page.rootIds)) page.rootIds = []
    if (!Array.isArray(page.guides)) page.guides = []
  }
  if (!doc.activePageId || !doc.pages.some((p) => p.id === doc.activePageId)) {
    doc.activePageId = doc.pages[0].id
  }
  if (!doc.styles) doc.styles = emptyStyles()
  if (!Array.isArray(doc.styles.colors)) doc.styles.colors = []
  if (!Array.isArray(doc.styles.texts)) doc.styles.texts = []
  if (!Array.isArray(doc.styles.effects)) doc.styles.effects = []
  // v3: attached libraries (optional) + component/instance node types (new
  // fields are optional, so v2 documents need no per-node rewriting).
  if (!Array.isArray(doc.libraries)) doc.libraries = []
  doc.schemaVersion = SCHEMA_VERSION
  return doc
}
