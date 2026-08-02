// v0.6 item 7.2: the renderer's view of the agent endpoint.
//
// Status is PUSHED from main (mcp:status) rather than polled — an indicator
// that refreshes on a timer is wrong for however long the timer has left,
// and "is something reading my document right now" is exactly the question
// a stale answer fails at.

import { useSyncExternalStore } from 'react'
import type { McpGrants, McpStatus } from '../../../shared/types'
import { agentApi } from './control'

export const OFFLINE_STATUS: McpStatus = {
  running: false,
  port: null,
  token: null,
  clients: 0,
  grants: { document: true, selection: true, changes: true },
  calls: 0,
  lastCall: null,
  lastCallAt: null,
}

let status: McpStatus = OFFLINE_STATUS
const listeners = new Set<() => void>()

function set(next: McpStatus): void {
  status = next
  for (const cb of listeners) cb()
}

export function mcpStatusNow(): McpStatus {
  return status
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useMcpStatus(): McpStatus {
  return useSyncExternalStore(subscribe, mcpStatusNow, mcpStatusNow)
}

/** Reflect the live endpoint into the UI. Safe to call twice. */
let installed = false
export function installAgentStatus(): void {
  if (installed) return
  installed = true
  agentApi().onMcpStatus((next) => set(next))
  // The server survives a renderer reload, so seed from the real state.
  void agentApi().mcpStatus().then(set)
}

export async function startAgentServer(grants?: Partial<McpGrants>): Promise<void> {
  set(await agentApi().mcpStart(grants))
}

export async function stopAgentServer(): Promise<void> {
  set(await agentApi().mcpStop())
}

export async function setAgentGrants(grants: Partial<McpGrants>): Promise<void> {
  set(await agentApi().mcpSetGrants(grants))
}

/** How recently a tool call landed — drives the "reading now" pulse. */
export const READING_WINDOW_MS = 3000

export function isReading(s: McpStatus, now: number): boolean {
  return s.lastCallAt !== null && now - s.lastCallAt < READING_WINDOW_MS
}
