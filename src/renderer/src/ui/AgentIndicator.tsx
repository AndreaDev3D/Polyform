// The "an agent is attached" light (v0.6 item 7.2, F-20).
//
// Rendered in the status bar whenever the endpoint is listening — there is
// no state in which something can read the document without this being
// visible. Click to open the consent panel and revoke.

import { useEffect, useState } from 'react'
import { useEditor } from '../state/editor'
import { READING_WINDOW_MS, isReading, useMcpStatus } from '../agent/status'

export function AgentIndicator() {
  const status = useMcpStatus()
  const [now, setNow] = useState(() => Date.now())

  // Wake once to clear the pulse after the last read, rather than polling.
  useEffect(() => {
    if (status.lastCallAt === null) return
    const left = status.lastCallAt + READING_WINDOW_MS - Date.now()
    if (left <= 0) return
    const t = window.setTimeout(() => setNow(Date.now()), left)
    return () => window.clearTimeout(t)
  }, [status.lastCallAt])

  if (!status.running) return null

  const reading = isReading(status, now)
  const connected = status.clients > 0
  const label = reading
    ? `Agent reading ${status.lastCall}`
    : connected
      ? `Agent connected${status.clients > 1 ? ` (${status.clients})` : ''}`
      : 'Agent endpoint on'

  return (
    <button
      className="flex items-center gap-1.5 px-1.5 rounded hover:bg-[var(--pf-bg-2)] cursor-default"
      title="Agent connection — click to review or revoke what it can read"
      onClick={() => useEditor.setState({ showAgent: true })}
    >
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${
          reading ? 'bg-[#43c463]' : connected ? 'bg-[#43c463] opacity-70' : 'bg-[#d8a13a]'
        }`}
      />
      <span className={reading ? 'text-[var(--pf-text)]' : undefined}>{label}</span>
    </button>
  )
}
