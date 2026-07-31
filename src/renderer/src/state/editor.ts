// Editor UI state (tool, selection, camera, panels) — zustand store.
// Scene data lives in DocumentStore; this holds only view/interaction state.

import { create } from 'zustand'
import type { NodeId } from '../engine/types'
import type { AABB } from '../engine/geometry'
import type { Camera } from '../engine/render/canvas2d'
import type { PenDraft, SnapGuide } from '../engine/render/overlays'

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
}))

/** Imperative accessors for non-React interaction code. */
export const editor = {
  get: useEditor.getState,
  set: useEditor.setState,
}
