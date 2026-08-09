// "This is taking a moment, and here is what it is."
//
// Loading a file is mostly SYNCHRONOUS work: reading and decoding a `.fig`, then
// committing every node it contains. While that runs the renderer cannot paint,
// so this cannot be a progress bar that ticks — it is the last thing drawn before
// the thread goes quiet, and it stays on screen for as long as it takes.
//
// Which is why the label is set through `withBusy` (state/actions), one step
// ahead of the work: what you read is what is about to happen.

import { useEffect } from 'react'
import { useEditor } from '../state/editor'
import { RULER_SIZE } from '../engine/render/overlays'

export function BusyOverlay() {
  const busy = useEditor((s) => s.busy)
  const showRulers = useEditor((s) => s.showRulers)

  // The cursor goes on <html>, because the canvas writes its own cursor inline on
  // every frame (F-23) and a class further down would lose to it. `!important` in
  // the stylesheet is what beats an inline style.
  useEffect(() => {
    const root = document.documentElement
    if (busy) root.classList.add('pf-busy-cursor')
    else root.classList.remove('pf-busy-cursor')
    return () => root.classList.remove('pf-busy-cursor')
  }, [busy])

  if (!busy) return null
  // Clear of the ruler rather than across it: the ruler is a scale you read, and
  // something sitting on it is noise. RULER_SIZE comes from the overlay that draws
  // it, so hiding the rulers (Shift+R) moves this up by exactly the right amount.
  const top = (showRulers ? RULER_SIZE : 0) + 10
  return (
    <div className="pf-busy pf-floating" style={{ top }} role="status" aria-live="polite" data-busy={busy}>
      <span className="pf-busy-spinner" />
      <span>{busy}</span>
    </div>
  )
}
