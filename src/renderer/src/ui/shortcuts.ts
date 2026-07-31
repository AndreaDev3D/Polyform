// Global keyboard shortcuts. Ctrl/Cmd combos live in the native menu
// (accelerators); this handles single-key tools, nudging and Escape/Enter.

import { editor, type Tool } from '../state/editor'
import { deleteSelection, nudgeSelection, setSelection } from '../state/actions'
import { interactionController } from '../interactions/controller'

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

    if (e.key === 'Delete' || e.key === 'Backspace') {
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
