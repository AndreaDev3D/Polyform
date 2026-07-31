// scene.bin encoding: 'PFRM' magic + format byte + MessagePack payload.
// Binary, compact, zero-config. FlatBuffers (docs/schema.fbs) is the target
// format once flatc codegen is wired into the build (see ADR-004).

import { decode, encode } from '@msgpack/msgpack'
import type { PolyformDocument } from './types'
import { SCHEMA_VERSION } from './types'

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
  // Migration hook: schema upgrades will run here as `version` diverges.
  const doc = payload.doc
  if (!doc.nodes || !Array.isArray(doc.rootIds)) {
    throw new SceneDecodeError('scene.bin document is missing nodes/rootIds')
  }
  doc.schemaVersion = SCHEMA_VERSION
  return doc
}
