// Version-history browser (roadmap 3.3): a timeline over the disk-backed
// journal. Click any entry to time-travel there (undo/redo replay); use
// Save As afterwards to fork the document at that state.

import { documentStore, useDocVersion } from '../state/document'
import { useEditor } from '../state/editor'

function formatTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function HistoryModal() {
  useDocVersion()
  const showHistory = useEditor((s) => s.showHistory)
  const setShowHistory = useEditor((s) => s.setShowHistory)
  if (!showHistory) return null

  const applied = documentStore.history.entriesApplied()
  const pending = documentStore.history.entriesPending()
  const cursor = applied.length

  const rows: { label: string; at?: string; position: number; state: 'applied' | 'pending' }[] = [
    ...applied.map((e, i) => ({ label: e.label, at: e.at, position: i + 1, state: 'applied' as const })),
    ...pending.map((e, i) => ({ label: e.label, at: e.at, position: cursor + i + 1, state: 'pending' as const })),
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowHistory(false)}>
      <div
        className="w-[420px] max-h-[70vh] flex flex-col rounded-lg border border-[var(--pf-border)] bg-[#232323] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--pf-border)]">
          <div>
            <div className="text-sm font-semibold">Version history</div>
            <div className="text-[11px] text-[var(--pf-text-dim)]">
              {applied.length} applied · {pending.length} undone · journaled to history.sqlite
            </div>
          </div>
          <button className="pf-btn bg-[var(--pf-bg-3)]" onClick={() => setShowHistory(false)}>
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          <button
            className={`w-full text-left px-4 py-1.5 text-[11px] hover:bg-[var(--pf-bg-2)] ${cursor === 0 ? 'text-white font-semibold' : 'text-[var(--pf-text-dim)]'}`}
            onClick={() => documentStore.jumpTo(0)}
          >
            ◦ Document opened{cursor === 0 ? '  ← current' : ''}
          </button>
          {rows.map((row) => (
            <button
              key={row.position}
              className={`w-full flex items-center gap-2 text-left px-4 py-1.5 text-[11px] hover:bg-[var(--pf-bg-2)] ${
                row.position === cursor ? 'text-white font-semibold' : row.state === 'pending' ? 'text-[var(--pf-text-dim)] opacity-60' : ''
              }`}
              onClick={() => documentStore.jumpTo(row.position)}
            >
              <span className="flex-1 truncate">
                {row.state === 'pending' ? '↷ ' : '• '}
                {row.label}
                {row.position === cursor ? '  ← current' : ''}
              </span>
              <span className="text-[10px] text-[var(--pf-text-dim)]">{formatTime(row.at)}</span>
            </button>
          ))}
          {rows.length === 0 && (
            <div className="px-4 py-3 text-[11px] text-[var(--pf-text-dim)]">No edits yet in this session's journal window.</div>
          )}
        </div>
        <div className="px-4 py-2.5 border-t border-[var(--pf-border)] text-[10px] text-[var(--pf-text-dim)]">
          Tip: jump anywhere, then File → Save As to fork the document at that state.
        </div>
      </div>
    </div>
  )
}
