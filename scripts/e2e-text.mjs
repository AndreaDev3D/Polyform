// E2E gate for the add-text flow (the one class of bug no engine test or
// render fixture can see: DOM focus interplay). Boots the BUILT app with
// CDP, simulates the real gesture — T, click, type, Escape — and asserts
// the text survives. Regression guard for the mid-gesture focus bounce
// that silently deleted every freshly placed text node (F-18).
//
// Usage: npm run build && npm run test:e2e   (requires Node 22+)

import { spawn } from 'node:child_process'
import process from 'node:process'

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
    info: { path: 'e2e-scratch.poly', manifest: { name: 'E2E', schemaVersion: 3 } },
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
} catch (err) {
  fail(String(err))
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  electron.kill()
  // Windows: electron spawns via shell; make sure the tree dies.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(electron.pid)], { stdio: 'ignore', shell: true })
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500)
}
