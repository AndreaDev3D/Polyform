// Is the user typing?
//
// Its own module because two callers need the same answer and neither can
// import the other: the keyboard shortcuts, which must not treat "r" as the
// rectangle tool while somebody types a layer name, and the menu dispatch,
// where the clipboard accelerators are claimed by the native menu and so arrive
// no matter what has focus.

/** A field, a text area, a picker, or anything contenteditable. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** The same question about whatever currently has focus. */
export function isTypingNow(): boolean {
  return isTypingTarget(document.activeElement)
}
