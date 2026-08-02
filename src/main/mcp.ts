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

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { McpCapability, McpGrants, McpStatus } from '../shared/types'

/** Answers a tool call by asking the renderer, which owns the document. */
export type SceneQuery = (method: string, params: unknown) => Promise<unknown>

export const ALL_CAPABILITIES: readonly McpCapability[] = [
  'document',
  'selection',
  'changes',
  'render',
  'edit',
]

/**
 * Reads default on (the user still opts in by starting the endpoint at
 * all); `edit` defaults OFF — changing the document is a separate decision,
 * made per session, never inherited from having once allowed reading.
 */
export const DEFAULT_GRANTS: McpGrants = {
  document: true,
  selection: true,
  changes: true,
  render: true,
  edit: false,
}

/**
 * One connected agent. A `StreamableHTTPServerTransport` binds to exactly
 * one MCP session for its lifetime — a second `initialize` on the same
 * transport is rejected with "Server already initialized" — so a transport
 * per session is not an optimization, it is the only way a client can
 * reconnect or a second agent can attach at all.
 */
interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  /** Tool name → the capability that gates it. Several may share one. */
  tools: Map<string, { cap: McpCapability; tool: RegisteredTool }>
}

let http: HttpServer | null = null
let token: string | null = null
let port: number | null = null
let grants: McpGrants = { ...DEFAULT_GRANTS }
let calls = 0
let lastCall: McpCapability | null = null
let lastCallAt: number | null = null
const sessions = new Map<string, Session>()

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
type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
type ToolResult = { content: ToolContent[]; isError?: boolean }

function asText(value: unknown): ToolContent[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** A rendered snapshot from the renderer, returned as a real image block. */
function asImage(value: unknown): ToolContent[] {
  const snap = value as { base64?: string; width?: number; height?: number; scale?: number; note?: string }
  if (!snap?.base64) throw new Error('renderer returned no image')
  const { base64, ...meta } = snap
  return [
    { type: 'image', data: base64, mimeType: 'image/png' },
    { type: 'text', text: JSON.stringify(meta, null, 2) },
  ]
}

function guarded<A>(
  cap: McpCapability,
  run: (args: A) => Promise<unknown>,
  present: (value: unknown) => ToolContent[] = asText,
): (args: A) => Promise<ToolResult> {
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
    return { content: present(await run(args)) }
  }
}

function buildServer(query: SceneQuery): Omit<Session, 'transport'> {
  const tools = new Map<string, { cap: McpCapability; tool: RegisteredTool }>()
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

  tools.set('get_document', {
    cap: 'document',
    tool: server.registerTool(
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
  })

  // Detail-on-demand, so the summary can stay small. Same capability as
  // get_document: it is the same document, read more closely.
  tools.set('get_node', {
    cap: 'document',
    tool: server.registerTool(
      'get_node',
      {
        title: 'Get node detail',
        description:
          'Everything that decides how one layer looks: fills, strokes, effects, corner ' +
          'radius, auto-layout, constraints, shared styles it uses, text and font settings, ' +
          'and component/instance links. Pass depth to include descendants. Ids come from ' +
          'get_document or get_selection.',
        inputSchema: {
          id: z.string().min(1).describe('Node id from get_document or get_selection'),
          depth: z
            .number()
            .int()
            .min(0)
            .max(8)
            .optional()
            .describe('Levels of children to include (default 1, max 8)'),
        },
        annotations: { readOnlyHint: true },
      },
      guarded('document', (args: { id: string; depth?: number }) =>
        query('node.detail', { id: args.id, depth: args.depth }),
      ),
    ),
  })

  tools.set('get_selection', {
    cap: 'selection',
    tool: server.registerTool(
      'get_selection',
      {
        title: 'Get selection',
        description: 'The layers the user currently has selected, with their geometry.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      guarded('selection', () => query('selection.get', {})),
    ),
  })

  // Pixels, not structure. An agent that can only read the tree is guessing
  // about what the work actually looks like.
  tools.set('get_view_image', {
    cap: 'render',
    tool: server.registerTool(
      'get_view_image',
      {
        title: 'See the canvas',
        description:
          'A PNG of the area the user is looking at right now, at their current zoom. ' +
          'Use this to see what the design actually looks like rather than inferring it ' +
          'from the layer tree.',
        inputSchema: {
          maxEdge: z
            .number()
            .int()
            .min(64)
            .max(1568)
            .optional()
            .describe('Longest edge in pixels (default 1024, max 1568)'),
        },
        annotations: { readOnlyHint: true },
      },
      guarded(
        'render',
        (args: { maxEdge?: number }) => query('render.viewport', { maxEdge: args.maxEdge }),
        asImage,
      ),
    ),
  })

  tools.set('get_node_image', {
    cap: 'render',
    tool: server.registerTool(
      'get_node_image',
      {
        title: 'See one layer',
        description:
          'A PNG of a single layer and its contents, cropped to its own bounds. ' +
          'Ids come from get_document or get_selection.',
        inputSchema: {
          id: z.string().min(1).describe('Node id from get_document or get_selection'),
          maxEdge: z
            .number()
            .int()
            .min(64)
            .max(1568)
            .optional()
            .describe('Longest edge in pixels (default 1024, max 1568)'),
        },
        annotations: { readOnlyHint: true },
      },
      guarded(
        'render',
        (args: { id: string; maxEdge?: number }) =>
          query('render.node', { id: args.id, maxEdge: args.maxEdge }),
        asImage,
      ),
    ),
  })

  // The write surface (7.3). One call = one batch = ONE undo entry, the
  // same contract as a human gesture (ADR-008). Gated on `edit`, which
  // defaults OFF — and the user can pull it mid-session like any grant.
  tools.set('edit_document', {
    cap: 'edit',
    tool: server.registerTool(
      'edit_document',
      {
        title: 'Edit the document',
        description:
          'Apply a batch of edits to the open document as ONE undoable entry, attributed ' +
          'to you in the history browser. Ops run in order and atomically — if any fails, ' +
          'nothing is applied. `create` accepts type (RECTANGLE, ELLIPSE, LINE, POLYGON, ' +
          'STAR, TEXT, FRAME), optional parentId (a FRAME id, or omit for the page root), ' +
          'optional index (z-order among siblings, 0 = back), optional ref (name it, then ' +
          'use "$ref" as id/parentId in later ops of the SAME call), and props. Writable ' +
          'props: name, x, y, width, height (parent-relative), rotation, opacity, visible, ' +
          'locked, blendMode, cornerRadius, fill, stroke ("#RRGGBB", "#RRGGBBAA", or ' +
          '{gradient: "LINEAR"|"RADIAL", stops: [{at, color}], start?, end?} in 0..1 node ' +
          'space; null clears), strokeWeight, strokeAlign, strokeDash, characters, ' +
          'fontFamily, fontWeight, fontSize, lineHeight, letterSpacing, italic, textAlignH, ' +
          'textAlignV, pointCount, innerRatio, clipsContent. `update`/`move`/`delete` take ' +
          'an id. Instance internals are off-limits. Use get_node_image afterwards to see ' +
          'what you made.',
        inputSchema: {
          label: z
            .string()
            .min(1)
            .max(60)
            .describe('Names the undo entry the user sees, e.g. "Background composition"'),
          edits: z
            .array(
              z
                .object({
                  op: z.enum(['create', 'update', 'move', 'delete']),
                  type: z.string().optional(),
                  ref: z.string().max(40).optional(),
                  id: z.string().optional(),
                  parentId: z.string().nullable().optional(),
                  index: z.number().int().min(0).optional(),
                  props: z.record(z.string(), z.unknown()).optional(),
                })
                .strict(),
            )
            .min(1)
            .max(100)
            .describe('Executed in order, atomically'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      guarded('edit', (args: { label: string; edits: unknown[] }) =>
        query('document.edit', { label: args.label, edits: args.edits }),
      ),
    ),
  })

  tools.set('poll_changes', {
    cap: 'changes',
    tool: server.registerTool(
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
  })

  syncSession(tools)
  return { server, tools }
}

/** Reflect the current grants onto one session; fires tools/list_changed. */
function syncSession(tools: Session['tools']): void {
  for (const { cap, tool } of tools.values()) {
    if (grants[cap] && !tool.enabled) tool.enable()
    else if (!grants[cap] && tool.enabled) tool.disable()
  }
}

/** ...and onto every session that is currently attached. */
function syncTools(): void {
  for (const session of sessions.values()) syncSession(session.tools)
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
  // known until the socket is bound — so listen first, then serve.
  let ready = false
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
    if (!ready) {
      res.writeHead(503).end()
      return
    }

    const sid = req.headers['mcp-session-id']
    const existing = typeof sid === 'string' ? sessions.get(sid) : undefined
    if (existing) {
      void existing.transport.handleRequest(req, res)
      return
    }
    if (sid) {
      // A client resuming a session we no longer have (endpoint restarted,
      // or the session was closed). Say so plainly; clients re-initialize.
      res.writeHead(404, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'unknown session — reconnect to start a new one' }),
      )
      return
    }
    // No session id: a new agent initializing. Give it its own transport.
    void openSession(query, req, res)
  })

  await new Promise<void>((resolve, reject) => {
    http!.once('error', reject)
    // Port 0 → the OS picks a free one; no fixed port to collide with.
    http!.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = http.address()
  port = typeof addr === 'object' && addr ? addr.port : null
  ready = true
  announce()
  return mcpStatus()
}

/**
 * Stand up a fresh session for an initializing client. Each gets its own
 * transport AND its own McpServer, because both are single-session objects
 * in the SDK; sharing one is why a reconnect used to fail outright.
 */
async function openSession(
  query: SceneQuery,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { server, tools } = buildServer(query)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // The spec requires Origin validation to stop a web page in the user's
    // browser from driving this server (DNS rebinding). Loopback only.
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, tools })
      announce()
    },
    onsessionclosed: (id) => {
      sessions.delete(id)
      announce()
    },
  })
  // Covers the paths onsessionclosed does not: a dropped socket, or the
  // transport erroring out. Without this a vanished agent stays "connected"
  // in the indicator forever.
  transport.onclose = () => {
    if (transport.sessionId && sessions.delete(transport.sessionId)) announce()
  }
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (err) {
    console.warn('[polyform] mcp: session failed to open:', err)
    if (!res.headersSent) res.writeHead(500).end()
    await server.close().catch(() => undefined)
  }
}

export async function mcpStop(): Promise<McpStatus> {
  const server = http
  const open = [...sessions.values()]
  http = null
  token = null
  port = null
  sessions.clear()
  // Drop every session's MCP state first, then the socket.
  await Promise.all(open.map((s) => s.server.close().catch(() => undefined)))
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
