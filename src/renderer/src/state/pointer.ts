// Where the pointer is over the canvas.
//
// Its own module rather than a field on the interaction controller, because the
// controller imports the actions and paste is an action — the two would have to
// reach through each other. It is also the honester home: "where the mouse is"
// is a fact about the app, not about a drag in progress.
//
// A module variable rather than editor state, deliberately. This changes on
// every pointer move; putting it in the store would repaint the app at mouse
// frequency for a value nothing draws (F-23 is the same lesson from the other
// direction — the cursor was written only on repaint and so was usually stale).
// Everything that reads this reads it once, at the instant of a keystroke.

import type { Vec2 } from '../engine/types'
import { screenToWorld } from '../engine/render/overlays'
import { editor } from './editor'

let hoverScreen: Vec2 | null = null

/** Called on every canvas pointer move; null when the pointer leaves it. */
export function setPointerScreen(p: Vec2 | null): void {
  hoverScreen = p
}

/**
 * The pointer in world coordinates, or null when it is not over the canvas —
 * which is a real case worth distinguishing rather than defaulting: after
 * moving to the inspector, the last place the mouse crossed the canvas edge is
 * not where anybody means "here".
 */
export function pointerWorld(): Vec2 | null {
  if (!hoverScreen) return null
  return screenToWorld(editor.get().camera, hoverScreen)
}
