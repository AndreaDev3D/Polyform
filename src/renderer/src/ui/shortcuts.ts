// Global keyboard shortcuts. Ctrl/Cmd combos live in the native menu
// (accelerators); this handles single-key tools, nudging and Escape/Enter.

import { editor, type Tool } from '../state/editor'
import { deleteSelection, nudgeSelection, setSelection, zoomToFit, zoomToSelection } from '../state/actions'
import { interactionController } from '../interactions/controller'
import { documentStore } from '../state/document'

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  f: 'frame',
  r: 'rectangle',
  o: 'ellipse',
  l: 'line',
  p: 'pen',
  t: 'text',
  h: 'hand',
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function installShortcuts(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const state = editor.get()

    if (e.key === 'Escape') {
      if (isTypingTarget(e.target)) return // fields handle their own escape
      if (state.editingTextId) return // overlay handles it
      interactionController.cancel()
      if (state.vectorEditId) {
        interactionController.exitVectorEdit(true)
        return
      }
      if (state.orbitingId) {
        interactionController.exitOrbit()
        return
      }
      if (state.penDraft) return
      if (state.enteredContainer) {
        editor.set({ enteredContainer: null })
      } else {
        setSelection([])
      }
      return
    }

    if (isTypingTarget(e.target) || state.editingTextId) return
    if (e.ctrlKey || e.metaKey || e.altKey) return // menu accelerators own these

    if (e.key === ' ') {
      if (!state.spacePanning) editor.set({ spacePanning: true })
      e.preventDefault()
      return
    }

    if (e.key === 'Enter' && state.penDraft) {
      interactionController.finishPen(false)
      return
    }

    if (e.key === 'Enter') {
      if (state.vectorEditId) {
        interactionController.exitVectorEdit(true)
        return
      }
      // Enter on a selected vector opens vector edit mode (Figma behavior).
      if (state.selection.length === 1) {
        const node = documentStore.scene.getNode(state.selection[0])
        if (node?.type === 'VECTOR') {
          interactionController.enterVectorEdit(node.id)
          return
        }
      }
    }

    if (e.shiftKey && e.code === 'Digit1') {
      // Zoom to Fit (menu shows the hint; registered here so typing '!' in
      // text fields is never intercepted — the guards above already ran).
      zoomToFit()
      return
    }

    if (e.shiftKey && e.code === 'Digit2') {
      // Focus the selection — the same thing the bottom bar's focus button does.
      zoomToSelection()
      return
    }

    if (e.shiftKey && e.code === 'KeyR') {
      editor.set({ showRulers: !state.showRulers })
      return
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.vectorEditId) {
        interactionController.deleteVectorVertices()
        return
      }
      deleteSelection()
      return
    }

    if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      if (dx !== 0 || dy !== 0) {
        e.preventDefault()
        nudgeSelection(dx, dy)
      }
      return
    }

    const tool = TOOL_KEYS[e.key.toLowerCase()]
    if (tool && !e.shiftKey) {
      if (state.vectorEditId && tool !== 'select') {
        interactionController.exitVectorEdit(true)
      }
      editor.get().setTool(tool)
    }
  }

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      editor.set({ spacePanning: false })
    }
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
  }
}
