// Slim document bar: what file am I in, what's selected, how zoomed am I,
// and is it saved. Tools moved to the floating pill (FloatingToolbar), so
// this row carries context only — 36px instead of 48px of chrome.

import { useEditor } from '../state/editor'
import { documentStore, useDocVersion } from '../state/document'
import { saveFlow, zoomAt, zoomToFit } from '../state/actions'
import { MinusIcon, PlusIcon } from './icons'

const ZOOM_PRESETS = [0.5, 1, 2]

export function TopBar() {
  useDocVersion()
  const selection = useEditor((s) => s.selection)
  const zoom = useEditor((s) => s.camera.zoom)
  const title = documentStore.projectInfo?.manifest.title ?? 'Untitled'
  const dirty = documentStore.dirty

  return (
    <div className="flex items-center h-9 px-3 gap-3 bg-[var(--pf-bg-0)] border-b border-[var(--pf-border)] shrink-0">
      {/* Identity, left — where Figma keeps it. */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="pf-mark" aria-hidden="true" />
        <span className="text-xs font-medium truncate max-w-[22rem]">{title}</span>
        {dirty && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-[var(--pf-text-dim)] shrink-0"
            title="Unsaved changes"
          />
        )}
      </div>

      <span className="flex-1" />

      {selection.length > 0 && (
        <span className="text-[11px] text-[var(--pf-text-dim)] tabular-nums">
          {selection.length} selected
        </span>
      )}

      {/* Zoom: a stepper whose readout is also the fit button. */}
      <div className="flex items-center gap-0.5 rounded-md bg-[var(--pf-bg-2)] p-0.5">
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
        className="pf-btn h-7 px-3 bg-[var(--pf-accent-solid)] text-white font-medium hover:bg-[var(--pf-accent-solid-hover)]"
        onClick={() => void saveFlow()}
        title="Save — Ctrl+S"
      >
        Save
      </button>
    </div>
  )
}
