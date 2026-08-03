// Editor UI state (tool, selection, camera, panels) — zustand store.
// Scene data lives in DocumentStore; this holds only view/interaction state.

import { create } from 'zustand'
import type { NodeId } from '../engine/types'
import type { AABB } from '../engine/geometry'
import type { Camera } from '../engine/render/canvas2d'
import type { ArcHandleKind, PenDraft, SnapGuide } from '../engine/render/overlays'

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
  /** Arc handle under an active drag, so the overlay can show its readout. */
  arcDrag: ArcHandleKind | null
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
  setArcDrag: (k: ArcHandleKind | null) => void
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
  arcDrag: null,
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
  setVectorEditId: (vectorEditId) => set({ vectorEditId, vectorSelection: [] }),
  setVectorSelection: (vectorSelection) => set({ vectorSelection }),
  setArcDrag: (arcDrag) => set({ arcDrag }),
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
