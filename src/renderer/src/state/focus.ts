// Is the user typing?
//
// Its own module rather than a local helper in the shortcut handler, because
// the answer decides two different things there: whether "r" means the
// rectangle tool, and whether Ctrl+V belongs to the canvas or to the field
// under the cursor — and in the second case the right move is to do NOTHING,
// so that Chromium performs the ordinary text edit.

/** A field, a text area, a picker, or anything contenteditable. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}
