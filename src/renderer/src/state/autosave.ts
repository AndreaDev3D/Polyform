// Saving is automatic: there is no Save button.
//
// A .poly project already exists on disk before the document does (creating one
// picks its location), so there is never a state where the app has edits it
// cannot write — which is what makes removing the button honest rather than a
// promise. Three timers, each for a different failure of the other two:
//
//   quiet     save once the edits stop, not once per edit
//   max wait  ...but continuous work still lands, on a bound
//   backstop  ...and anything that marked the document dirty without going
//             through the journal is picked up eventually
//
// A save is skipped mid-gesture and mid-text-edit: a scrub commits once at the
// end, and a text node is not final until its editor closes.

import { documentStore } from './document'
import { editor } from './editor'
import { saveFlow } from './actions'

const QUIET_MS = 1200
const MAX_WAIT_MS = 15_000
const BACKSTOP_MS = 30_000
/** A thumbnail is a full-scene render, so it is not worth doing every save. */
const THUMBNAIL_EVERY_MS = 60_000

let quietTimer: number | null = null
let dirtySince = 0
let lastThumbAt = 0
let saving = false

function eligible(): boolean {
  return (
    documentStore.projectInfo !== null &&
    documentStore.dirty &&
    !documentStore.scrubbing &&
    editor.get().editingTextId === null
  )
}

async function save(): Promise<void> {
  if (saving || !eligible()) return
  saving = true
  const withThumbnail = Date.now() - lastThumbAt > THUMBNAIL_EVERY_MS
  try {
    // saveFlow owns the indicator; this module only decides when to call it.
    if ((await saveFlow(withThumbnail)) && withThumbnail) lastThumbAt = Date.now()
  } finally {
    saving = false
    // Restart the max-wait window even on failure. Otherwise a save that keeps
    // failing (folder deleted, disk full) is past its deadline forever and
    // retries on every single keystroke.
    dirtySince = 0
  }
}

function schedule(): void {
  if (!eligible()) return
  const now = Date.now()
  if (dirtySince === 0) dirtySince = now
  // Past the max wait, stop deferring: a long unbroken edit would otherwise
  // keep pushing the save out forever.
  if (now - dirtySince >= MAX_WAIT_MS) {
    if (quietTimer !== null) window.clearTimeout(quietTimer)
    quietTimer = null
    void save()
    return
  }
  if (quietTimer !== null) window.clearTimeout(quietTimer)
  quietTimer = window.setTimeout(() => {
    quietTimer = null
    void save()
  }, QUIET_MS)
}

/** Start autosaving. Returns a disposer. */
export function installAutosave(): () => void {
  const offStore = documentStore.subscribe(schedule)
  const backstop = window.setInterval(schedule, BACKSTOP_MS)
  return () => {
    offStore()
    window.clearInterval(backstop)
    if (quietTimer !== null) window.clearTimeout(quietTimer)
    quietTimer = null
  }
}

/** Write now, if there is anything to write — used on the way out. */
export async function flushSave(): Promise<void> {
  if (quietTimer !== null) {
    window.clearTimeout(quietTimer)
    quietTimer = null
  }
  if (!documentStore.projectInfo || !documentStore.dirty) return
  // Closing bypasses the soft guards — write even mid-gesture or mid-text-edit
  // — and skips the thumbnail, so a slow full-scene render cannot outlive the
  // window and trip the close fail-safe.
  await saveFlow(false)
}
