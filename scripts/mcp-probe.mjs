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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { inflateSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { killElectronMatching } from './proc-cleanup.mjs'

/**
 * Minimal PNG reader, so the image gates can check what is actually IN the
 * picture. A signature check would happily pass a blank canvas — which is
 * exactly how a broken render escapes notice.
 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced PNG not supported')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`unsupported colour type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  const hex = (x, y) => {
    const i = y * stride + x * channels
    return `#${out.subarray(i, i + 3).toString('hex').toUpperCase()}`
  }
  const colors = new Set()
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) colors.add(hex(x, y))
  return { width, height, hex, colors }
}

const PORT = 9351
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(msg) {
  console.error(`MCP FAIL: ${msg}`)
  process.exitCode = 1
}

// A leftover Electron from an earlier run keeps the CDP port, and this
// probe would then happily drive THAT app — reporting results for stale
// code. It burned an hour once: a fixed bug still "failed" because the
// zombie predated the fix. Refuse to run rather than lie either way.
try {
  const live = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
    signal: AbortSignal.timeout(1500),
  })
  if (live.ok) {
    console.error(
      `MCP FAIL: something is already listening on the debug port ${PORT} — ` +
        `a stale Electron from an earlier run. Close it first ` +
        `(the probe would otherwise test that app, not this build).`,
    )
    process.exit(1)
  }
} catch {
  /* nothing there: good */
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

  // A REAL bundle on disk (harness hook), so asset writes hit the true
  // pipeline; then shape the scene in-memory as before.
  const bundleDir = path.join(os.tmpdir(), `polyform-mcp-probe-${Date.now()}`, 'Probe.poly')
  const createdReal = await evaluate(
    `window.__polyformTest.projectCreate(${JSON.stringify(bundleDir.replace(/\\/g, '/'))})
       .then((r) => { globalThis.__polyform.documentStore.loadFromResult(r); return r.info.manifest.title })`,
  )
  if (createdReal !== 'Probe') throw new Error(`test project not created: ${JSON.stringify(createdReal)}`)
  await evaluate(`globalThis.__polyform.editor.set({ hasProject: true })`)
  await evaluate(`(() => {
    const s = globalThis.__polyform.documentStore.scene
    const solid = (r, g, b) => ({ type: 'SOLID', visible: true, opacity: 1, color: { r, g, b, a: 1 } })
    // A shared colour style, used by the rect — exercises the style inventory.
    s.doc.styles.colors.push({ id: 'style-brand', name: 'Brand/Primary', paint: solid(0.2, 0.5, 1) })
    const n = { id: 'probe-rect', type: 'RECTANGLE', name: 'Probe Rect',
      visible: true, locked: false, opacity: 1, blendMode: 'NORMAL',
      x: 10, y: 20, width: 300, height: 200, rotation: 0,
      fills: [solid(0.2, 0.5, 1)], strokes: [solid(1, 1, 1)], strokeWeight: 2,
      strokeAlign: 'INSIDE', strokeDash: [], styleRefs: { fill: 'style-brand' },
      effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 },
        offset: { x: 0, y: 4 }, blur: 8 }],
      cornerRadius: { tl: 8, tr: 8, br: 8, bl: 8 } }
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
  for (const want of [
    'get_document',
    'get_node',
    'get_selection',
    'get_view_image',
    'get_node_image',
    'poll_changes',
  ]) {
    if (!names.includes(want)) fail(`missing tool ${want}`)
  }

  const docCall = await client.callTool({ name: 'get_document', arguments: {} })
  const doc = JSON.parse(docCall.content[0].text)
  if (doc.project !== 'Probe') fail(`expected the live project title, got ${JSON.stringify(doc.project)}`)
  if (doc.schemaVersion !== 5) fail(`expected schemaVersion 5, got ${doc.schemaVersion}`)
  const rect = doc.tree.find((n) => n && n.name === 'Probe Rect')
  if (!rect || rect.width !== 300) fail(`live node not visible to the agent: ${JSON.stringify(doc.tree)}`)
  else console.log(`MCP PASS: agent reads the live document (${doc.nodeCount} nodes, saw "${rect.name}" ${rect.width}x${rect.height})`)

  // --- styles and components are inventoried, with usage counts ----------
  const brand = doc.styles?.colors?.find((s) => s.name === 'Brand/Primary')
  if (!brand) fail(`shared styles missing from the summary: ${JSON.stringify(doc.styles)}`)
  else if (brand.usedBy !== 1 || brand.value !== '#3380FF') {
    fail(`style inventory wrong: ${JSON.stringify(brand)}`)
  } else {
    console.log(`MCP PASS: shared styles inventoried ("${brand.name}" ${brand.value}, usedBy ${brand.usedBy})`)
  }
  if (!Array.isArray(doc.components)) fail('component inventory missing from the summary')
  else console.log(`MCP PASS: component inventory present (${doc.components.length} main components)`)

  // --- get_node returns what the layer actually LOOKS like ---------------
  const detail = JSON.parse(
    (await client.callTool({ name: 'get_node', arguments: { id: 'probe-rect' } })).content[0].text,
  ).node
  const problems = []
  if (detail.fills?.[0]?.color !== '#3380FF') problems.push(`fill ${JSON.stringify(detail.fills)}`)
  if (detail.strokeWeight !== 2) problems.push(`strokeWeight ${detail.strokeWeight}`)
  if (detail.cornerRadius !== 8) problems.push(`cornerRadius ${JSON.stringify(detail.cornerRadius)}`)
  if (detail.effects?.[0]?.type !== 'DROP_SHADOW') problems.push(`effects ${JSON.stringify(detail.effects)}`)
  if (detail.styles?.fill !== 'Brand/Primary') problems.push(`styles ${JSON.stringify(detail.styles)}`)
  if (problems.length > 0) fail(`get_node detail wrong: ${problems.join('; ')}`)
  else console.log('MCP PASS: get_node reports fills, strokes, radius, effects and style names')

  const missing = await client.callTool({ name: 'get_node', arguments: { id: 'nope' } })
  if (!missing.isError) fail('get_node accepted an unknown id')
  else console.log('MCP PASS: get_node rejects an unknown id')

  // --- the agent can SEE the canvas, within the token budget -------------
  for (const [tool, args] of [
    ['get_view_image', {}],
    ['get_node_image', { id: 'probe-rect' }],
  ]) {
    const shot = await client.callTool({ name: tool, arguments: args })
    const image = shot.content.find((c) => c.type === 'image')
    const meta = JSON.parse(shot.content.find((c) => c.type === 'text').text)
    if (!image) {
      fail(`${tool} returned no image block: ${JSON.stringify(shot.content.map((c) => c.type))}`)
      continue
    }
    if (image.mimeType !== 'image/png' || !image.data.startsWith('iVBORw0KGgo')) {
      fail(`${tool} did not return PNG bytes (${image.mimeType})`)
      continue
    }
    // Budget: a client charges about (w x h)/750 tokens for an image.
    const tokens = Math.round((meta.width * meta.height) / 750)
    if (Math.max(meta.width, meta.height) > 1568) {
      fail(`${tool} exceeded the 1568px edge cap (${meta.width}x${meta.height})`)
    } else if (tokens > 6000) {
      fail(`${tool} image would cost ~${tokens} tokens — over budget`)
    } else {
      console.log(
        `MCP PASS: ${tool} → ${meta.width}x${meta.height} PNG, ` +
          `${Math.round((image.data.length * 3) / 4 / 1024)}kB, ~${tokens} image tokens, scale ${meta.scale}`,
      )
    }

    // The picture must actually show the design, not an empty canvas.
    const png = decodePng(Buffer.from(image.data, 'base64'))
    if (png.width !== meta.width || png.height !== meta.height) {
      fail(`${tool}: reported ${meta.width}x${meta.height} but the PNG is ${png.width}x${png.height}`)
    } else if (!png.colors.has('#3380FF')) {
      fail(
        `${tool}: the rendered image does not contain the rectangle's colour ` +
          `(saw ${[...png.colors].slice(0, 4).join(', ')})`,
      )
    } else if (png.colors.size < 2) {
      fail(`${tool}: the image is a single flat colour — nothing was drawn`)
    } else {
      console.log(`MCP PASS: ${tool} really shows the design (${png.colors.size} distinct colours, brand fill present)`)
    }
  }

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

  // --- writes (7.3): OFF by default, one entry when granted ---------------
  if (names.includes('edit_document')) {
    fail('edit_document is listed while the edit grant is off — writes must default OFF')
  } else {
    console.log('MCP PASS: write tool hidden while the edit grant is off (default)')
  }
  let refusedWrite = false
  try {
    const r = await client.callTool({
      name: 'edit_document',
      arguments: { label: 'Sneaky', edits: [{ op: 'create', type: 'RECTANGLE' }] },
    })
    refusedWrite = r.isError === true
  } catch {
    refusedWrite = true
  }
  if (!refusedWrite) fail('an ungranted write was accepted')
  else console.log('MCP PASS: ungranted write refused')

  // Grant writes the way a user would — the panel checkbox.
  const grantEdit = await evaluate(`(() => {
    globalThis.__polyform.editor.set({ showAgent: true })
    return true
  })()`)
  if (!grantEdit) throw new Error('could not open the consent panel for the write grant')
  await sleep(400)
  const editToggled = await evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((l) => l.innerText.includes('edit_document'))
    const box = label && label.querySelector('input[type=checkbox]')
    if (!box || box.checked) return false
    box.click()
    return true
  })()`)
  if (!editToggled) fail('could not find the edit consent checkbox')
  await sleep(500)

  const entriesBefore = await evaluate(
    `globalThis.__polyform.documentStore.history.entriesApplied().length`,
  )
  const written = await client.callTool({
    name: 'edit_document',
    arguments: {
      label: 'Test composition',
      edits: [
        {
          op: 'create',
          type: 'FRAME',
          ref: 'bg',
          props: { name: 'Agent Frame', x: 500, y: 500, width: 200, height: 150, fill: '#222831' },
        },
        {
          op: 'create',
          type: 'ELLIPSE',
          parentId: '$bg',
          index: 0,
          props: { name: 'Glow', x: 20, y: 15, width: 80, height: 80, fill: '#76ABAE55' },
        },
        {
          op: 'create',
          type: 'RECTANGLE',
          parentId: '$bg',
          ref: 'bar',
          props: { name: 'Bar', x: 110, y: 90, width: 70, height: 12, fill: '#EEEEEE', cornerRadius: 6 },
        },
        { op: 'update', id: '$bar', props: { opacity: 0.8, rotation: -8 } },
        {
          op: 'create',
          type: 'TEXT',
          parentId: '$bg',
          ref: 'cap',
          props: { name: 'Cap', x: 0, y: 120, width: 200, height: 24, characters: 'hi', fontSize: 16, autoResize: 'NONE' },
        },
      ],
    },
  })
  if (written.isError) {
    fail(`granted write failed: ${written.content.map((c) => c.text).join(' ')}`)
  } else {
    const result = JSON.parse(written.content.find((c) => c.type === 'text').text)
    if (result.committed !== 'Agent: Test composition' || !result.created.bg?.id) {
      fail(`write result malformed: ${JSON.stringify(result)}`)
    } else {
      console.log(`MCP PASS: granted write landed ("${result.committed}", ${result.edits} edits)`)
    }
  }

  const entriesAfter = await evaluate(
    `globalThis.__polyform.documentStore.history.entriesApplied().length`,
  )
  if (entriesAfter !== entriesBefore + 1) {
    fail(`a 5-edit batch made ${entriesAfter - entriesBefore} journal entries — must be exactly 1`)
  } else {
    console.log('MCP PASS: a whole batch is ONE journal entry')
  }

  // autoResize: NONE must keep the box the agent set (the centring lesson).
  const capWidth = await evaluate(`(() => {
    const s = globalThis.__polyform.documentStore.scene
    const frame = [...Object.values(s.doc.nodes)].find((n) => n.name === 'Agent Frame')
    const cap = frame && frame.children.map((c) => s.getNode(c)).find((n) => n && n.name === 'Cap')
    return cap ? cap.width : null
  })()`)
  if (capWidth !== 200) fail(`autoResize NONE did not hold the box (width ${capWidth}, wanted 200)`)
  else console.log('MCP PASS: autoResize NONE keeps the agent-set text box')
  const topLabel = await evaluate(`globalThis.__polyform.documentStore.history.peekUndoLabel()`)
  if (topLabel !== 'Agent: Test composition') fail(`entry not agent-attributed: ${JSON.stringify(topLabel)}`)
  else console.log('MCP PASS: entry attributed in history ("Agent: …")')

  // The nodes must actually exist, parented and z-ordered as asked.
  const madeState = await evaluate(`(() => {
    const s = globalThis.__polyform.documentStore.scene
    const frame = [...Object.values(s.doc.nodes)].find((n) => n.name === 'Agent Frame')
    if (!frame) return null
    return { children: frame.children.map((c) => s.getNode(c)?.name), w: frame.width }
  })()`)
  if (!madeState || madeState.children.join(',') !== 'Glow,Bar,Cap') {
    fail(`created structure wrong: ${JSON.stringify(madeState)}`)
  } else {
    console.log(`MCP PASS: nodes exist, parented and z-ordered (${madeState.children.join(' → ')})`)
  }

  // One Ctrl+Z removes the whole composition; redo restores it.
  const undone = await evaluate(`(() => {
    globalThis.__polyform.documentStore.undo()
    const s = globalThis.__polyform.documentStore.scene
    return ![...Object.values(s.doc.nodes)].some((n) => n.name === 'Agent Frame')
  })()`)
  if (!undone) fail('one undo did not remove the whole agent batch')
  else console.log('MCP PASS: one undo removes the whole composition')
  const redone = await evaluate(`(() => {
    globalThis.__polyform.documentStore.redo()
    const s = globalThis.__polyform.documentStore.scene
    return [...Object.values(s.doc.nodes)].some((n) => n.name === 'Agent Frame')
  })()`)
  if (!redone) fail('redo did not restore the agent batch')
  else console.log('MCP PASS: redo restores it')

  // Atomicity: a batch with a bad op must land NOTHING.
  const nodesBeforeBad = await evaluate(
    `Object.keys(globalThis.__polyform.documentStore.scene.doc.nodes).length`,
  )
  const bad = await client.callTool({
    name: 'edit_document',
    arguments: {
      label: 'Half legal',
      edits: [
        { op: 'create', type: 'RECTANGLE', props: { x: 0, y: 0, width: 10, height: 10 } },
        { op: 'delete', id: 'does-not-exist' },
      ],
    },
  })
  const nodesAfterBad = await evaluate(
    `Object.keys(globalThis.__polyform.documentStore.scene.doc.nodes).length`,
  )
  if (!bad.isError) fail('a batch with an invalid op reported success')
  else if (nodesAfterBad !== nodesBeforeBad) {
    fail(`failed batch leaked ${nodesAfterBad - nodesBeforeBad} node(s) — not atomic`)
  } else {
    console.log('MCP PASS: failed batch lands nothing (atomic)')
  }

  // The agent's own commit shows up in the change feed like any edit.
  const feed = JSON.parse(
    (await client.callTool({ name: 'poll_changes', arguments: { cursor: 0 } })).content[0].text,
  )
  if (!feed.entries.some((e) => e.label === 'Agent: Test composition')) {
    fail('agent commit missing from the change feed')
  } else {
    console.log('MCP PASS: agent commit visible in the change feed')
  }

  // --- image import: bytes in, pixels on the canvas -----------------------
  // A 6x6 solid #FF4E00 PNG, generated once and inlined.
  const ORANGE_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAGCAIAAABvrngfAAAAEklEQVR4nGP478eAhtD5VBYCAJIYLtV/nwpmAAAAAElFTkSuQmCC'
  const imported = await client.callTool({
    name: 'import_image',
    arguments: { ext: 'png', base64: ORANGE_PNG },
  })
  if (imported.isError) {
    fail(`import_image failed: ${imported.content.map((c) => c.text).join(' ')}`)
  } else {
    const asset = JSON.parse(imported.content.find((c) => c.type === 'text').text)
    if (!/^[0-9a-f]{64}$/.test(asset.assetHash) || asset.width !== 6 || asset.height !== 6) {
      fail(`import_image result malformed: ${JSON.stringify(asset)}`)
    } else {
      console.log(`MCP PASS: import_image stored the asset (${asset.width}x${asset.height}, ${asset.assetHash.slice(0, 8)}…)`)
    }
    const placed = await client.callTool({
      name: 'edit_document',
      arguments: {
        label: 'Place imported image',
        edits: [
          {
            op: 'create',
            type: 'RECTANGLE',
            ref: 'img',
            props: { name: 'Imported', x: 900, y: 40, width: 120, height: 120, fill: { image: asset.assetHash, scaleMode: 'FILL' } },
          },
        ],
      },
    })
    if (placed.isError) {
      fail(`placing the imported image failed: ${placed.content.map((c) => c.text).join(' ')}`)
    } else {
      const imgId = JSON.parse(placed.content.find((c) => c.type === 'text').text).created.img.id
      const shot = await client.callTool({ name: 'get_node_image', arguments: { id: imgId } })
      const png = decodePng(Buffer.from(shot.content.find((c) => c.type === 'image').data, 'base64'))
      if (!png.colors.has('#FF4E00')) {
        fail(`imported image does not render (saw ${[...png.colors].slice(0, 4).join(', ')})`)
      } else {
        console.log('MCP PASS: imported image renders — bytes became canvas pixels')
      }

      // Background removal: on a machine with the model this runs a real
      // ~5s inference; on one without it must refuse with instructions,
      // never pop a dialog. Both are correct — assert whichever applies.
      const cut = await client.callTool({
        name: 'remove_background',
        arguments: { id: imgId },
      })
      if (cut.isError) {
        const msg = cut.content.map((c) => c.text).join(' ')
        if (!/model is not downloaded/i.test(msg)) fail(`remove_background failed wrong: ${msg}`)
        else console.log('MCP PASS: remove_background refuses cleanly without the model (no dialog)')
      } else {
        const res = JSON.parse(cut.content.find((c) => c.type === 'text').text)
        if (res.committed !== 'Agent: Remove Background' || !res.originalAssetHash) {
          fail(`remove_background result malformed: ${JSON.stringify(res)}`)
        } else {
          console.log('MCP PASS: remove_background ran on-device and committed attributed')
        }
      }
    }
  }
  const badImport = await client.callTool({
    name: 'import_image',
    arguments: { ext: 'png', base64: 'bm90IGFuIGltYWdl' },
  })
  if (!badImport.isError) fail('import_image accepted non-image bytes')
  else console.log('MCP PASS: import_image rejects non-image bytes')

  // Revoke writes again; reads must keep working.
  await evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((l) => l.innerText.includes('edit_document'))
    const box = label && label.querySelector('input[type=checkbox]')
    if (box && box.checked) box.click()
    return true
  })()`)
  await sleep(400)
  let writeRevoked = false
  try {
    const r = await client.callTool({
      name: 'edit_document',
      arguments: { label: 'After revoke', edits: [{ op: 'create', type: 'RECTANGLE' }] },
    })
    writeRevoked = r.isError === true
  } catch {
    writeRevoked = true
  }
  if (!writeRevoked) fail('write still accepted after the grant was revoked')
  else console.log('MCP PASS: write refused after revoke; endpoint back to read-only')

  // --- a client must be able to reconnect, and two may attach ------------
  // A StreamableHTTPServerTransport binds to ONE session for life, so a
  // single shared transport silently caps the endpoint at one connection
  // ever — and a client that reconnects (Claude Code does, with backoff)
  // gets "Server already initialized" until the user restarts the endpoint.
  const connect = async (name) => {
    const c = new Client({ name, version: '1.0.0' })
    const t = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${status.token}` } },
    })
    await c.connect(t)
    // close() only tears down the client side; DELETE is what tells the
    // server the session is over, and it is what keeps the indicator's
    // count honest.
    return { client: c, bye: async () => { await t.terminateSession(); await c.close() } }
  }

  const second = await connect('polyform-probe-2')
  const secondDoc = JSON.parse(
    (await second.client.callTool({ name: 'get_document', arguments: {} })).content[0].text,
  )
  if (secondDoc.project !== 'Probe') fail('a second concurrent agent could not read the document')
  else console.log('MCP PASS: a second agent attaches concurrently and reads')

  const bothCounted = await evaluate(`globalThis.__polyformAgentStatus().clients`)
  if (bothCounted !== 2) fail(`status should count 2 sessions, got ${bothCounted}`)
  else console.log('MCP PASS: both sessions counted in status')

  await second.bye()
  await sleep(400)
  const afterBye = await evaluate(`globalThis.__polyformAgentStatus().clients`)
  if (afterBye !== 1) fail(`a departed agent is still counted: ${afterBye} sessions`)
  else console.log('MCP PASS: a departing agent stops being counted')

  // Reconnect from scratch — the case that was broken.
  const again = await connect('polyform-probe-again')
  const againDoc = JSON.parse(
    (await again.client.callTool({ name: 'get_document', arguments: {} })).content[0].text,
  )
  if (againDoc.project !== 'Probe') fail('a reconnecting client could not read the document')
  else console.log('MCP PASS: a client can disconnect and reconnect')
  await again.bye()
  await sleep(400)

  // A stale session id must be told to re-initialize, not silently served.
  const stale = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${status.token}`,
      'mcp-session-id': 'session-that-never-existed',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  if (stale.status !== 404) fail(`unknown session id should be 404, got ${stale.status}`)
  else console.log('MCP PASS: unknown session id is rejected 404')

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
    // The shell wrapper is often already gone; sweep this run by identity too.
    killElectronMatching(`--remote-debugging-port=${PORT}`)
  }
  setTimeout(() => {
    // Remove the temp bundles the harness hook created (this run's and any
    // a crashed earlier run left behind).
    for (const d of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('polyform-mcp-probe-'))) {
      try {
        fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true })
      } catch {
        /* a live handle on Windows — the next run sweeps it */
      }
    }
    process.exit(process.exitCode ?? 0)
  }, 1500)
}
