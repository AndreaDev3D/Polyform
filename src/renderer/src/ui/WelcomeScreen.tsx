// First-run screen: create/open a project, recent project list.

import { useEffect, useState } from 'react'
import type { RecentEntry } from '../../../shared/types'
import { newProjectFlow, openProjectFlow } from '../state/actions'

export function WelcomeScreen() {
  const [recents, setRecents] = useState<RecentEntry[]>([])

  useEffect(() => {
    void window.polyform.recentsList().then(setRecents)
  }, [])

  return (
    <div className="h-full flex items-center justify-center bg-[var(--pf-bg-0)]">
      <div className="w-[560px] max-w-[90vw]">
        <div className="flex items-end gap-3 mb-1">
          <h1 className="text-3xl font-semibold tracking-tight text-white">Polyform</h1>
          <span className="text-[11px] text-[var(--pf-text-dim)] pb-1.5">v0.1.0</span>
        </div>
        <p className="text-sm text-[var(--pf-text-dim)] mb-8">
          Local-first vector design. Your projects are plain folders on disk — no cloud, no account.
        </p>

        <div className="flex gap-3 mb-10">
          <button
            className="px-4 py-2.5 rounded-md bg-[var(--pf-accent)] text-white text-sm font-medium hover:opacity-90"
            onClick={() => void newProjectFlow()}
          >
            New Project…
          </button>
          <button
            className="px-4 py-2.5 rounded-md bg-[var(--pf-bg-3)] text-sm text-white hover:bg-[#3a3a3a]"
            onClick={() => void openProjectFlow()}
          >
            Open Project…
          </button>
        </div>

        {recents.length > 0 && (
          <div>
            <h2 className="text-[11px] uppercase tracking-wide text-[var(--pf-text-dim)] mb-2">Recent</h2>
            <div className="flex flex-col rounded-md overflow-hidden border border-[var(--pf-border)]">
              {recents.map((r) => (
                <button
                  key={r.path}
                  className="flex items-center justify-between px-3 py-2.5 text-left hover:bg-[var(--pf-bg-2)] border-b border-[var(--pf-border)] last:border-b-0"
                  onClick={() => void openProjectFlow(r.path)}
                >
                  <span className="text-sm text-white">{r.title}</span>
                  <span className="text-[11px] text-[var(--pf-text-dim)] truncate max-w-72 ml-4" dir="rtl">
                    {r.path}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
