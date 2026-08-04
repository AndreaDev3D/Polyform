// Small shared UI primitives: number inputs with label scrubbing, selects,
// segmented controls, sections.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { beginScrub, endScrub } from '../state/actions'
import { CheckIcon, ChevronDownIcon } from './icons'

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="pf-section">
      <div className="pf-section-title">
        <span>{title}</span>
        <span className="flex items-center gap-1">{actions}</span>
      </div>
      {children}
    </div>
  )
}

/**
 * A named group of controls.
 *
 * Every field in the inspector says what it edits. The glyph inside a box can
 * only hint (is "B" blur or bottom?), so the words live above the row and the
 * glyph identifies which box is which within it.
 */
export function Field({
  label,
  hint,
  actions,
  children,
  className,
}: {
  label: string
  /** Tooltip on the label, for anything the word alone doesn't settle. */
  hint?: string
  /** Controls pinned to the right of the label, e.g. a mode toggle. */
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <div className="pf-field-head">
        <span className="pf-field-label" title={hint}>
          {label}
        </span>
        {actions}
      </div>
      {children}
    </div>
  )
}

interface NumberInputProps {
  label?: ReactNode
  /** Tooltip — a glyph label needs words somewhere. */
  title?: string
  value: number | null
  onCommit: (v: number) => void
  step?: number
  min?: number
  max?: number
  precision?: number
  suffix?: string
  className?: string
}

/** Figma-style number field: type to set, drag the label to scrub. */
export function NumberInput({ label, title, value, onCommit, step = 1, min = -Infinity, max = Infinity, precision = 2, suffix, className }: NumberInputProps) {
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const dragRef = useRef<{ startX: number; startVal: number; active: boolean } | null>(null)
  /**
   * Enter and Escape both blur the input, and blur used to commit — so one
   * Enter landed the value TWICE (two identical history entries, two undos to
   * get back), and Escape committed the text it was supposed to discard. Both
   * keys now say "this blur is already handled".
   */
  const skipBlurCommit = useRef(false)

  const display = value === null ? '' : String(round(value, precision))
  // The unit rides with the number instead of sitting at the far right of the
  // box, where it read as a separate thing ("100      %"). Editing strips it,
  // and parseFloat ignores a trailing unit on the way back in.
  const shown = value === null ? '' : `${display}${suffix ?? ''}`

  useEffect(() => {
    if (!editing) setText(display)
  }, [display, editing])

  const commitText = (t: string) => {
    const parsed = parseFloat(t.replace(',', '.'))
    if (!Number.isNaN(parsed)) {
      onCommit(clampNum(parsed, min, max))
    }
    setEditing(false)
  }

  const onLabelPointerDown = (e: React.PointerEvent) => {
    if (value === null) return
    dragRef.current = { startX: e.clientX, startVal: value, active: false }
    let lastVal = value
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.startX
      if (!d.active && Math.abs(dx) < 3) return
      if (!d.active) beginScrub()
      d.active = true
      // Apply live so the canvas follows the scrub; the action layer
      // coalesces the gesture into ONE history entry at endScrub()
      // (per-pixel commits would flood the journal).
      lastVal = clampNum(d.startVal + dx * step, min, max)
      setEditing(true)
      setText(String(round(lastVal, precision)))
      onCommit(lastVal)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const wasActive = dragRef.current?.active
      dragRef.current = null
      if (wasActive) {
        setEditing(false)
        onCommit(lastVal)
        endScrub()
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    // The glyph lives INSIDE the box, as one control: it reads as part of the
    // field it names rather than as loose text beside it, and the whole box is
    // one hit target for hover and focus.
    <div className={`pf-numfield ${className ?? ''}`} title={title}>
      {label && (
        <span
          className="pf-num-glyph"
          // Stable hook for the e2e scrub gate: it used to find this by the
          // ew-resize utility class, which is a styling detail and moved into
          // CSS the moment the field was restyled.
          data-scrub=""
          title={title ? `${title} — drag to scrub` : 'Drag to scrub'}
          onPointerDown={onLabelPointerDown}
        >
          {label}
        </span>
      )}
      <input
        className="pf-input pf-numfield-input"
        value={editing ? text : shown}
        placeholder={value === null ? 'Mixed' : undefined}
        onFocus={(e) => {
          setEditing(true)
          setText(display)
          skipBlurCommit.current = false
          e.target.select()
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (skipBlurCommit.current) {
            skipBlurCommit.current = false
            setEditing(false)
            return
          }
          commitText(text)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            commitText((e.target as HTMLInputElement).value)
            skipBlurCommit.current = true
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            // Discard: the text goes back to the value on the next render.
            setEditing(false)
            skipBlurCommit.current = true
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const cur = parseFloat((editing ? text : display) || '0') || 0
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : step)
            const next = clampNum(cur + delta, min, max)
            setText(String(round(next, precision)))
            onCommit(next)
          }
        }}
      />
    </div>
  )
}

export function TextInput({ value, onCommit, placeholder, className }: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string }) {
  const [text, setText] = useState(value)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(value)
  }, [value, editing])
  return (
    <input
      className={`pf-input ${className ?? ''}`}
      value={text}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false)
        if (text !== value) onCommit(text)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(value)
          setEditing(false)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

/** Menu row height, and the smallest menu worth opening in the short direction. */
const MENU_ROW = 22
const MENU_MIN_H = 96

/**
 * Dropdown — ours, not the operating system's.
 *
 * It was a native `<select>` with `appearance-none`, and that is a bargain with
 * only bad halves: keeping the native arrow means keeping the native box, and
 * removing the box removes the arrow, which is why this control had no caret at
 * all and did not read as clickable.
 *
 * The popup is worth owning for its own sake. Chromium draws it itself, in its
 * own surface, and takes no styling from us: no checkmark on the current
 * option, no type or metrics matching the panel it belongs to. It is also a
 * separate window that does not appear in the
 * screenshots our tests take — everything else in this UI is verified by
 * driving the app and reading pixels, and that popup is the one thing that
 * cannot be. This is plain DOM: styled, checkmarked, and photographable.
 *
 * An empty value means "differs across the selection" for property rows, but
 * "nothing chosen yet" for pickers — so the caller names it via `placeholder`.
 */
export function Select<T extends string>({ value, options, onChange, className, placeholder = 'Mixed', disabled }: { value: T | ''; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string; placeholder?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [box, setBox] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<(HTMLDivElement | null)[]>([])

  const current = options.findIndex((o) => o.value === value)
  const label = current >= 0 ? options[current].label : placeholder

  const openMenu = () => {
    if (disabled) return
    const b = btnRef.current?.getBoundingClientRect()
    if (!b) return
    // Opens downwards unless there is more room the other way — an inspector
    // near the bottom of the window is exactly where the long dropdowns live.
    const below = window.innerHeight - b.bottom - 8
    const above = b.top - 8
    const wanted = options.length * MENU_ROW + 6
    const down = below >= Math.min(wanted, MENU_MIN_H) || below >= above
    setBox({
      left: Math.max(6, Math.min(b.left, window.innerWidth - b.width - 6)),
      top: down ? b.bottom + 2 : Math.max(6, b.top - 2 - Math.min(wanted, above)),
      width: b.width,
      maxHeight: Math.max(MENU_MIN_H, down ? below : above),
    })
    setActive(current >= 0 ? current : 0)
    setOpen(true)
  }

  const close = (refocus = true) => {
    setOpen(false)
    setBox(null)
    if (refocus) btnRef.current?.focus()
  }

  const choose = (v: T) => {
    close()
    // Re-picking the current option is not an edit. A native select fired no
    // change event for it; committing one here would spend a history entry on
    // nothing. Pickers sit at '', which never equals an option, so they still
    // fire every time.
    if (v !== value) onChange(v)
  }

  useEffect(() => {
    if (!open) return
    menuRef.current?.focus()
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return
      close(false)
    }
    const away = () => close(false)
    // A menu is anchored to a box that scrolling moves. Chasing it would need
    // the panel's scroll position; closing is honest and is what Figma does.
    const onWheel = (e: WheelEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('resize', away)
    window.addEventListener('blur', away)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('wheel', onWheel, true)
      window.removeEventListener('resize', away)
      window.removeEventListener('blur', away)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open) rowsRef.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  /**
   * An open menu owns the keyboard, and it has to say so NATIVELY.
   *
   * React's own delegation does not carry a stopPropagation from a body portal
   * to the app's `window` keydown listener: Escape closed the menu and ALSO
   * reached the global shortcut, which cleared the selection, which emptied the
   * inspector and unmounted this control mid-gesture. Measured, not assumed —
   * the window listener logged the Escape with the listbox as its target.
   * Capture phase on window, so this runs ahead of the shortcuts either way.
   */
  useEffect(() => {
    if (!open) return
    const onKeyNative = (e: KeyboardEvent) => {
      e.stopPropagation()
      handleKey(e)
    }
    window.addEventListener('keydown', onKeyNative, true)
    return () => window.removeEventListener('keydown', onKeyNative, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, value, options])

  /**
   * Every key stops here. A native `<select>` counted as a typing target for
   * the global shortcuts (`isTypingTarget`), so a focused dropdown swallowed
   * single-key keys; a button does not, and without this "r" would switch to
   * the rectangle tool and Delete would delete the layer being edited.
   */
  const handleKey = (e: { key: string; preventDefault: () => void }) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    const n = options.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + d + n) % n)
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setActive(e.key === 'Home' ? 0 : n - 1)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const o = options[active]
      if (o) choose(o.value)
      return
    }
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      close()
      return
    }
    // Typeahead, cycling: "d" in Blend mode walks Darken, Difference, ...
    if (e.key.length === 1) {
      const k = e.key.toLowerCase()
      for (let i = 1; i <= n; i++) {
        const j = (active + i) % n
        if (options[j].label.toLowerCase().startsWith(k)) {
          setActive(j)
          break
        }
      }
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        title={label}
        className={`pf-select ${open ? 'is-open' : ''} ${className ?? ''}`}
        onPointerDown={(e) => {
          // preventDefault keeps focus off the button while the menu owns the
          // keyboard; close() hands it back.
          e.preventDefault()
          if (open) close()
          else openMenu()
        }}
        onKeyDown={(e) => {
          // Closed, the trigger is an ordinary focused control inside the React
          // root, where stopping the synthetic event does reach the window
          // listener in time. Open, the effect above owns the keyboard.
          e.stopPropagation()
          if (!open) handleKey(e)
        }}
      >
        <span className="pf-select-value">{label}</span>
        <ChevronDownIcon className="pf-select-caret" width={10} height={10} />
      </button>
      {open && box &&
        // Into the body: the inspector scrolls and clips, and a menu that gets
        // cut off by the panel it belongs to is worse than the native one.
        createPortal(
          <div
            ref={menuRef}
            className="pf-menu"
            role="listbox"
            tabIndex={-1}
            style={{ left: box.left, top: box.top, minWidth: box.width, maxHeight: box.maxHeight }}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                ref={(el) => {
                  rowsRef.current[i] = el
                }}
                role="option"
                aria-selected={o.value === value}
                className={`pf-menu-item ${i === active ? 'is-active' : ''}`}
                onPointerEnter={() => setActive(i)}
                // pointerup, so press-drag-release picks an option the way the
                // native popup did.
                onPointerUp={() => choose(o.value)}
              >
                <span className="pf-menu-check">{o.value === value && <CheckIcon width={11} height={11} />}</span>
                {o.label}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T | null; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded bg-[#2a2a2a] p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          // min-w-0: without it a word label ("None") claims more room than an
          // icon one, and the segments come out visibly uneven.
          className={`flex-1 min-w-0 flex items-center justify-center rounded px-1.5 py-1 text-[11px] ${value === o.value ? 'bg-[#454545] text-white' : 'text-[var(--pf-text-dim)] hover:text-white'}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function round(v: number, precision = 2): number {
  const f = Math.pow(10, precision)
  return Math.round(v * f) / f
}

function clampNum(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
