// Does "Check for Updates" work in a PACKAGED app?
//
// It did not, for two releases, in two unrelated ways — and neither was visible
// from source, because `checkForUpdates` returns early unless `app.isPackaged`
// (F-29). So this gate drives the packaged binary through the same IPC the button
// uses, with betas off and on.
//
// What it asserts is narrow on purpose: **no programming-error-shaped failure**. A
// network problem, a rate limit, or "nothing published yet" are all legitimate
// answers from a machine that may be offline or a repo that may be empty. A
// TypeError is not an answer at all — it is the class of bug that shipped:
//
//   Cannot set properties of undefined (setting 'autoDownload')
//
// i.e. the module interop broke and the very first line of the check threw.
//
// Usage: POLYFORM_BIN=<packaged binary> node scripts/update-check-gate.mjs
// Needs a display; CI runs it under xvfb like the rest of the packaging gate.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const BIN = process.env.POLYFORM_BIN
if (!BIN) {
  console.error('update-check-gate: set POLYFORM_BIN to the packaged binary')
  process.exit(2)
}

const PORT = Number(process.env.POLYFORM_CDP_PORT ?? 9455)
const userData = mkdtempSync(path.join(tmpdir(), 'polyform-update-gate-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A message that means "the code is wrong", not "the network is unhelpful".
const BROKEN = /cannot (set|read) propert|is not a function|is not defined|undefined is not|did not expose autoUpdater/i

let failed = 0
const fail = (m) => {
  console.error(`UPDATE GATE FAIL: ${m}`)
  failed++
}
const pass = (m) => console.log(`UPDATE GATE OK: ${m}`)

const child = spawn(BIN, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
  stdio: 'ignore',
  // ELECTRON_RUN_AS_NODE would turn the app into a plain node process, and the
  // packaging gate sets it for the CLI checks that run before this one.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
})

let ws
try {
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* not listening yet */
    }
  }
  if (!target) throw new Error(`the packaged app never opened a debuggable window on ${PORT}`)

  ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await new Promise((r) => (ws.onopen = r))
  await send('Runtime.enable')

  const evaluate = async (expression, ms = 60_000) => {
    const call = send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const res = await Promise.race([call, new Promise((r) => setTimeout(() => r(null), ms))])
    if (res === null) return { timedOut: true }
    if (res.result?.exceptionDetails) {
      return { thrown: String(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text) }
    }
    return { value: res.result?.result?.value }
  }

  for (let i = 0; i < 40; i++) {
    const ready = await evaluate('!!window.polyform')
    if (ready.value === true) break
    await sleep(250)
  }

  for (const betas of [false, true]) {
    const set = await evaluate(`window.polyform.updateBeta(${betas})`)
    if (set.thrown) fail(`updateBeta(${betas}) threw: ${set.thrown.slice(0, 200)}`)
    const res = await evaluate('window.polyform.checkUpdates()')
    const label = `betas ${betas ? 'on ' : 'off'}`
    if (res.timedOut) {
      fail(`${label}: the check never returned (60s) — a hung update check is a hung menu item`)
      continue
    }
    if (res.thrown) {
      fail(`${label}: checkUpdates() threw ${res.thrown.slice(0, 200)}`)
      continue
    }
    const status = res.value ?? {}
    const summary = `${status.state}${status.version ? ` ${status.version}` : ''}${status.message ? ` — ${status.message}` : ''}`
    if (status.state === 'error' && BROKEN.test(String(status.message ?? ''))) {
      fail(`${label}: ${summary}\n    That is a programming error, not an update result.`)
      continue
    }
    if (status.state === 'unsupported') {
      fail(`${label}: reported "unsupported" — this gate is pointless unless it runs the PACKAGED app`)
      continue
    }
    pass(`${label}: ${summary}`)
  }
} catch (err) {
  fail(String(err?.message ?? err))
} finally {
  try {
    ws?.close()
  } catch {
    /* closing a dead socket */
  }
  if (process.platform === 'win32') spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', shell: true })
  else child.kill('SIGKILL')
  await sleep(1000)
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* the profile is in a temp dir either way */
  }
}

if (failed > 0) {
  console.error(`\n${failed} update-check problem(s) in the packaged app.`)
  process.exitCode = 1
} else {
  console.log('\nThe packaged app can check for updates on both channels.')
}
