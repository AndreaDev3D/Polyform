// The custom title bar. The window is frameless (main sets titleBarStyle
// 'hidden'), so this row IS the title bar: it carries the mark, the app's own
// menu, the document name, zoom and Save — and it is the window's drag handle.
//
// The OS still draws the minimise/maximise/close buttons as an overlay on the
// right, so the bar reserves that width. Everything interactive opts out of
// the drag region, or it would be unclickable.

import { useEditor } from '../state/editor'
import { documentStore, useDocVersion } from '../state/document'
import { saveFlow, zoomAt, zoomToFit } from '../state/actions'
import { MinusIcon, PlusIcon, PolyformMark } from './icons'
import { MenuBar } from './MenuBar'
import { useTitlebarGeometry } from './titlebar'

const ZOOM_PRESETS = [0.5, 1, 2]

export function TopBar() {
  useDocVersion()
  const selection = useEditor((s) => s.selection)
  const zoom = useEditor((s) => s.camera.zoom)
  const title = documentStore.projectInfo?.manifest.title ?? 'Untitled'
  const dirty = documentStore.dirty
  const { inset, height } = useTitlebarGeometry()
  const isMac = window.polyform.platform === 'darwin'

  return (
    <div
      className="pf-drag flex items-center gap-2 bg-[var(--pf-bg-0)] border-b border-[var(--pf-border)] shrink-0"
      // Height comes from the OS so the native buttons sit exactly inside this
      // row. Left padding clears macOS traffic lights; right padding clears
      // the Windows/Linux control buttons.
      style={{ height, paddingLeft: isMac ? 78 : 8, paddingRight: inset + 8 }}
    >
      <PolyformMark size={16} className="pf-nodrag shrink-0" />

      {/* macOS puts the menu in the system bar, so drawing one here would be a
          duplicate; every other platform gets ours. */}
      {!isMac && <MenuBar />}

      {/* The document name centres the bar the way a title bar should read. */}
      <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0 px-2">
        <span className="text-[11px] text-[var(--pf-text-dim)] truncate max-w-[24rem]">{title}</span>
        {dirty && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-[var(--pf-text-dim)] shrink-0"
            title="Unsaved changes"
          />
        )}
      </div>

      {selection.length > 0 && (
        <span className="pf-nodrag text-[11px] text-[var(--pf-text-dim)] tabular-nums shrink-0">
          {selection.length} selected
        </span>
      )}

      {/* Zoom: a stepper whose readout is also the fit button. */}
      <div className="pf-nodrag flex items-center gap-0.5 rounded-md bg-[var(--pf-bg-2)] p-0.5 shrink-0">
        <button className="pf-tool-btn h-6 w-6" title="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(null, 0.8)}>
          <MinusIcon />
        </button>
        <button
          className="pf-btn h-6 px-2 text-[11px] tabular-nums min-w-[3.25rem]"
          title="Zoom to fit — Shift+1 (right-click for presets)"
          onClick={() => zoomToFit()}
          onContextMenu={(e) => {
            e.preventDefault()
            const next = ZOOM_PRESETS.find((z) => z > zoom + 0.01) ?? ZOOM_PRESETS[0]
            zoomAt(null, next / zoom)
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button className="pf-tool-btn h-6 w-6" title="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(null, 1.25)}>
          <PlusIcon />
        </button>
      </div>

      <button
        className="pf-nodrag pf-btn h-7 px-3 bg-[var(--pf-accent-solid)] text-white font-medium hover:bg-[var(--pf-accent-solid-hover)] shrink-0"
        onClick={() => void saveFlow()}
        title="Save — Ctrl+S"
      >
        Save
      </button>
    </div>
  )
}
