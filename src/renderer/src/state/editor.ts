// Editor UI state (tool, selection, camera, panels) — zustand store.
// Scene data lives in DocumentStore; this holds only view/interaction state.

import { create } from 'zustand'
import type { NodeId } from '../engine/types'
import type { AABB } from '../engine/geometry'
import type { Camera } from '../engine/render/canvas2d'
import type { ArcHandleKind, CornerKind, PenDraft, SnapGuide } from '../engine/render/overlays'

export type Tool =
  | 'select'
  | 'frame'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'polygon'
  | 'star'
  | 'pen'
  | 'text'
  | 'hand'

/**
 * What a drag means inside vector edit. Figma splits this into a second row of
 * tools; the same idea, kept to the three that change what a drag DOES:
 *   move    drag points and handles; click a segment to add a point
 *   bend    drag a segment and the curve follows the pointer
 *   delete  click points to remove them, segments to open the path
 */
export type VectorMode = 'move' | 'bend' | 'delete'

export interface ContextMenuState {
  x: number
  y: number
}

interface EditorState {
  tool: Tool
  selection: NodeId[]
  hover: NodeId | null
  camera: Camera
  showGrid: boolean
  editingTextId: NodeId | null
  /** Container the user has double-clicked into (deep select context). */
  enteredContainer: NodeId | null
  fonts: string[]
  marquee: AABB | null
  guides: SnapGuide[]
  penDraft: PenDraft | null
  contextMenu: ContextMenuState | null
  spacePanning: boolean
  hasProject: boolean
  viewportSize: { w: number; h: number }
  showRulers: boolean
  /** Vector node currently in edit mode (double-click a vector). */
  vectorEditId: NodeId | null
  /** MODEL3D node currently in orbit mode (double-click a model). */
  orbitingId: NodeId | null
  /** Selected vertex ids within vector edit mode. */
  vectorSelection: number[]
  /** What a drag does while editing a vector: move points, bend segments, delete. */
  vectorMode: VectorMode
  /** Arc handle under an active drag, so the overlay can show its readout. */
  arcDrag: ArcHandleKind | null
  /** Corner-radius handle under an active drag. */
  cornerDrag: CornerKind | null
  /** A rotate drag is in progress, so the knob can show the live angle. */
  rotating: boolean
  /** Transient one-line message: why a command did nothing, mostly. */
  status: string | null
  /**
   * Autosave state, for the indicator that replaced the Save button. 'saved'
   * is transient; 'error' persists until a save succeeds, because a document
   * that is quietly not being written is the one thing you must be told about.
   */
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  /**
   * What the app is busy doing, or null. Loading a file blocks the main thread —
   * a big `.fig` commit is minutes of synchronous work — so this exists to be
   * PAINTED BEFORE that work starts; see `withBusy` in state/actions.
   */
  busy: string | null
  /** Version-history browser visibility. */
  showHistory: boolean
  /** Agent-connection consent panel visibility. */
  showAgent: boolean
  /** Left panel tab. */
  leftTab: 'layers' | 'assets'
  /** WebGPU scene rendering (beta); falls back to Canvas2D when unavailable. */
  gpuRender: boolean

  setTool: (tool: Tool) => void
  setSelection: (ids: NodeId[]) => void
  setHover: (id: NodeId | null) => void
  setCamera: (camera: Camera) => void
  setShowGrid: (v: boolean) => void
  setEditingTextId: (id: NodeId | null) => void
  setEnteredContainer: (id: NodeId | null) => void
  setFonts: (fonts: string[]) => void
  setMarquee: (m: AABB | null) => void
  setGuides: (g: SnapGuide[]) => void
  setPenDraft: (d: PenDraft | null) => void
  setContextMenu: (c: ContextMenuState | null) => void
  setSpacePanning: (v: boolean) => void
  setHasProject: (v: boolean) => void
  setViewportSize: (s: { w: number; h: number }) => void
  setShowRulers: (v: boolean) => void
  setVectorEditId: (id: NodeId | null) => void
  setVectorSelection: (ids: number[]) => void
  setVectorMode: (mode: VectorMode) => void
  setArcDrag: (k: ArcHandleKind | null) => void
  setCornerDrag: (k: CornerKind | null) => void
  setRotating: (v: boolean) => void
  setStatus: (text: string | null) => void
  setBusy: (v: string | null) => void
  setShowHistory: (v: boolean) => void
  setLeftTab: (t: 'layers' | 'assets') => void
  setGpuRender: (v: boolean) => void
}

export const useEditor = create<EditorState>((set) => ({
  tool: 'select',
  selection: [],
  hover: null,
  camera: { x: -200, y: -150, zoom: 1 },
  showGrid: false,
  editingTextId: null,
  enteredContainer: null,
  fonts: [],
  marquee: null,
  guides: [],
  penDraft: null,
  contextMenu: null,
  spacePanning: false,
  hasProject: false,
  viewportSize: { w: 1200, h: 800 },
  showRulers: true,
  vectorEditId: null,
  orbitingId: null,
  vectorSelection: [],
  vectorMode: 'move' as const,
  arcDrag: null,
  cornerDrag: null,
  rotating: false,
  status: null,
  saveState: 'idle' as const,
  busy: null,
  showHistory: false,
  showAgent: false,
  leftTab: 'layers' as const,
  gpuRender:
    typeof localStorage !== 'undefined' && localStorage.getItem('polyform.gpuRender') === '1',

  setTool: (tool) => set({ tool, penDraft: null, contextMenu: null }),
  setSelection: (selection) => set({ selection }),
  setHover: (hover) => set({ hover }),
  setCamera: (camera) => set({ camera }),
  setShowGrid: (showGrid) => set({ showGrid }),
  setEditingTextId: (editingTextId) => set({ editingTextId }),
  setEnteredContainer: (enteredContainer) => set({ enteredContainer }),
  setFonts: (fonts) => set({ fonts }),
  setMarquee: (marquee) => set({ marquee }),
  setGuides: (guides) => set({ guides }),
  setPenDraft: (penDraft) => set({ penDraft }),
  setContextMenu: (contextMenu) => set({ contextMenu }),
  setSpacePanning: (spacePanning) => set({ spacePanning }),
  setHasProject: (hasProject) => set({ hasProject }),
  setViewportSize: (viewportSize) => set({ viewportSize }),
  setShowRulers: (showRulers) => set({ showRulers }),
  // Leaving vector edit resets the mode: 'delete' is not something you want
  // to still be in next time you double-click a shape.
  setVectorEditId: (vectorEditId) => set({ vectorEditId, vectorSelection: [], vectorMode: 'move' }),
  setVectorSelection: (vectorSelection) => set({ vectorSelection }),
  setVectorMode: (vectorMode) => set({ vectorMode }),
  setArcDrag: (arcDrag) => set({ arcDrag }),
  setCornerDrag: (cornerDrag) => set({ cornerDrag }),
  setRotating: (rotating) => set({ rotating }),
  setStatus: (status) => set({ status }),
  setBusy: (busy) => set({ busy }),
  setShowHistory: (showHistory) => set({ showHistory }),
  setLeftTab: (leftTab) => set({ leftTab }),
  setGpuRender: (gpuRender) => {
    try {
      localStorage.setItem('polyform.gpuRender', gpuRender ? '1' : '0')
    } catch {
      // session-only when storage is unavailable
    }
    set({ gpuRender })
  },
}))

/** Imperative accessors for non-React interaction code. */
export const editor = {
  get: useEditor.getState,
  set: useEditor.setState,
}
