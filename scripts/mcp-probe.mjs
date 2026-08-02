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
  {
    cwd: ROOT,
    stdio: 'ignore',
    shell: true,
    // POLYFORM_AGENT_TEST exposes a read-only status peek; the control
    // surface itself stays unreachable, which is checked below.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, POLYFORM_AGENT_TEST: '1' },
  },
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

  // --- consent: the endpoint starts from the panel, not from an API -------
  // Nothing in the renderer's shared surface may open a listener; only the
  // startup-claimed control handle can, and the user drives it (F-15/F-20).
  const contained = await evaluate(`(() => {
    // Exactly how the plugin runner executes an untrusted script (3.4).
    const body = "return (window.polyform.mcpStart ? 'reachable' : 'blocked')"
      + " + '/' + ((window.polyformAgent && window.polyformAgent.claim()) ? 'claimable' : 'claimed')"
    try { return new Function('polyform', "'use strict';" + body)({}) }
    catch (e) { return 'threw: ' + e.message }
  })()`)
  if (contained !== 'blocked/claimed') {
    fail(`a plugin-shaped script can still reach the endpoint controls: ${contained}`)
  } else {
    console.log('MCP PASS: endpoint controls unreachable from plugin-realm code')
  }

  const started = await evaluate(`(() => {
    globalThis.__polyform.editor.set({ showAgent: true })
    return true
  })()`)
  if (!started) throw new Error('could not open the consent panel')
  await sleep(400)
  const clickedStart = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Start endpoint')
    if (!b) return false
    b.click()
    return true
  })()`)
  if (!clickedStart) throw new Error('no "Start endpoint" button in the consent panel')
  await sleep(800)
  console.log('MCP PASS: endpoint started from the consent panel')

  const status = await evaluate(`globalThis.__polyformAgentStatus()`)
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

  // --- the app must SHOW that an agent is attached (7.2, F-20) ------------
  const live = await evaluate(`globalThis.__polyformAgentStatus()`)
  if (live?.clients !== 1) fail(`status should report 1 connected session, got ${live?.clients}`)
  else console.log('MCP PASS: connected session counted in status')
  if (!(live.calls > 0) || live.lastCall === null) fail(`reads not recorded: ${JSON.stringify(live)}`)
  else console.log(`MCP PASS: read activity recorded (${live.calls} calls, last "${live.lastCall}")`)

  const indicator = await evaluate(`(() => {
    globalThis.__polyform.editor.set({ showAgent: false })
    const b = document.querySelector('button[title^="Agent connection"]')
    return b ? b.innerText : null
  })()`)
  if (!indicator) fail('no "agent connected" indicator is visible in the running app')
  else console.log(`MCP PASS: indicator visible in the app UI ("${indicator.trim()}")`)

  // --- consent: revoking a capability takes effect on a LIVE session ------
  // Driven through the panel's checkbox, the way a user would revoke it.
  const revoked = await evaluate(`(() => {
    globalThis.__polyform.editor.set({ showAgent: true })
    return true
  })()`)
  if (!revoked) throw new Error('could not reopen the consent panel')
  await sleep(400)
  const toggled = await evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((l) => l.innerText.includes('get_selection'))
    const box = label && label.querySelector('input[type=checkbox]')
    if (!box || !box.checked) return false
    box.click()
    return true
  })()`)
  if (!toggled) fail('could not find the get_selection consent checkbox')
  await sleep(500)
  const afterRevoke = (await client.listTools()).tools.map((t) => t.name).sort()
  if (afterRevoke.includes('get_selection')) {
    fail(`revoked tool still listed: ${JSON.stringify(afterRevoke)}`)
  } else {
    console.log(`MCP PASS: revoked capability disappears from tools/list (${JSON.stringify(afterRevoke)})`)
  }

  // ...and a client holding a stale tool list is still refused.
  let refusedOk = false
  try {
    const refused = await client.callTool({ name: 'get_selection', arguments: {} })
    refusedOk = refused.isError === true
  } catch {
    refusedOk = true // the SDK rejects unknown/disabled tools outright
  }
  if (!refusedOk) fail('a revoked capability still answered a direct call')
  else console.log('MCP PASS: revoked capability refuses a direct call')

  // Revocation is per capability, not a blanket off switch.
  const stillReads = await client.callTool({ name: 'get_document', arguments: {} })
  if (JSON.parse(stillReads.content[0].text).project !== 'Probe') {
    fail('revoking one capability broke another')
  } else {
    console.log('MCP PASS: other capabilities keep working')
  }

  const retoggled = await evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((l) => l.innerText.includes('get_selection'))
    const box = label && label.querySelector('input[type=checkbox]')
    if (!box || box.checked) return false
    box.click()
    return true
  })()`)
  if (!retoggled) fail('could not re-grant through the consent panel')
  await sleep(500)
  const regranted = await client.callTool({ name: 'get_selection', arguments: {} })
  if (JSON.parse(regranted.content[0].text).count !== 1) fail('re-granting did not restore the tool')
  else console.log('MCP PASS: re-granting restores the capability live')

  // Cutting off an agent that is STILL ATTACHED is the case that matters —
  // a keep-alive socket must not be able to hold the port open.
  const stopMs = await evaluate(`(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Stop')
    if (!b) return -1
    const t0 = performance.now()
    b.click()
    for (let i = 0; i < 100; i++) {
      if (!globalThis.__polyformAgentStatus().running) return performance.now() - t0
      await new Promise((r) => setTimeout(r, 50))
    }
    return -2
  })()`)
  if (stopMs === -1) fail('no Stop button in the consent panel')
  else if (stopMs < 0) fail('endpoint did not stop while an agent was attached (held open by its socket)')
  else if (stopMs > 2000) fail(`stop took ${Math.round(stopMs)}ms with an agent attached — not "immediately"`)
  else console.log(`MCP PASS: stops with an agent still attached (${Math.round(stopMs)}ms)`)

  // ...and the port really is closed, not just marked stopped.
  let refusedAfterStop = false
  try {
    await fetch(`http://127.0.0.1:${status.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${status.token}` },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    refusedAfterStop = true
  }
  if (!refusedAfterStop) fail('the port still accepts connections after Stop')
  else console.log('MCP PASS: port refuses connections after Stop')

  try {
    await client.close()
  } catch {
    /* the socket is already gone — that is the point */
  }
  client = null

  const goneFromUi = await evaluate(`(() => {
    globalThis.__polyform.editor.set({ showAgent: false })
    return !document.querySelector('button[title^="Agent connection"]')
  })()`)
  if (!goneFromUi) fail('indicator still shown after the endpoint stopped')
  else console.log('MCP PASS: indicator disappears once the endpoint is off')

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
