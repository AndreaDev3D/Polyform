// Small shared UI primitives: number inputs with label scrubbing, selects,
// segmented controls, sections.

import { useEffect, useRef, useState, type ReactNode } from 'react'

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

interface NumberInputProps {
  label?: string
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
export function NumberInput({ label, value, onCommit, step = 1, min = -Infinity, max = Infinity, precision = 2, suffix, className }: NumberInputProps) {
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const dragRef = useRef<{ startX: number; startVal: number; active: boolean } | null>(null)

  const display = value === null ? '' : String(round(value, precision))

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
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.startX
      if (!d.active && Math.abs(dx) < 3) return
      d.active = true
      onCommitLive(clampNum(d.startVal + dx * step, min, max))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Scrub commits continuously (each change is applied; caller may debounce).
  const onCommitLive = onCommit

  return (
    <div className={`flex items-center gap-1 ${className ?? ''}`}>
      {label && (
        <span
          className="text-[10px] text-[var(--pf-text-dim)] w-4 shrink-0 cursor-ew-resize select-none"
          onPointerDown={onLabelPointerDown}
        >
          {label}
        </span>
      )}
      <input
        className="pf-input"
        value={editing ? text : display}
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
      {suffix && <span className="text-[10px] text-[var(--pf-text-dim)]">{suffix}</span>}
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

export function Select<T extends string>({ value, options, onChange, className }: { value: T | ''; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <select
      className={`pf-input appearance-none cursor-default ${className ?? ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {value === '' && <option value="">Mixed</option>}
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
          className={`flex-1 flex items-center justify-center rounded px-1.5 py-1 text-[11px] ${value === o.value ? 'bg-[#454545] text-white' : 'text-[var(--pf-text-dim)] hover:text-white'}`}
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
