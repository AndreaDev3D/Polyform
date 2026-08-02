// v0.6 item 7.2: an MCP server hosted inside the running app (ADR-021).
//
// Agents cannot attach to a live GUI over stdio — the client would have to
// spawn the server itself. So Polyform hosts a Streamable HTTP endpoint on
// the loopback interface and the agent dials in, the same shape Figma's
// desktop Dev Mode server uses.
//
// Security posture (MCP spec §Transports "Security Warning" + F-15/F-20):
//   - off unless explicitly started; never on by default
//   - binds 127.0.0.1 only, never 0.0.0.0
//   - a per-session bearer token is required on every request
//   - Origin/Host are validated (DNS-rebinding protection)
//   - every tool is gated on a capability the user granted, and revoking a
//     capability takes effect on already-connected sessions
// The document itself lives in the renderer, so every tool call round-trips
// through one IPC bridge; the main process holds no scene state.

import { createServer, type Server as HttpServer } from 'node:http'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { McpCapability, McpGrants, McpStatus } from '../shared/types'

/** Answers a tool call by asking the renderer, which owns the document. */
export type SceneQuery = (method: string, params: unknown) => Promise<unknown>

export const ALL_CAPABILITIES: readonly McpCapability[] = ['document', 'selection', 'changes']

/** Reads only, and the user still opts in per capability before starting. */
export const DEFAULT_GRANTS: McpGrants = { document: true, selection: true, changes: true }

let http: HttpServer | null = null
let mcp: McpServer | null = null
let token: string | null = null
let port: number | null = null
let grants: McpGrants = { ...DEFAULT_GRANTS }
let calls = 0
let lastCall: McpCapability | null = null
let lastCallAt: number | null = null
const sessions = new Set<string>()
const tools = new Map<McpCapability, RegisteredTool>()

/** Status pushes drive the UI indicator — polling would lie between polls. */
const watchers = new Set<(s: McpStatus) => void>()

export function onMcpStatus(cb: (s: McpStatus) => void): () => void {
  watchers.add(cb)
  return () => watchers.delete(cb)
}

function announce(): void {
  const status = mcpStatus()
  for (const cb of watchers) cb(status)
}

function bearerOk(header: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false
  const got = Buffer.from(header.slice(7))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * Wrap a tool body so a call is refused unless its capability is granted,
 * and so the UI can show that a read happened. `disable()` already hides a
 * revoked tool from `tools/list`, but a client holding a stale list can
 * still call it — the grant is enforced here, at the door.
 */
function guarded<A>(
  cap: McpCapability,
  run: (args: A) => Promise<unknown>,
): (args: A) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  // Zero-argument tools get the SDK's `extra` here instead of parsed args;
  // they ignore it, so one wrapper serves both shapes.
  return async (args: A) => {
    if (!grants[cap]) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `The "${cap}" capability is not granted. The person using Polyform ` +
              `controls this in Agent → Agent Connection; ask them to grant it.`,
          },
        ],
        isError: true,
      }
    }
    calls += 1
    lastCall = cap
    lastCallAt = Date.now()
    announce()
    const value = await run(args)
    return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
  }
}

function buildServer(query: SceneQuery): McpServer {
  const server = new McpServer(
    { name: 'polyform', version: '0.6.0' },
    {
      instructions:
        'Polyform is a local-first vector design tool. These tools read the ' +
        'document that is open in the running app right now. Edits made by ' +
        'the human appear in poll_changes as they happen. The person at the ' +
        'keyboard grants each capability and can revoke it mid-session, so a ' +
        'tool that worked earlier may start refusing.',
    },
  )

  tools.clear()

  tools.set(
    'document',
    server.registerTool(
      'get_document',
      {
        title: 'Get document',
        description:
          'Summary of the document currently open in Polyform: pages, node counts, and the active page tree.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      guarded('document', () => query('document.summary', {})),
    ),
  )

  tools.set(
    'selection',
    server.registerTool(
      'get_selection',
      {
        title: 'Get selection',
        description: 'The layers the user currently has selected, with their geometry.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      guarded('selection', () => query('selection.get', {})),
    ),
  )

  tools.set(
    'changes',
    server.registerTool(
      'poll_changes',
      {
        title: 'Poll changes',
        description:
          'Edits committed since a cursor, newest last. Call with cursor 0 to start, ' +
          'then pass back the returned cursor to see what the user has done since. ' +
          'This is how you watch the work happen live.',
        inputSchema: {
          cursor: z
            .number()
            .int()
            .min(0)
            .describe('Journal position from the previous call; 0 to start'),
        },
        annotations: { readOnlyHint: true },
      },
      guarded('changes', ({ cursor }: { cursor: number }) => query('changes.since', { cursor })),
    ),
  )

  syncTools()
  return server
}

/** Reflect the current grants onto the live server; fires tools/list_changed. */
function syncTools(): void {
  for (const cap of ALL_CAPABILITIES) {
    const tool = tools.get(cap)
    if (!tool) continue
    if (grants[cap] && !tool.enabled) tool.enable()
    else if (!grants[cap] && tool.enabled) tool.disable()
  }
}

/**
 * Change what a connected agent may read. Takes effect immediately: revoked
 * tools disappear from `tools/list` (connected clients are notified) and are
 * refused if called anyway.
 */
export function mcpSetGrants(next: Partial<McpGrants>): McpStatus {
  grants = { ...grants, ...next }
  if (http) syncTools()
  announce()
  return mcpStatus()
}

/**
 * Start the loopback MCP endpoint. Returns the URL + token the user hands
 * to their agent client. Idempotent: a second call returns the live status.
 */
export async function mcpStart(query: SceneQuery, next?: Partial<McpGrants>): Promise<McpStatus> {
  if (next) grants = { ...grants, ...next }
  if (http) {
    syncTools()
    announce()
    return mcpStatus()
  }

  token = randomBytes(24).toString('base64url')
  calls = 0
  lastCall = null
  lastCallAt = null

  // The host/origin allowlists must carry the port, and the port isn't
  // known until the socket is bound — so listen first, then build the
  // transport, then let requests through.
  let transport: StreamableHTTPServerTransport | null = null
  http = createServer((req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end()
      return
    }
    if (!bearerOk(req.headers.authorization)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'unauthorized: pass the token shown in Polyform as a bearer token' }),
      )
      return
    }
    if (!transport) {
      res.writeHead(503).end()
      return
    }
    void transport.handleRequest(req, res)
  })

  await new Promise<void>((resolve, reject) => {
    http!.once('error', reject)
    // Port 0 → the OS picks a free one; no fixed port to collide with.
    http!.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = http.address()
  port = typeof addr === 'object' && addr ? addr.port : null

  const server = buildServer(query)
  mcp = server
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // The spec requires Origin validation to stop a web page in the user's
    // browser from driving this server (DNS rebinding). Loopback only.
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
    onsessioninitialized: (id) => {
      sessions.add(id)
      announce()
    },
    onsessionclosed: (id) => {
      sessions.delete(id)
      announce()
    },
  })
  await server.connect(transport)
  announce()
  return mcpStatus()
}

export async function mcpStop(): Promise<McpStatus> {
  const server = http
  const server_ = mcp
  http = null
  mcp = null
  token = null
  port = null
  sessions.clear()
  tools.clear()
  // Drop the MCP session state first, then the socket.
  if (server_) await server_.close().catch(() => undefined)
  if (server) {
    // close() alone only stops NEW connections and then waits for existing
    // ones to drain — and an attached agent holds a keep-alive socket open
    // indefinitely, so "Stop" would hang exactly when it matters. Destroy
    // the live sockets: the panel promises the port closes immediately.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  announce()
  return mcpStatus()
}

export function mcpStatus(): McpStatus {
  return {
    running: http !== null,
    port,
    token,
    clients: sessions.size,
    grants: { ...grants },
    calls,
    lastCall,
    lastCallAt,
  }
}
