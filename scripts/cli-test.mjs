// v0.6 item 7.4 gate: the headless CLI, end to end (ADR-023).
//
//   1. `polyform new`            — creates a real bundle, no dialog
//   2. `polyform mcp serve`      — an MCP client spawns it over STDIO,
//                                  discovers all 9 tools (edit included —
//                                  spawning over your own file IS consent),
//                                  and edits the document
//   3. `polyform query`          — a FRESH process sees those edits, which
//                                  proves they reached disk, not just memory
//   4. `polyform export`         — the PNG decodes and contains the fill
//                                  colour the edit wrote
//
// Usage: npm run build && node scripts/cli-test.mjs

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { inflateSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { killElectronMatching } from './proc-cleanup.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const MAIN = path.join(ROOT, 'out', 'main', 'index.js')
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'polyform-cli-gate-'))
const BUNDLE = path.join(WORK, 'Gate.poly')
const ENV = { ...process.env }
delete ENV.ELECTRON_RUN_AS_NODE

let failures = 0
function pass(msg) {
  console.log(`CLI PASS: ${msg}`)
}
function fail(msg) {
  console.error(`CLI FAIL: ${msg}`)
  failures++
}

/** The serve chain is cmd→cli.js→electron→relay: on Windows, killing the
 * direct child orphans the grandchildren, so take down the whole tree. */
let serveTransport = null
/** Captured once at spawn: the transport forgets its child on close. */
let servePid = null
function killServeTree() {
  // The captured pid, NOT serveTransport.pid: the SDK drops its child handle
  // on close, so by cleanup time the transport reports null and the whole
  // serve chain (electron main + its relay grandchild) leaks — each leftover
  // then holds the userData cache lock and the port for the next run.
  const pid = servePid
  if (pid) {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', shell: true })
    } catch {
      /* already gone */
    }
  }
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
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
  const colors = new Set()
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const i = y * stride + x * channels
      colors.add(`#${out.subarray(i, i + 3).toString('hex').toUpperCase()}`)
    }
  }
  return { width, height, colors }
}

function run(args, timeoutMs = 90_000) {
  const r = spawnSync(ELECTRON, [MAIN, ...args], {
    cwd: ROOT,
    env: ENV,
    encoding: 'utf-8',
    timeout: timeoutMs,
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

try {
  // --- 1. new --------------------------------------------------------------
  const created = run(['new', BUNDLE])
  if (created.code !== 0 || !fs.existsSync(path.join(BUNDLE, 'manifest.json'))) {
    fail(`polyform new failed (exit ${created.code}): ${created.stderr.slice(-300)}`)
    throw new Error('cannot continue without a bundle')
  }
  pass(`polyform new created a real bundle (${path.basename(BUNDLE)})`)

  // --- 2. mcp serve over stdio ----------------------------------------------
  const client = new Client({ name: 'cli-gate', version: '1.0.0' })
  const transport = (serveTransport = new StdioClientTransport({
    command: ELECTRON,
    args: [MAIN, 'mcp', 'serve', BUNDLE],
    env: ENV,
    stderr: 'pipe',
  }))
  // Drain stderr or the child BLOCKS once the pipe buffer fills — and keep
  // the tail for diagnostics when something goes wrong.
  let serveStderr = ''
  transport.stderr?.on('data', (chunk) => {
    serveStderr = (serveStderr + chunk.toString()).slice(-4000)
  })
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`stdio connect timed out; server stderr tail:\n${serveStderr}`)),
        90_000,
      ),
    ),
  ])
  // AFTER connect: the SDK spawns the child in transport.start(), so reading
  // .pid at construction time yields null — and a null pid silently skipped
  // the whole cleanup, leaving a serve chain per run holding the port and the
  // userData cache lock.
  servePid = transport.pid
  pass('stdio MCP client connected (client spawned the server — no port, no token)')

  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  const expected = [
    'edit_document',
    'get_document',
    'get_node',
    'get_node_image',
    'get_selection',
    'get_view_image',
    'import_image',
    'import_svg',
    'poll_changes',
    'remove_background',
  ]
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`serve tool list wrong: ${JSON.stringify(names)}`)
  } else {
    pass('all 10 tools available over stdio — edit included without a grant dance')
  }

  const edited = await client.callTool({
    name: 'edit_document',
    arguments: {
      label: 'Gate frame',
      edits: [
        {
          op: 'create', type: 'FRAME', ref: 'hero',
          props: { name: 'Hero', x: 0, y: 0, width: 400, height: 300, fill: '#123456' },
        },
        {
          op: 'create', type: 'RECTANGLE', parentId: '$hero',
          props: { name: 'Mark', x: 40, y: 40, width: 160, height: 120, fill: '#FF4E00', cornerRadius: 12 },
        },
        {
          op: 'create', type: 'TEXT', parentId: '$hero',
          props: { name: 'Caption', x: 40, y: 200, width: 320, height: 40, characters: 'shipped from the CLI', fontFamily: 'Inter', fontSize: 24, fill: '#FFFFFF' },
        },
      ],
    },
  })
  if (edited.isError) {
    fail(`edit over stdio failed: ${edited.content.map((c) => c.text).join(' ')}`)
  } else {
    const result = JSON.parse(edited.content.find((c) => c.type === 'text').text)
    if (result.committed !== 'Agent: Gate frame') fail(`bad commit label ${result.committed}`)
    else pass('edit landed over stdio as one attributed entry')
  }
  await client.close()
  await new Promise((r) => setTimeout(r, 1500))

  // --- 3. query in a FRESH process proves persistence -----------------------
  const queried = run(['query', BUNDLE])
  if (queried.code !== 0) {
    fail(`polyform query failed (exit ${queried.code}): ${queried.stderr.slice(-300)}`)
  } else {
    const doc = JSON.parse(queried.stdout)
    const hero = doc.tree?.find((n) => n && n.name === 'Hero')
    if (doc.nodeCount !== 3 || !hero || hero.childCount !== 2) {
      fail(`stdio edits did not persist to disk: ${JSON.stringify({ nodeCount: doc.nodeCount, hero })}`)
    } else {
      pass(`a fresh process sees the edits — they reached disk (${doc.nodeCount} nodes, Hero has ${hero.childCount} children)`)
    }
  }

  // --- 4. export decodes and carries the written colours --------------------
  const outPng = path.join(WORK, 'hero.png')
  const exported = run(['export', BUNDLE, '--frame', 'Hero', '--scale', '2', '--out', outPng])
  if (exported.code !== 0 || !fs.existsSync(outPng)) {
    fail(`polyform export failed (exit ${exported.code}): ${exported.stderr.slice(-300)}`)
  } else {
    const png = decodePng(fs.readFileSync(outPng))
    if (png.width !== 800 || png.height !== 600) {
      fail(`export @2x should be 800x600, got ${png.width}x${png.height}`)
    } else if (!png.colors.has('#123456') || !png.colors.has('#FF4E00')) {
      fail(`export missing the written fills (saw ${[...png.colors].slice(0, 5).join(', ')})`)
    } else {
      pass(`export @2x is 800x600 and contains both written fills`)
    }
  }

  // --- 5. bad input fails loudly, not silently ------------------------------
  const missing = run(['query', path.join(WORK, 'DoesNotExist.poly')])
  if (missing.code === 0) fail('query on a missing bundle exited 0')
  else pass(`missing bundle exits non-zero (${missing.code})`)

  if (failures === 0) console.log('CLI GATE: all checks passed')
} catch (err) {
  fail(String(err))
} finally {
  // Exit DETERMINISTICALLY. A surviving member of the serve chain
  // (cmd→cli.js→electron→relay) holds pipe handles that keep this process
  // alive forever — it wedged three runs before this teardown existed.
  killServeTree()
  killElectronMatching(WORK)
  try {
    fs.rmSync(WORK, { recursive: true, force: true })
  } catch {
    /* a live handle on Windows — swept next run */
  }
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500)
}
