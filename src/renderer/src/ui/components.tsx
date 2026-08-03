// Small shared UI primitives: number inputs with label scrubbing, selects,
// segmented controls, sections.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { beginScrub, endScrub } from '../state/actions'

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
          e.target.select()
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commitText(text)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            commitText((e.target as HTMLInputElement).value)
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            setEditing(false)
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

export function Select<T extends string>({ value, options, onChange, className, placeholder = 'Mixed', disabled }: { value: T | ''; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string; placeholder?: string; disabled?: boolean }) {
  return (
    <select
      className={`pf-input appearance-none cursor-default ${disabled ? 'opacity-40' : ''} ${className ?? ''}`}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {/* An empty value means "differs across the selection" for property
       * rows, but "nothing chosen yet" for pickers — so the caller names it.
       * It read "Mixed" on the style dropdown, which meant nothing. */}
      {value === '' && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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
