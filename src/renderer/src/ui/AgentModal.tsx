// Agent connection panel (v0.6 item 7.2, ADR-021 / F-20).
//
// This is the consent surface. Starting the endpoint is an explicit act, the
// capabilities an agent holds are listed and individually revocable while it
// is connected, and the panel says plainly what a connected agent can and
// cannot see. Nothing here is on by default.

import { useEffect, useState } from 'react'
import { useEditor } from '../state/editor'
import {
  isReading,
  setAgentGrants,
  startAgentServer,
  stopAgentServer,
  useMcpStatus,
} from '../agent/status'
import type { McpCapability } from '../../../shared/types'

interface CapabilityInfo {
  key: McpCapability
  tool: string
  label: string
  detail: string
}

const WRITE_CAPABILITY: CapabilityInfo = {
  key: 'edit',
  tool: 'edit_document, import_image, remove_background',
  label: 'Change the document',
  detail:
    'Create, restyle, move and delete layers, add images it sends over, and cut image ' +
    'backgrounds on-device. Every change lands in your history as an "Agent:" entry — ' +
    'one Ctrl+Z removes it. Off unless you turn it on.',
}

const CAPABILITIES: CapabilityInfo[] = [
  {
    key: 'document',
    tool: 'get_document, get_node',
    label: 'Read the document',
    detail:
      'Pages, layers and text content; and on request, how a layer looks — ' +
      'colours, strokes, effects, fonts, layout, styles and components.',
  },
  {
    key: 'selection',
    tool: 'get_selection',
    label: 'Read the current selection',
    detail: 'Which layers you have selected right now, and their geometry.',
  },
  {
    key: 'render',
    tool: 'get_view_image, get_node_image',
    label: 'See the canvas',
    detail: 'Pictures of what you are looking at, or of a single layer.',
  },
  {
    key: 'changes',
    tool: 'poll_changes',
    label: 'Watch edits as they happen',
    detail: 'The labels of edits you commit, and which layers each one touched.',
  },
]

function relative(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 1) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="pf-btn bg-[var(--pf-bg-3)] shrink-0"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}

export function AgentModal() {
  const showAgent = useEditor((s) => s.showAgent)
  const setShowAgent = (v: boolean) => useEditor.setState({ showAgent: v })
  const status = useMcpStatus()
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Only tick while the panel is open and something is actually connected;
  // this drives the "last read" line, nothing else.
  useEffect(() => {
    if (!showAgent || !status.running) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [showAgent, status.running])

  if (!showAgent) return null

  const url = status.port ? `http://127.0.0.1:${status.port}/mcp` : null
  const granted = CAPABILITIES.filter((c) => status.grants[c.key]).length
  const command =
    url && status.token
      ? `claude mcp add --transport http polyform ${url} --header "Authorization: Bearer ${status.token}"`
      : ''

  const run = (fn: () => Promise<void>) => {
    setBusy(true)
    void fn().finally(() => setBusy(false))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setShowAgent(false)}
    >
      <div
        className="w-[520px] max-h-[80vh] flex flex-col rounded-lg border border-[var(--pf-border)] bg-[#232323] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--pf-border)]">
          <div>
            <div className="text-sm font-semibold">Agent connection</div>
            <div className="text-[11px] text-[var(--pf-text-dim)] flex items-center gap-1.5">
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${
                  !status.running
                    ? 'bg-[var(--pf-text-dim)]'
                    : status.clients > 0
                      ? 'bg-[#43c463]'
                      : 'bg-[#d8a13a]'
                }`}
              />
              {!status.running
                ? 'Off — nothing is listening'
                : status.clients > 0
                  ? `${status.clients} agent session${status.clients === 1 ? '' : 's'} connected`
                  : 'Listening — no agent has connected yet'}
            </div>
          </div>
          <button className="pf-btn bg-[var(--pf-bg-3)]" onClick={() => setShowAgent(false)}>
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-3 text-[11px] text-[var(--pf-text-dim)] leading-relaxed border-b border-[var(--pf-border)]">
            Lets an AI agent on <span className="text-[var(--pf-text)]">this machine</span> work on
            the document you have open, over a local connection that only this computer can reach.
            Nothing is uploaded. Reading is granted per capability below; changing the document is a
            separate grant that starts off. You can revoke any of it while an agent is connected.
          </div>

          <div className="px-4 py-3 border-b border-[var(--pf-border)]">
            <div className="text-[11px] font-semibold mb-2">
              What the agent may read
              {status.running && (
                <span className="font-normal text-[var(--pf-text-dim)]">
                  {'  '}· {granted} of {CAPABILITIES.length} granted
                </span>
              )}
            </div>
            {CAPABILITIES.map((cap) => (
              <label
                key={cap.key}
                className="flex items-start gap-2 py-1.5 cursor-default hover:bg-[var(--pf-bg-2)] -mx-2 px-2 rounded"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--pf-accent)]"
                  checked={status.grants[cap.key]}
                  onChange={(e) => run(() => setAgentGrants({ [cap.key]: e.target.checked }))}
                />
                <span className="flex-1">
                  <span className="text-[11px]">{cap.label}</span>
                  <span className="block text-[10px] text-[var(--pf-text-dim)]">{cap.detail}</span>
                </span>
                <code className="text-[10px] text-[var(--pf-text-dim)] shrink-0">{cap.tool}</code>
              </label>
            ))}
            {granted === 0 && (
              <div className="mt-2 text-[10px] text-[#d8a13a]">
                Nothing is granted — a connected agent can see no part of your document.
              </div>
            )}
          </div>

          <div className="px-4 py-3 border-b border-[var(--pf-border)]">
            <div className="text-[11px] font-semibold mb-2 flex items-center gap-1.5">
              What the agent may change
              <span
                className={`text-[9px] font-normal px-1.5 py-px rounded ${
                  status.grants.edit ? 'bg-[#d8a13a] text-black' : 'bg-[var(--pf-bg-3)] text-[var(--pf-text-dim)]'
                }`}
              >
                {status.grants.edit ? 'WRITES ON' : 'off by default'}
              </span>
            </div>
            <label className="flex items-start gap-2 py-1.5 cursor-default hover:bg-[var(--pf-bg-2)] -mx-2 px-2 rounded">
              <input
                type="checkbox"
                className="mt-0.5 accent-[#d8a13a]"
                checked={status.grants.edit}
                onChange={(e) => run(() => setAgentGrants({ edit: e.target.checked }))}
              />
              <span className="flex-1">
                <span className="text-[11px]">{WRITE_CAPABILITY.label}</span>
                <span className="block text-[10px] text-[var(--pf-text-dim)]">
                  {WRITE_CAPABILITY.detail}
                </span>
              </span>
              <code className="text-[10px] text-[var(--pf-text-dim)] shrink-0">
                {WRITE_CAPABILITY.tool}
              </code>
            </label>
          </div>

          {status.running && url && status.token && (
            <>
              <div className="px-4 py-3 border-b border-[var(--pf-border)]">
                <div className="text-[11px] font-semibold mb-2">Connect your agent</div>
                <div className="text-[10px] text-[var(--pf-text-dim)] mb-1.5">
                  Run this once in a terminal. The address and token are new every time you start
                  the endpoint.
                </div>
                <div className="flex items-start gap-2">
                  <code className="flex-1 min-w-0 text-[10px] bg-[var(--pf-bg-0)] rounded p-2 break-all select-text">
                    {reveal
                      ? command
                      : command.replace(`Bearer ${status.token}`, 'Bearer ••••••••••••')}
                  </code>
                  <div className="flex flex-col gap-1">
                    <CopyButton text={command} label="Copy" />
                    <button
                      className="pf-btn bg-[var(--pf-bg-3)] shrink-0"
                      onClick={() => setReveal(!reveal)}
                    >
                      {reveal ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-[var(--pf-text-dim)]">
                  Endpoint <code className="select-text">{url}</code> · loopback only · the token is
                  required on every request
                </div>
              </div>

              <div className="px-4 py-3 border-b border-[var(--pf-border)]">
                <div className="text-[11px] font-semibold mb-1">Activity</div>
                <div className="text-[10px] text-[var(--pf-text-dim)]">
                  {status.calls === 0 ? (
                    'Nothing has been read yet.'
                  ) : (
                    <>
                      {status.calls} read{status.calls === 1 ? '' : 's'} this session
                      {status.lastCall && status.lastCallAt && (
                        <>
                          {' · last: '}
                          <span
                            className={isReading(status, now) ? 'text-[#43c463]' : undefined}
                          >
                            {status.lastCall} {relative(now - status.lastCallAt)}
                          </span>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[var(--pf-border)]">
          <div className="flex-1 text-[10px] text-[var(--pf-text-dim)]">
            {status.running
              ? 'Stopping closes the port and invalidates the token immediately.'
              : 'Nothing listens until you start it, and it stops when Polyform closes.'}
          </div>
          {status.running ? (
            <button
              className="pf-btn bg-[var(--pf-bg-3)]"
              disabled={busy}
              onClick={() => run(stopAgentServer)}
            >
              Stop
            </button>
          ) : (
            <button
              className="pf-btn bg-[var(--pf-accent-solid)] text-white"
              disabled={busy}
              onClick={() => run(() => startAgentServer())}
            >
              Start endpoint
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
