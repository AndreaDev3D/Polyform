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
  /**
   * Containers folded shut in the layer tree. Held here rather than in the panel
   * because "Expand Selected" is also a context-menu command, given from the
   * canvas, where the panel's own state is out of reach.
   */
  collapsedLayers: Set<NodeId>
  /** WebGPU scene rendering; falls back to Canvas2D when unavailable. */
  gpuRender: boolean
  /** Whether this machine exposes a WebGPU device at all. Set by CanvasView. */
  gpuSupported: boolean
  /**
   * Whether the GPU renderer is the one actually drawing right now. Distinct from
   * `gpuRender`, which is only the preference: a device can be asked for and fail.
   * The UI shows THIS, so a tick never claims something that is not happening
   * (F-30 — a setting that is stored, shown and ignored is a lie).
   */
  gpuActive: boolean

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
  setCollapsedLayers: (ids: Set<NodeId>) => void
  setGpuRender: (v: boolean) => void
  setGpuStatus: (v: { supported?: boolean; active?: boolean }) => void
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
  collapsedLayers: new Set<NodeId>(),
  // Default ON where a device exists: the GPU path pans 100,000 shapes at 60fps
  // against a Canvas2D budget aimed at typical documents, and its 14 pixel-parity
  // fixtures pass. A stored '0' still wins — a preference the user set is theirs,
  // not a default to be re-applied on every launch.
  gpuRender: (() => {
    try {
      const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('polyform.gpuRender') : null
      return stored === null ? true : stored === '1'
    } catch {
      return true
    }
  })(),
  gpuSupported: false,
  gpuActive: false,

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
  // Always a NEW Set: mutating the stored one in place changes nothing zustand
  // can compare, so the tree would keep rendering the old shape.
  setCollapsedLayers: (collapsedLayers) => set({ collapsedLayers }),
  setGpuStatus: ({ supported, active }) =>
    set((s) => ({
      gpuSupported: supported ?? s.gpuSupported,
      gpuActive: active ?? s.gpuActive,
    })),
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
