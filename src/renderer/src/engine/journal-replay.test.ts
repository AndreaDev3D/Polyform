// Journal replay contract fixture (V0.4-Porting-Plan, API contract #2).
//
// The entries below stand in for a recorded v0.1–v0.3 journal touching every
// PatchOp kind (add/remove/update/move/page-add/page-remove/page-rename/
// styles-set), built with FIXED ids so the run is fully deterministic. The
// final document is frozen as a committed file snapshot: any engine
// implementation — TS today, Rust commands.rs when it lands — must replay
// these ops to the byte-identical document, undo back to the byte-identical
// initial state, and redo to the final state again.
//
// If this snapshot changes, either the op semantics changed (a breaking
// journal-compat event that needs a migration story) or node defaults
// changed (schema evolution — bump SCHEMA_VERSION and update docs/schema.fbs).
// Neither should ever happen as a side effect.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { applyOps, invertOp, undoOps, type PatchOp } from './commands'
import { buildJournal, initialDocument } from './journal-fixture'

describe('journal replay contract', () => {
  it('replays to the frozen snapshot; undo and redo are exact inverses', async () => {
    const initial = initialDocument()
    const scene = new SceneGraph(structuredClone(initial))
    const entries = buildJournal(scene)

    // The build already applied every entry — freeze the final document.
    const final = structuredClone(scene.doc)
    await expect(JSON.stringify(final, null, 2)).toMatchFileSnapshot(
      '__fixtures__/journal-replay-final.json',
    )

    // Undo everything in reverse -> exactly the initial document.
    for (let i = entries.length - 1; i >= 0; i--) undoOps(scene, entries[i])
    expect(scene.doc).toEqual(initial)

    // Redo everything -> exactly the final document again.
    for (const ops of entries) applyOps(scene, ops)
    expect(scene.doc).toEqual(final)

    // Round-trip through JSON (the journal encoding) must not change ops.
    const scene2 = new SceneGraph(structuredClone(initial))
    for (const ops of entries) {
      applyOps(scene2, JSON.parse(JSON.stringify(ops)) as PatchOp[])
    }
    expect(scene2.doc).toEqual(final)

    // Double inversion is identity on every op.
    for (const ops of entries) {
      for (const op of ops) {
        expect(invertOp(invertOp(op))).toEqual(op)
      }
    }
  })
})
