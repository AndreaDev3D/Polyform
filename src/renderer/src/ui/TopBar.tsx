// The custom title bar. The window is frameless (main sets titleBarStyle
// 'hidden'), so this row IS the title bar: it carries the mark, the app's own
// menu and the document name — and it is the window's drag handle.
//
// Zoom moved to the bottom bar, next to the canvas it acts on, and Save is
// gone: saving is automatic (state/autosave.ts). What is left here is a save
// STATE, because removing a button you used to press means the app owes you
// the answer to "is my work written down".
//
// The OS still draws the minimise/maximise/close buttons as an overlay on the
// right, so the bar reserves that width. Everything interactive opts out of
// the drag region, or it would be unclickable.

import { useEditor } from '../state/editor'
import { documentStore, useDocVersion } from '../state/document'
import { PolyformMark } from './icons'
import { MenuBar } from './MenuBar'
import { useTitlebarGeometry } from './titlebar'
import { UpdateBadge, useUpdate } from './Updates'

/** "Is my work safe?" — the whole reason a Save button can be taken away. */
function SaveState() {
  useDocVersion()
  const saveState = useEditor((s) => s.saveState)
  const dirty = documentStore.dirty

  if (saveState === 'error') {
    return (
      <span
        className="pf-nodrag text-[11px] text-[var(--pf-danger)] shrink-0"
        title="The last save failed. Check that the project folder still exists and is writable, then File → Save As to write it elsewhere."
      >
        Not saved
      </span>
    )
  }
  if (saveState === 'saving') {
    return <span className="text-[11px] text-[var(--pf-text-dim)] shrink-0">Saving…</span>
  }
  if (saveState === 'saved' && !dirty) {
    return <span className="text-[11px] text-[var(--pf-text-dim)] shrink-0 pf-fade-in">Saved</span>
  }
  // Dirty between edits: a dot, not a word. It is about to be written, and a
  // permanent "unsaved" label would be alarming for something 1.2s away.
  if (dirty) {
    return (
      <span
        className="w-1.5 h-1.5 rounded-full bg-[var(--pf-text-dim)] shrink-0"
        title="Unsaved edits — saving automatically"
      />
    )
  }
  return null
}

export function TopBar() {
  useDocVersion()
  const selection = useEditor((s) => s.selection)
  const title = documentStore.projectInfo?.manifest.title ?? 'Untitled'
  const { inset, height } = useTitlebarGeometry()
  const update = useUpdate()
  const isMac = window.polyform.platform === 'darwin'

  return (
    <>
      <div
        className="pf-drag flex items-center gap-2 bg-[var(--pf-bg-0)] shrink-0"
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
          <SaveState />
        </div>

        {selection.length > 0 && (
          <span className="pf-nodrag text-[11px] text-[var(--pf-text-dim)] tabular-nums shrink-0">
            {selection.length} selected
          </span>
        )}

        {/* Right-most, next to the window buttons, and absent unless there is
            something to do about an update. The same component and the same state
            as the welcome screen's panel. */}
        <UpdateBadge model={update} />
      </div>
      {/* The divider is its own row, not a border on the bar above. The OS paints
          the window buttons over the whole titlebar area it reports — the full
          height of it, not just the glyphs — and a bottom border lives *inside*
          that height, so it was covered for the last 136px of the window and the
          line stopped dead under the controls. One pixel below the bar is
          outside the overlay, so it runs edge to edge. Still part of the drag
          region, because that pixel used to be. */}
      <div className="pf-drag h-px bg-[var(--pf-border)] shrink-0" />
    </>
  )
}
