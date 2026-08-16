// Types for cursor-svg.mjs, so the round-trip test can import the same reader
// the generator uses instead of a re-implementation of it.

export declare const CURSOR_BOX: number

export declare function readCursorSvg(svg: string): {
  /** The outline, in CURSOR_BOX units. More than one path fills as subpaths. */
  paths: string[]
  /** The first point of the first path — the hotspot. */
  tip: { x: number; y: number }
  /** What was ignored, for the caller to print. */
  notes: string[]
}
