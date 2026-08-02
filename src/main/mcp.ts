// v0.6 spike 7.1 prototype: an MCP server hosted inside the running app.
//
// Agents cannot attach to a live GUI over stdio — the client would have to
// spawn the server itself. So Polyform hosts a Streamable HTTP endpoint on
// the loopback interface and the agent dials in, the same shape Figma's
// desktop Dev Mode server uses.
//
// Security posture (MCP spec §Transports "Security Warning" + F-15/F-17):
//   - off unless explicitly started; never on by default
//   - binds 127.0.0.1 only, never 0.0.0.0
//   - a per-session bearer token is required on every request
//   - Origin/Host are validated (DNS-rebinding protection)
// The document itself lives in the renderer, so every tool call round-trips
// through one IPC bridge; the main process holds no scene state.

import { createServer, type Server as HttpServer } from 'node:http'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

/** Answers a tool call by asking the renderer, which owns the document. */
export type SceneQuery = (method: string, params: unknown) => Promise<unknown>

export interface McpStatus {
  running: boolean
  port: number | null
  token: string | null
  /** Connected agent sessions (informational — drives the UI indicator). */
  clients: number
}

let http: HttpServer | null = null
let token: string | null = null
let port: number | null = null
const sessions = new Set<string>()

function bearerOk(header: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false
  const got = Buffer.from(header.slice(7))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

function buildServer(query: SceneQuery): McpServer {
  const server = new McpServer(
    { name: 'polyform', version: '0.6.0-spike' },
    {
      instructions:
        'Polyform is a local-first vector design tool. These tools read the ' +
        'document that is open in the running app right now. Edits made by ' +
        'the human appear in poll_changes as they happen.',
    },
  )

  server.registerTool(
    'get_document',
    {
      title: 'Get document',
      description:
        'Summary of the document currently open in Polyform: pages, node counts, and the active page tree.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const doc = await query('document.summary', {})
      return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] }
    },
  )

  server.registerTool(
    'get_selection',
    {
      title: 'Get selection',
      description: 'The layers the user currently has selected, with their geometry.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const sel = await query('selection.get', {})
      return { content: [{ type: 'text', text: JSON.stringify(sel, null, 2) }] }
    },
  )

  server.registerTool(
    'poll_changes',
    {
      title: 'Poll changes',
      description:
        'Edits committed since a cursor, newest last. Call with cursor 0 to start, ' +
        'then pass back the returned cursor to see what the user has done since. ' +
        'This is how you watch the work happen live.',
      inputSchema: { cursor: z.number().int().min(0).describe('Journal position from the previous call; 0 to start') },
      annotations: { readOnlyHint: true },
    },
    async ({ cursor }) => {
      const changes = await query('changes.since', { cursor })
      return { content: [{ type: 'text', text: JSON.stringify(changes, null, 2) }] }
    },
  )

  return server
}

/**
 * Start the loopback MCP endpoint. Returns the URL + token the user hands
 * to their agent client. Idempotent: a second call returns the live status.
 */
export async function mcpStart(query: SceneQuery): Promise<McpStatus> {
  if (http) return mcpStatus()

  token = randomBytes(24).toString('base64url')

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
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // The spec requires Origin validation to stop a web page in the user's
    // browser from driving this server (DNS rebinding). Loopback only.
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
    onsessioninitialized: (id) => {
      sessions.add(id)
    },
    onsessionclosed: (id) => {
      sessions.delete(id)
    },
  })
  await server.connect(transport)
  return mcpStatus()
}

export async function mcpStop(): Promise<McpStatus> {
  const server = http
  http = null
  token = null
  port = null
  sessions.clear()
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  return mcpStatus()
}

export function mcpStatus(): McpStatus {
  return { running: http !== null, port, token, clients: sessions.size }
}
