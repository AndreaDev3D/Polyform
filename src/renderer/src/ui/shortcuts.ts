// Global keyboard shortcuts. Ctrl/Cmd combos live in the native menu
// (accelerators); this handles single-key tools, nudging and Escape/Enter.

import { editor, type Tool } from '../state/editor'
import { copySelection, deleteSelection, flipSelection, nudgeSelection, paste, selectAll, setSelection, zoomToFit, zoomToSelection } from '../state/actions'
import { interactionController } from '../interactions/controller'
import { documentStore } from '../state/document'
import { isTypingTarget } from '../state/focus'

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

export function installShortcuts(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const state = editor.get()

    // Copy, paste and select-all.
    //
    // Here rather than on the native menu, which is where they used to live.
    // A registered accelerator is claimed by the browser process before the
    // page ever sees the key, which made these three untestable — no harness
    // can produce the OS key event an accelerator needs — and meant Ctrl+V
    // never reached a text field either. The menu still SHOWS the shortcut and
    // its items still work; it just no longer owns the key (F-41).
    //
    // A field with focus is left alone entirely: not preventing the default is
    // what lets Chromium do the ordinary text edit, which is the behaviour
    // anyone typing expects and the one an accelerator cannot give them.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      const combo = e.key.toLowerCase()
      if (combo === 'c' || combo === 'v' || combo === 'a') {
        if (isTypingTarget(e.target) || state.editingTextId) return
        e.preventDefault()
        if (combo === 'c') copySelection()
        else if (combo === 'v') void paste()
        else selectAll()
        return
      }
    }

    if (e.key === 'Escape') {
      if (isTypingTarget(e.target)) return // fields handle their own escape
      if (state.editingTextId) return // overlay handles it
      // A run in progress is FINISHED, not thrown away — and finishing an
      // unclosed run is the only way to draw an open stroke with the pen.
      // Escape used to discard it, which meant the shape existed for as long as
      // you were drawing it and then did not, and there was no key that kept it.
      // Undo is the way back; a keystroke that destroys work should not be the
      // same one people press to mean "I'm done".
      if (state.penDraft) {
        interactionController.finishPen(false)
        return
      }
      interactionController.cancel()
      if (state.vectorEditId) {
        interactionController.exitVectorEdit(true)
        return
      }
      if (state.orbitingId) {
        interactionController.exitOrbit()
        return
      }
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

    // Mirror the selection. Bare Shift+letter, so it is handled here behind the
    // focus guard rather than registered as a native accelerator — H and V are
    // printable, and the native menu would take them away from every text field.
    if (e.shiftKey && e.code === 'KeyH') {
      flipSelection('h')
      return
    }
    if (e.shiftKey && e.code === 'KeyV') {
      flipSelection('v')
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
