// v0.6 spike 7.1 gate: prove a REAL MCP client can attach to the running
// app, discover its tools, and read the live document (ADR-021).
//
// Boots the built app, starts the loopback MCP server through the debug
// hook, then connects with the official @modelcontextprotocol/sdk client
// over Streamable HTTP — the same code path Claude Code uses for an
// `http` server entry. Also checks that the auth and DNS-rebinding
// defences actually reject bad requests, and that an edit made in the app
// shows up in the change feed.
//
// Usage: npm run build && node scripts/mcp-probe.mjs

import { spawn } from 'node:child_process'
import process from 'node:process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PORT = 9351
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(msg) {
  console.error(`MCP FAIL: ${msg}`)
  process.exitCode = 1
}

const electron = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', 'out/main/index.js', `--remote-debugging-port=${PORT}`],
  { cwd: ROOT, stdio: 'ignore', shell: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } },
)

let ws
let client
try {
  // --- attach to the renderer over CDP so we can drive the app ------------
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw new Error('app did not expose a debug target')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r.result?.result?.value
  }
  await new Promise((r) => (ws.onopen = r))
  await send('Runtime.enable')

  for (let i = 0; i < 40 && !(await evaluate('!!globalThis.__polyform')); i++) await sleep(250)

  // Synthesize an open project with one named rectangle.
  await evaluate(`globalThis.__polyform.documentStore.loadFromResult({
    info: { path: 'mcp-probe.poly', manifest: { name: 'Probe', title: 'Probe', schemaVersion: 4 } },
    sceneBytes: null, journal: { entries: [], cursor: 0 } })`)
  await evaluate(`globalThis.__polyform.editor.set({ hasProject: true })`)
  await evaluate(`(() => {
    const s = globalThis.__polyform.documentStore.scene
    const n = { id: 'probe-rect', type: 'RECTANGLE', name: 'Probe Rect',
      visible: true, locked: false, opacity: 1, blendMode: 'NORMAL',
      x: 10, y: 20, width: 300, height: 200, rotation: 0,
      fills: [], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', strokeDash: [], effects: [],
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 } }
    s.addNode(n, null, 0)
    globalThis.__polyform.documentStore.transient()
    return 'ok'
  })()`)
  await sleep(300)

  // --- start the in-app MCP server ---------------------------------------
  const status = await evaluate(`window.polyform.mcpStart()`)
  if (!status?.running || !status.port || !status.token) {
    throw new Error(`server did not start: ${JSON.stringify(status)}`)
  }
  const url = `http://127.0.0.1:${status.port}/mcp`
  console.log(`MCP server listening on ${url}`)

  // --- negative tests: the defences must actually refuse ------------------
  const noAuth = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  if (noAuth.status !== 401) fail(`unauthenticated request should be 401, got ${noAuth.status}`)
  else console.log('MCP PASS: unauthenticated request rejected (401)')

  const badOrigin = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${status.token}`,
      origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  if (badOrigin.status !== 403) fail(`cross-origin request should be 403, got ${badOrigin.status}`)
  else console.log('MCP PASS: cross-origin request rejected (403, DNS-rebinding defence)')

  // --- the real client ----------------------------------------------------
  client = new Client({ name: 'polyform-probe', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${status.token}` } },
  })
  await client.connect(transport)
  console.log('MCP PASS: client connected and initialized')

  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  console.log(`MCP PASS: tools discovered = ${JSON.stringify(names)}`)
  for (const want of ['get_document', 'get_selection', 'poll_changes']) {
    if (!names.includes(want)) fail(`missing tool ${want}`)
  }

  const docCall = await client.callTool({ name: 'get_document', arguments: {} })
  const doc = JSON.parse(docCall.content[0].text)
  if (doc.project !== 'Probe') fail(`expected the live project title, got ${JSON.stringify(doc.project)}`)
  if (doc.schemaVersion !== 4) fail(`expected schemaVersion 4, got ${doc.schemaVersion}`)
  const rect = doc.tree.find((n) => n && n.name === 'Probe Rect')
  if (!rect || rect.width !== 300) fail(`live node not visible to the agent: ${JSON.stringify(doc.tree)}`)
  else console.log(`MCP PASS: agent reads the live document (${doc.nodeCount} nodes, saw "${rect.name}" ${rect.width}x${rect.height})`)

  // Selection made in the app must be visible to the agent.
  await evaluate(`globalThis.__polyform.editor.set({ selection: ['probe-rect'] })`)
  await sleep(200)
  const selCall = await client.callTool({ name: 'get_selection', arguments: {} })
  const sel = JSON.parse(selCall.content[0].text)
  if (sel.count !== 1 || sel.nodes[0].name !== 'Probe Rect') fail(`selection not visible: ${JSON.stringify(sel)}`)
  else console.log('MCP PASS: agent sees the user selection')

  // --- realtime: an edit in the app appears in the change feed ------------
  const before = JSON.parse((await client.callTool({ name: 'poll_changes', arguments: { cursor: 0 } })).content[0].text)
  await evaluate(`(() => {
    const P = globalThis.__polyform
    P.documentStore.commit([{ kind: 'update', id: 'probe-rect',
      before: { width: 300 }, after: { width: 480 } }], 'Resize From Test')
    return 'ok'
  })()`)
  await sleep(300)
  const after = JSON.parse(
    (await client.callTool({ name: 'poll_changes', arguments: { cursor: before.cursor } })).content[0].text,
  )
  if (after.newEntries !== 1 || after.entries[0].label !== 'Resize From Test') {
    fail(`edit did not surface in the change feed: ${JSON.stringify(after)}`)
  } else {
    console.log(`MCP PASS: live edit visible to the agent ("${after.entries[0].label}" on ${after.entries[0].nodeIds.join(', ')})`)
  }

  await client.close()
  client = null
  const stopped = await evaluate(`window.polyform.mcpStop()`)
  if (stopped?.running) fail('server did not stop')
  else console.log('MCP PASS: server stops cleanly')

  if (process.exitCode !== 1) console.log('MCP PROBE: all checks passed')
} catch (err) {
  fail(String(err))
} finally {
  try {
    await client?.close()
  } catch {
    /* ignore */
  }
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  electron.kill()
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(electron.pid)], { stdio: 'ignore', shell: true })
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500)
}
