// E2E gates for real pointer/keyboard gestures - the class of bug no engine
// test or render fixture can see. Boots the BUILT app with CDP and drives
// actual input:
//   1. add-text: T, click, type, Escape - guards the mid-gesture focus
//      bounce that silently deleted every fresh text node (F-18).
//   2. double-click: drilling into a group - guards reading click counts
//      from PointerEvent.detail, which is always 0 and silently disabled
//      every double-click gesture in the app (F-19).
//   3. inspector scrub: dragging a value updates the canvas live and lands
//      as exactly ONE undo entry.
//
// Usage: npm run build && npm run test:e2e   (requires Node 22+)

import { spawn } from 'node:child_process'
import process from 'node:process'
import { killElectronMatching } from './proc-cleanup.mjs'

const PORT = 9333
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function fail(msg) {
  console.error(`E2E FAIL: ${msg}`)
  process.exitCode = 1
}

const electron = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', 'out/main/index.js', `--remote-debugging-port=${PORT}`],
  { cwd: ROOT, stdio: 'ignore', shell: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws
try {
  // Wait for the debugger endpoint.
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
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    return r.result?.result?.value
  }
  await new Promise((r) => (ws.onopen = r))
  await send('Runtime.enable')
  await send('Page.bringToFront')

  // Wait for the debug handle, then synthesize an open project.
  for (let i = 0; i < 40 && !(await evaluate('!!globalThis.__polyform')); i++) await sleep(250)
  if (!(await evaluate('!!globalThis.__polyform'))) throw new Error('__polyform handle missing')
  await evaluate(`globalThis.__polyform.documentStore.loadFromResult({
    info: { path: 'e2e-scratch.poly', manifest: { name: 'E2E', schemaVersion: 5 } },
    sceneBytes: null,
    journal: { entries: [], cursor: 0 },
  })`)
  await evaluate(`globalThis.__polyform.editor.set({ hasProject: true })`)
  await sleep(600)

  const { w, h } = JSON.parse(await evaluate(`JSON.stringify({ w: innerWidth, h: innerHeight })`))
  const cx = Math.round(w / 2)
  const cy = Math.round(h / 2)

  // T, click (human-timed press/release), type, Escape.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 't', code: 'KeyT', text: 't' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT' })
  await sleep(150)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
  await sleep(100)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
  await sleep(600)

  const mid = JSON.parse(await evaluate(`JSON.stringify({
    editing: globalThis.__polyform.editor.get().editingTextId,
    textarea: !!document.querySelector('textarea'),
    focused: document.activeElement?.tagName,
  })`))
  if (!mid.editing || !mid.textarea) fail(`edit session did not open: ${JSON.stringify(mid)}`)
  if (mid.focused !== 'TEXTAREA') fail(`textarea not focused (focus bounce regression): ${mid.focused}`)

  await send('Input.insertText', { text: 'Hello E2E' })
  await sleep(300)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await sleep(500)

  const done = JSON.parse(await evaluate(`JSON.stringify({
    editing: globalThis.__polyform.editor.get().editingTextId,
    texts: Object.values(globalThis.__polyform.documentStore.scene.doc.nodes)
      .filter((n) => n.type === 'TEXT').map((n) => n.characters),
    labels: (globalThis.__polyform.documentStore.history.undoStack ?? []).map((e) => e.label),
  })`))
  if (done.editing !== null) fail('edit session did not close on Escape')
  if (!done.texts.includes('Hello E2E')) fail(`text lost: nodes=${JSON.stringify(done.texts)} history=${JSON.stringify(done.labels)}`)
  if (done.labels.includes('Remove Empty Text')) fail('fresh node was deleted as empty (focus bounce regression)')

  if (process.exitCode !== 1) console.log(`E2E PASS: add-text survives (nodes=${JSON.stringify(done.texts)})`)

  // ---------------------------------------------------------------------
  // 2. Double-click drills into a group (F-19).
  // ---------------------------------------------------------------------
  await evaluate(`globalThis.__polyform.editor.set({ selection: [], enteredContainer: null, tool: 'select' })`)
  const built = JSON.parse(await evaluate(`(() => {
    const s = globalThis.__polyform.documentStore.scene
    const mk = (type, name, props) => Object.assign({
      id: 'e2e' + Math.random().toString(36).slice(2, 9), type, name,
      visible: true, locked: false, opacity: 1, blendMode: 'NORMAL',
      x: 0, y: 0, width: 100, height: 100, rotation: 0,
      fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.8, g: 0.3, b: 0.3, a: 1 } }],
      strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', strokeDash: [], effects: [] }, props)
    const grp = mk('GROUP', 'G', { x: 0, y: 0, width: 200, height: 200, children: [], fills: [], strokes: [] })
    s.addNode(grp, null, s.rootIds().length)
    const kid = mk('RECTANGLE', 'Kid', { x: 20, y: 20, width: 160, height: 160, cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 } })
    s.addNode(kid, grp.id, 0)
    const frame = mk('FRAME', 'F', { x: 300, y: 0, width: 240, height: 200, children: [], clipsContent: true,
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      layout: { mode: 'NONE', gap: 10, paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10, counterAlign: 'MIN', primarySizing: 'FIXED', counterSizing: 'FIXED' },
      fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] })
    s.addNode(frame, null, s.rootIds().length)
    // Child coordinates are parent-relative: this sits at world 340,40.
    const inFrame = mk('RECTANGLE', 'InFrame', { x: 40, y: 40, width: 120, height: 100, cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 } })
    s.addNode(inFrame, frame.id, 0)
    globalThis.__polyform.editor.set({ camera: { x: -40, y: -40, zoom: 1 } })
    globalThis.__polyform.documentStore.transient()
    return JSON.stringify({ grp: grp.id, kid: kid.id, frame: frame.id, inFrame: inFrame.id })
  })()`))
  await sleep(400)

  const toScreen = async (wx, wy) => JSON.parse(await evaluate(`(() => {
    const c = globalThis.__polyform.editor.get().camera
    const r = document.querySelector('canvas').getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + (${wx} - c.x) * c.zoom), y: Math.round(r.top + (${wy} - c.y) * c.zoom) })
  })()`))
  const clickAt = async (x, y, count) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count })
    await sleep(40)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count })
    await sleep(90)
  }
  const names = async () => JSON.parse(await evaluate(`JSON.stringify({
    sel: globalThis.__polyform.editor.get().selection.map(i => globalThis.__polyform.documentStore.scene.getNode(i)?.name),
    entered: globalThis.__polyform.documentStore.scene.getNode(globalThis.__polyform.editor.get().enteredContainer || '')?.name ?? null,
  })`))

  const gp = await toScreen(100, 100)
  await clickAt(gp.x, gp.y, 1)
  await sleep(250)
  const singleSel = await names()
  if (singleSel.sel[0] !== 'G') fail(`single click inside a group should select the group, got ${JSON.stringify(singleSel)}`)

  await clickAt(gp.x, gp.y, 1)
  await clickAt(gp.x, gp.y, 2)
  await sleep(350)
  const drilled = await names()
  if (drilled.entered !== 'G' || drilled.sel[0] !== 'Kid') {
    fail(`double-click did not drill into the group (F-19 regression): ${JSON.stringify(drilled)}`)
  } else {
    console.log('E2E PASS: double-click drills into a group')
  }

  // Frame contents are clicked directly (frames are not selection units).
  await evaluate(`globalThis.__polyform.editor.set({ selection: [], enteredContainer: null })`)
  await sleep(200)
  const fp = await toScreen(400, 90)
  await clickAt(fp.x, fp.y, 1)
  await sleep(300)
  const inFrameSel = await names()
  if (inFrameSel.sel[0] !== 'InFrame') {
    fail(`clicking a frame child should select the child, got ${JSON.stringify(inFrameSel)}`)
  } else {
    console.log('E2E PASS: frame children are directly selectable')
  }

  // ---------------------------------------------------------------------
  // 3. Inspector scrub: live canvas update, exactly one undo entry.
  // ---------------------------------------------------------------------
  await evaluate(`globalThis.__polyform.editor.set({ selection: ['${built.inFrame}'] })`)
  await sleep(350)
  const label = JSON.parse(await evaluate(`(() => {
    const sp = [...document.querySelectorAll('[data-scrub]')].filter(e => e.textContent === 'X')[0]
    if (!sp) return 'null'
    const r = sp.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`))
  if (!label) {
    fail('inspector X scrub handle not found')
  } else {
    const histBefore = await evaluate(`globalThis.__polyform.documentStore.history.undoStack.length`)
    const startX = await evaluate(`globalThis.__polyform.documentStore.scene.getNode('${built.inFrame}').x`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: label.x, y: label.y, button: 'left', clickCount: 1 })
    const live = []
    for (let i = 1; i <= 3; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: label.x + i * 12, y: label.y, button: 'left', buttons: 1 })
      await sleep(120)
      live.push(await evaluate(`globalThis.__polyform.documentStore.scene.getNode('${built.inFrame}').x`))
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: label.x + 36, y: label.y, button: 'left', clickCount: 1 })
    await sleep(350)
    const histAfter = await evaluate(`globalThis.__polyform.documentStore.history.undoStack.length`)
    const moved = live.filter((v) => v !== startX).length
    if (moved < 2) fail(`inspector scrub did not update the canvas live: start=${startX} samples=${JSON.stringify(live)}`)
    if (histAfter - histBefore !== 1) fail(`inspector scrub made ${histAfter - histBefore} history entries, expected 1`)
    await evaluate(`globalThis.__polyform.documentStore.undo()`)
    await sleep(250)
    const undone = await evaluate(`globalThis.__polyform.documentStore.scene.getNode('${built.inFrame}').x`)
    if (undone !== startX) fail(`one undo should restore x=${startX}, got ${undone}`)
    if (process.exitCode !== 1) console.log('E2E PASS: inspector scrub is live and undoes in one step')
  }

  // ---------------------------------------------------------------------
  // 4. Leaving vector edit must leave the transform box ON the shape.
  //
  // Exiting re-anchors the path to its own bounding box and moves the node to
  // compensate. Writing node.x directly skipped the scene's cache
  // invalidation, so the box kept drawing at the pre-edit position with the
  // post-edit size until something else happened to bump the scene. No unit
  // test can see this: it needs a live overlay reading a live cache.
  // ---------------------------------------------------------------------
  await evaluate(`(() => {
    const P = globalThis.__polyform
    const s = P.documentStore.scene
    const base = { visible: true, locked: false, opacity: 1, blendMode: 'NORMAL', rotation: 0,
      strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', strokeDash: [], effects: [] }
    s.addNode({ ...base, id: 'e2e-vec', type: 'VECTOR', name: 'E2E Path', x: 300, y: 300,
      width: 200, height: 200, windingRule: 'NONZERO',
      fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.8, g: 0.8, b: 0.8, a: 1 } }],
      network: { vertices: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 200, y: 0 }, { id: 3, x: 200, y: 200 }],
        edges: [{ id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
                { id: 2, v0: 2, v1: 3, cp0: null, cp1: null },
                { id: 3, v0: 3, v1: 1, cp0: null, cp1: null }] } }, null, 0)
    P.documentStore.transient()
    // Drag a point out past the node's origin, so exiting has to re-anchor.
    P.interactionController.enterVectorEdit('e2e-vec')
    const n = s.getNode('e2e-vec')
    const before = structuredClone(n.network)
    const v = n.network.vertices.find((x) => x.id === 1)
    v.x -= 90
    v.y -= 60
    s.bump()
    P.documentStore.commit([{ kind: 'update', id: 'e2e-vec', before: { network: before },
      after: { network: structuredClone(n.network) } }], 'Edit Vector', true)
    P.editor.set({ selection: ['e2e-vec'] })
    return 'edited'
  })()`)
  // Let frames render with the path still open. This is the part that matters:
  // the stale value only exists if something CACHED the world matrix before the
  // exit re-anchored the node. Doing the whole thing in one synchronous call
  // populates the cache after the fact and passes either way.
  await sleep(400)
  const boxCheck = JSON.parse(await evaluate(`(() => {
    const P = globalThis.__polyform
    const s = P.documentStore.scene
    P.interactionController.exitVectorEdit(true)
    // Where the overlay would draw the box, against where the node now is.
    const cam = P.editor.get().camera
    const corners = P.overlays.selectionScreenBox(s, ['e2e-vec'], cam)
    const node = s.getNode('e2e-vec')
    const toWorld = (p) => ({ x: cam.x + p.x / cam.zoom, y: cam.y + p.y / cam.zoom })
    const tl = toWorld(corners[0])
    return JSON.stringify({
      offBy: Math.round(Math.hypot(tl.x - node.x, tl.y - node.y)),
      drawn: [Math.round(tl.x), Math.round(tl.y)],
      real: [Math.round(node.x), Math.round(node.y)],
    })
  })()`))
  if (boxCheck.offBy > 1) {
    fail(`transform box is stale after leaving vector edit: drawn at ${boxCheck.drawn}, shape at ${boxCheck.real} (off by ${boxCheck.offBy})`)
  } else {
    console.log('E2E PASS: the transform box follows the shape out of vector edit')
  }

} catch (err) {
  fail(String(err))
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  electron.kill()
  // Windows: the pid we hold is a shell wrapper that may already be gone, so
  // also sweep by identity or the instance outlives the gate.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(electron.pid)], { stdio: 'ignore', shell: true })
  }
  killElectronMatching(`--remote-debugging-port=${PORT}`)
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500)
}
