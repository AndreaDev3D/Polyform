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
//   4. leaving vector edit leaves the transform box ON the shape (F-21).
//   5. hovering a handle changes the cursor, and dragging the rotate knob
//      turns the shape - the cursor was written only on repaint, so hovering
//      a handle often changed nothing at all (F-23).
//   6. typing a value into the inspector is ONE undo step, and Escape
//      discards it - Enter committed, then the blur it caused committed the
//      same value again.
//   7. the dropdown carries a caret and opens OUR menu, keys typed into it do
//      not leak to the global shortcuts, and picking applies exactly once -
//      Chromium's native popup is unstyleable and does not appear in the
//      screenshots this gate takes.
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

  // ---------------------------------------------------------------------
  // 5. Hovering a handle changes the cursor.
  //
  // The cursor is derived from the pointer position, but it used to be written
  // only inside the repaint branch — and moving onto a handle changes nothing
  // the store knows about, so it often produced no repaint and no cursor
  // change. Rotating in particular felt like guesswork. Only a live pointer
  // over a live overlay can see this: the geometry unit tests all passed.
  // ---------------------------------------------------------------------
  await evaluate(`(() => {
    const P = globalThis.__polyform
    P.editor.set({ selection: [], vectorEditId: null, tool: 'select', showRulers: false,
      camera: { x: 0, y: 0, zoom: 1 } })
    const s = P.documentStore.scene
    s.addNode({ id: 'e2e-rot', type: 'RECTANGLE', name: 'E2E Rot', visible: true, locked: false,
      opacity: 1, blendMode: 'NORMAL', x: 100, y: 100, width: 200, height: 100, rotation: 0,
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.5, g: 0.4, b: 0.4, a: 1 } }],
      strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', strokeDash: [], effects: [] }, null, 0)
    P.documentStore.transient()
    P.editor.set({ selection: ['e2e-rot'] })
    return 'built'
  })()`)
  await sleep(450)
  // Ask the app where its own handles are rather than deriving them here: a
  // gate that recomputes geometry can disagree with the app about the camera,
  // the selection or the canvas offset, and then fails for its own reasons.
  const handles = JSON.parse(await evaluate(`(() => {
    const P = globalThis.__polyform
    const st = P.editor.get()
    const box = P.overlays.selectionScreenBox(P.documentStore.scene, st.selection, st.camera)
    if (!box) return 'null'
    const r = document.querySelector('canvas').getBoundingClientRect()
    const hs = P.overlays.boxHandles(box, P.overlays.canRotate(P.documentStore.scene, st.selection))
    const out = {}
    for (const h of hs) out[h.kind] = { x: Math.round(r.left + h.x), y: Math.round(r.top + h.y) }
    const c = { x: (box[0].x + box[2].x) / 2, y: (box[0].y + box[2].y) / 2 }
    out.centre = { x: Math.round(r.left + c.x), y: Math.round(r.top + c.y) }
    out.empty = { x: Math.round(r.left + box[2].x + 220), y: Math.round(r.top + box[2].y + 160) }
    return JSON.stringify(out)
  })()`))
  if (!handles || !handles.rotate) throw new Error('no rotate knob in the selection handles')
  const readCursor = async (p) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await sleep(220)
    return await evaluate(`(document.querySelector('canvas').parentElement.style.cursor || '')`)
  }
  const overNothing = await readCursor(handles.empty)
  const overKnob = await readCursor(handles.rotate)
  const overEdge = await readCursor(handles.n)
  if (!/svg/.test(overKnob)) {
    fail(`hovering the rotate knob at ${JSON.stringify(handles.rotate)} gave no rotation cursor (was "${overNothing}" over empty space, "${overKnob}" on the knob)`)
  } else if (overEdge !== 'ns-resize') {
    fail(`hovering the top edge should still resize, got "${overEdge}"`)
  } else {
    console.log('E2E PASS: the rotate knob and resize handles change the cursor on hover')
  }

  // ...and dragging that knob turns the shape, in one undo step. The knob starts
  // straight above the centre, so dropping it due east is a quarter turn.
  const knob = handles.rotate
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: knob.x, y: knob.y, button: 'left', clickCount: 1 })
  await sleep(80)
  const quarter = { x: handles.centre.x + 70, y: handles.centre.y }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: quarter.x, y: quarter.y, button: 'left', buttons: 1 })
  await sleep(160)
  const rotatingNow = await evaluate(`globalThis.__polyform.editor.get().rotating`)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: quarter.x, y: quarter.y, button: 'left', clickCount: 1 })
  await sleep(350)
  const rot = JSON.parse(await evaluate(`JSON.stringify({
    deg: Math.round(globalThis.__polyform.documentStore.scene.getNode('e2e-rot').rotation),
    rotating: globalThis.__polyform.editor.get().rotating,
    label: globalThis.__polyform.documentStore.history.undoStack.at(-1)?.label,
  })`))
  if (Math.abs(rot.deg - 90) > 2 || rot.label !== 'Rotate') {
    fail(`dragging the knob should be a quarter turn in one step, got ${JSON.stringify(rot)}`)
  } else if (rotatingNow !== true || rot.rotating !== false) {
    fail(`the rotating flag should be on mid-drag and off after (mid=${rotatingNow}, after=${rot.rotating})`)
  } else {
    console.log('E2E PASS: dragging the rotate knob turns the shape in one undo step')
  }

  // ---------------------------------------------------------------------
  // 6. Typing a value into the inspector is ONE undo step, and Escape
  //    discards it.
  //
  //    Enter committed and then blurred the input, and blur committed too, so
  //    every typed value landed twice: two identical history entries, and two
  //    Ctrl+Z to get back one edit. Escape had the mirror problem — it blurred,
  //    so it committed the text it was meant to throw away. Neither is visible
  //    to a unit test: it takes a real focus/keypress/blur sequence.
  // ---------------------------------------------------------------------
  await evaluate(`globalThis.__polyform.editor.set({ selection: ['e2e-rot'], vectorEditId: null })`)
  await sleep(350)
  const xField = JSON.parse(await evaluate(`(() => {
    const glyph = [...document.querySelectorAll('[data-scrub]')].find(e => e.textContent === 'X')
    const input = glyph ? glyph.parentElement.querySelector('input') : null
    if (!input) return 'null'
    const r = input.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
  })()`))
  if (!xField) {
    fail('inspector X input not found')
  } else {
    const typeInto = async (text, key) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: xField.x, y: xField.y, button: 'left', clickCount: 1 })
      await sleep(50)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xField.x, y: xField.y, button: 'left', clickCount: 1 })
      await sleep(180)
      await send('Input.insertText', { text })
      await sleep(120)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 27 })
      await sleep(450)
    }
    const state = async () => JSON.parse(await evaluate(`JSON.stringify({
      x: Math.round(globalThis.__polyform.documentStore.scene.getNode('e2e-rot').x),
      entries: globalThis.__polyform.documentStore.history.undoStack.length,
    })`))

    const start = await state()
    await typeInto('321', 'Enter')
    const typed = await state()
    if (typed.x !== 321) {
      fail(`typing into the inspector did not apply: x=${typed.x}`)
    } else if (typed.entries - start.entries !== 1) {
      fail(`typing a value made ${typed.entries - start.entries} history entries, expected 1`)
    } else {
      await evaluate(`globalThis.__polyform.documentStore.undo()`)
      await sleep(300)
      const undone = await state()
      if (undone.x !== start.x) {
        fail(`one undo should restore x=${start.x}, got ${undone.x}`)
      } else {
        console.log('E2E PASS: typing a value is one edit and one undo')
      }
    }

    const beforeEsc = await state()
    await typeInto('999', 'Escape')
    const afterEsc = await state()
    if (afterEsc.x !== beforeEsc.x || afterEsc.entries !== beforeEsc.entries) {
      fail(`Escape should discard, but x=${afterEsc.x} (was ${beforeEsc.x}) and entries ${beforeEsc.entries}->${afterEsc.entries}`)
    } else {
      console.log('E2E PASS: Escape discards a typed value')
    }
  }

  // ---------------------------------------------------------------------
  // 7. The dropdown: a caret you can see, a menu that is ours, and keys that
  //    do not leak.
  //
  //    The menu used to be Chromium's own popup — unstyleable, and absent from
  //    the screenshots this gate takes, so nothing here could see it at all.
  //    Now it is DOM. The leak matters as much as the menu: a native <select>
  //    counted as a typing target for the global shortcuts, so a focused
  //    dropdown swallowed single keys; a button does not, and "r" would
  //    otherwise switch to the rectangle tool while a menu is open.
  // ---------------------------------------------------------------------
  await evaluate(`globalThis.__polyform.editor.set({ selection: ['e2e-rot'], vectorEditId: null, tool: 'select' })`)
  await sleep(350)
  const blend = JSON.parse(await evaluate(`(() => {
    const b = [...document.querySelectorAll('button[role="combobox"]')]
      .find(e => (e.querySelector('.pf-select-value')?.textContent || '') === 'Normal')
    if (!b) return 'null'
    const r = b.getBoundingClientRect()
    const caret = b.querySelector('svg')
    const cr = caret ? caret.getBoundingClientRect() : null
    return JSON.stringify({
      x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2),
      // The caret sits inside the box, at its right edge.
      caret: cr ? { w: Math.round(cr.width), rightGap: Math.round(r.right - cr.right) } : null,
      openMenus: document.querySelectorAll('[role="listbox"]').length,
    })
  })()`))
  if (!blend) {
    fail('no Blend mode dropdown found in the inspector')
  } else if (!blend.caret || blend.caret.w < 6 || blend.caret.rightGap < 0 || blend.caret.rightGap > 10) {
    fail(`the dropdown should carry a caret inside its right edge, got ${JSON.stringify(blend.caret)}`)
  } else {
    const clickAt = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await sleep(60)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(260)
    }
    /**
     * Click a control by ASKING WHERE IT IS FIRST, then wait for the menu rather
     * than sleeping a fixed 260ms.
     *
     * Both halves are load-bearing: reading a rect in one round trip and
     * clicking it in the next lets a re-render move the target in between, and a
     * fixed sleep turns a slow open into a failure. This check flaked exactly
     * once that way, which makes it worthless as a gate until it cannot.
     */
    const openByLabel = async (label) => {
      const at = JSON.parse(await evaluate(`(() => {
        const b = [...document.querySelectorAll('button[role="combobox"]')]
          .find(e => (e.querySelector('.pf-select-value')?.textContent || '') === ${JSON.stringify(label)})
        if (!b) return 'null'
        const r = b.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2), top: Math.round(r.top) })
      })()`))
      if (!at) return null
      await clickAt(at.x, at.y)
      for (let i = 0; i < 12; i++) {
        if (await evaluate(`!!document.querySelector('[role="listbox"]')`)) return at
        await sleep(120)
      }
      return at
    }
    const menu = async () => JSON.parse(await evaluate(`(() => {
      const m = document.querySelector('[role="listbox"]')
      if (!m) return JSON.stringify({ open: false })
      const rows = [...m.querySelectorAll('[role="option"]')]
      const checked = rows.filter(r => r.getAttribute('aria-selected') === 'true')
      const r = m.getBoundingClientRect()
      return JSON.stringify({
        open: true, rows: rows.length,
        checked: checked.map(c => c.textContent),
        // A check glyph, not just an attribute: this is the thing the native
        // popup could not draw.
        checkGlyphs: checked.filter(c => c.querySelector('svg')).length,
        // In the body, not the panel: the inspector scrolls and clips.
        inBody: m.parentElement === document.body,
        // Second row's centre, for picking with the mouse.
        pick: rows[1] ? { x: Math.round(rows[1].getBoundingClientRect().left + 30),
                          y: Math.round(rows[1].getBoundingClientRect().top + 8),
                          label: rows[1].textContent } : null,
        top: Math.round(r.top), height: Math.round(r.height),
        onScreen: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1,
      })
    })()`))

    await openByLabel('Normal')
    const opened = await menu()
    if (!opened.open) {
      fail('clicking the dropdown did not open a menu')
    } else if (opened.rows < 10 || opened.checked.length !== 1 || opened.checkGlyphs !== 1) {
      fail(`the menu should list every blend mode and check the current one, got ${JSON.stringify(opened)}`)
    } else if (!opened.inBody || !opened.onScreen) {
      fail(`the menu must be a body portal kept on screen, got inBody=${opened.inBody} onScreen=${opened.onScreen}`)
    } else {
      // The whole menu is in our own compositor frame — so unlike the native
      // popup, a screenshot of the page contains it.
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      if (!shot.result?.data) fail('could not screenshot the page with the menu open')
      console.log(`E2E PASS: the dropdown has a caret and opens our own menu (${opened.rows} rows, checked ${JSON.stringify(opened.checked)})`)
    }

    // Typing while the menu is open must not reach the global shortcuts.
    if (opened.open) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR', text: 'r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR' })
      await sleep(200)
      const tool = await evaluate(`globalThis.__polyform.editor.get().tool`)
      if (tool !== 'select') fail(`a keystroke leaked from the open menu to the global shortcuts (tool is now "${tool}")`)
      else console.log('E2E PASS: keys typed into the dropdown do not reach the global shortcuts')
    }

    // Pick the second row with the mouse: it applies, once.
    const before = JSON.parse(await evaluate(`JSON.stringify({
      mode: globalThis.__polyform.documentStore.scene.getNode('e2e-rot').blendMode,
      entries: globalThis.__polyform.documentStore.history.undoStack.length })`))
    if (opened.pick) {
      await clickAt(opened.pick.x, opened.pick.y)
      const after = JSON.parse(await evaluate(`JSON.stringify({
        mode: globalThis.__polyform.documentStore.scene.getNode('e2e-rot').blendMode,
        entries: globalThis.__polyform.documentStore.history.undoStack.length,
        stillOpen: !!document.querySelector('[role="listbox"]') })`))
      if (after.mode === before.mode || after.entries - before.entries !== 1 || after.stillOpen) {
        fail(`picking "${opened.pick.label}" should apply once and close, got ${JSON.stringify(after)} from ${JSON.stringify(before)}`)
      } else {
        // ...and picking the SAME value again spends no history entry: the
        // native select fired no change event for it, and re-picking should not
        // cost an undo.
        // The label we just picked is now the trigger's label — no case mapping
        // from the enum, which would guess wrong on 'Color dodge'.
        await openByLabel(opened.pick.label)
        const again = await menu()
        const same = again.open
          ? await (async () => {
              const row = JSON.parse(await evaluate(`(() => {
                const r = [...document.querySelectorAll('[role="option"]')]
                  .find(e => e.getAttribute('aria-selected') === 'true')
                if (!r) return 'null'
                const b = r.getBoundingClientRect()
                return JSON.stringify({ x: Math.round(b.left + 30), y: Math.round(b.top + 8) })
              })()`))
              if (!row) return null
              await clickAt(row.x, row.y)
              return JSON.parse(await evaluate(`JSON.stringify({
                entries: globalThis.__polyform.documentStore.history.undoStack.length })`))
            })()
          : null
        if (!same) fail('re-opening the dropdown on the current value did not find its checked row')
        else if (same.entries !== after.entries) fail(`re-picking the current option spent a history entry (${after.entries} -> ${same.entries})`)
        else console.log(`E2E PASS: picking applies once (${before.mode} -> ${after.mode}), re-picking the same value is free`)
      }
    }

    // A dropdown near the bottom of the window must not open off the bottom of
    // it. A tall window never gets close enough for that to be a real test, so
    // shrink the viewport until the gap below the dropdown is smaller than the
    // menu, which is the case the placement has to flip for.
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 420, deviceScaleFactor: 0, mobile: false })
    await sleep(500)
    const low = JSON.parse(await evaluate(`(() => {
      const boxes = [...document.querySelectorAll('button[role="combobox"]')]
      if (!boxes.length) return 'null'
      const b = boxes[boxes.length - 1]
      b.scrollIntoView({ block: 'end' })
      const r = b.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2),
        top: Math.round(r.top), bottomGap: Math.round(innerHeight - r.bottom), viewport: innerHeight })
    })()`))
    if (!low) {
      fail('no dropdown to test downward overflow with')
    } else {
      await clickAt(low.x, low.y)
      const placed = await menu()
      if (!placed.open) fail(`the low dropdown at y=${low.y} did not open`)
      else if (!placed.onScreen) fail(`a dropdown ${low.bottomGap}px from the window bottom opened off screen: ${JSON.stringify(placed)}`)
      else if (placed.height > low.bottomGap && placed.top >= low.top)
        fail(`a ${placed.height}px menu with only ${low.bottomGap}px below it should have opened upwards, but its top is ${placed.top} and the box's is ${low.top}`)
      else console.log(`E2E PASS: a ${placed.height}px menu with ${low.bottomGap}px below it in a ${low.viewport}px window stays on screen (top ${placed.top} vs box ${low.top})`)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(250)
      const kept = await evaluate(`JSON.stringify(globalThis.__polyform.editor.get().selection)`)
      if (kept !== '["e2e-rot"]') fail(`Escape closed the menu but also reached the canvas: selection is ${kept}`)
      else console.log('E2E PASS: Escape closes the menu without clearing the selection')
      await send('Emulation.clearDeviceMetricsOverride')
    }
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
