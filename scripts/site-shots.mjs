// The website's screenshots, taken from the real app.
//
// A design tool's landing page is judged on one thing: the picture of itself.
// Mocking that picture up in Figma would be both dishonest and, for this
// project specifically, absurd. So this boots the BUILT app under CDP — the
// same harness scripts/e2e-text.mjs uses to drive real input — synthesizes a
// document, frames it, and captures what is actually on screen.
//
// It also renders the social card and the touch icon, by replacing the
// document with a small HTML page and screenshotting that. Same debugger, no
// image library: the repo has no sharp/resvg/puppeteer and a website is not
// a good enough reason to add a native dependency to a desktop app's build.
//
// The output is COMMITTED to site/src/shots/. Building the website must never
// require booting Electron; this script is run by hand when the UI changes.
//
// Usage: npm run build && npm run site:shots

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { killElectronMatching } from './proc-cleanup.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SHOTS = path.join(ROOT, 'site', 'src', 'shots')
const ICONS = path.join(ROOT, 'site', 'src', 'icons')
const GALLERY_DIR = path.join(ROOT, 'site', 'src', 'gallery')
// og.png is the ONE asset that must keep a stable, predictable URL: it is
// baked into the page's og:image as an absolute link, and crawlers cache it.
// Everything else goes through src/ so Vite can hash it.
const PUBLIC = path.join(ROOT, 'site', 'public')
// Not 9333: that is the e2e gate's port, and a screenshot run that silently
// attached to a leftover e2e window would photograph its scratch document.
const PORT = 9334

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
  console.error('site-shots: no build in out/ — run `npm run build` first')
  process.exit(1)
}
for (const dir of [SHOTS, ICONS, GALLERY_DIR, PUBLIC]) fs.mkdirSync(dir, { recursive: true })

// ---------------------------------------------------------------------------
// A tiny node-building vocabulary, shared by every composition below.
//
// Everything here runs as a STRING inside the renderer, where
// `globalThis.__polyform` lives — so it is prepended to each composition
// rather than imported. Written once because there are now six documents to
// build (the editor screenshot plus five gallery pieces) and six copies of
// `rgb`/`solid`/`grad` would drift within a week.
// ---------------------------------------------------------------------------
const HELPERS = String.raw`
  const P = globalThis.__polyform
  const s = P.documentStore.scene
  // Two counters on purpose. One counts how many nodes THIS composition made,
  // which is worth reporting; the id comes off a counter that outlives the
  // composition, because clearing the page removes the root frames without
  // purging their descendants from the scene's node map — so a second
  // composition starting again at 1 collides with shapes that are gone from
  // the canvas but still known to the graph.
  // (No backticks in here: this whole block is inside a template literal.)
  let seq = 0
  globalThis.__shotSeq = globalThis.__shotSeq || 0
  const id = () => {
    seq++
    return 'shot' + (++globalThis.__shotSeq).toString(36).padStart(4, '0')
  }

  const rgb = (hex, a = 1) => ({
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
    a,
  })
  const solid = (hex, a = 1) => [{ type: 'SOLID', visible: true, opacity: 1, color: rgb(hex, a) }]
  const grad = (from, to, start = { x: 0, y: 0 }, end = { x: 1, y: 1 }) => [{
    type: 'GRADIENT_LINEAR', visible: true, opacity: 1, start, end,
    stops: [{ position: 0, color: rgb(from) }, { position: 1, color: rgb(to) }],
  }]
  const radius = (n) => ({ tl: n, tr: n, br: n, bl: n })
  const NO_LAYOUT = {
    mode: 'NONE', gap: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    counterAlign: 'MIN', primarySizing: 'FIXED', counterSizing: 'FIXED',
  }

  const base = (type, name, x, y, width, height, props) => Object.assign({
    id: id(), type, name, visible: true, locked: false, opacity: 1, blendMode: 'NORMAL',
    x, y, width, height, rotation: 0,
    fills: solid('#26262c'), strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE',
    strokeDash: [], effects: [],
  }, props)

  const add = (node, parent) => {
    s.addNode(node, parent ?? null, s.childListOf(parent ?? null).length)
    return node.id
  }
  const rect = (name, x, y, w, h, props, parent) =>
    add(base('RECTANGLE', name, x, y, w, h, Object.assign({ cornerRadius: radius(0) }, props)), parent)
  const frame = (name, x, y, w, h, props, parent) =>
    add(base('FRAME', name, x, y, w, h, Object.assign(
      { children: [], clipsContent: true, cornerRadius: radius(0), layout: NO_LAYOUT }, props)), parent)
  const text = (chars, x, y, w, h, props, parent) =>
    add(base('TEXT', chars.length > 22 ? chars.slice(0, 22) : chars, x, y, w, h, Object.assign({
      characters: chars, fontFamily: 'Segoe UI', fontWeight: 400, italic: false,
      fontSize: 14, lineHeight: 1.35, letterSpacing: 0,
      textAlignH: 'LEFT', textAlignV: 'TOP', autoResize: 'NONE',
      fills: solid('#e6e6e6'),
    }, props)), parent)
`

/**
 * The document behind the editor screenshots.
 *
 * Built out of nodes rather than imported from a file, so the picture on the
 * website is reproducible from this repo alone and cannot rot into "some .poly
 * someone had lying around". It is a UI design because that is what Polyform
 * is for; the gradients, the arc and the drop shadows are there because they
 * are the features the surrounding page claims.
 */
const BUILD_DOC = String.raw`(() => {
  ${HELPERS}

  // --- artboard ------------------------------------------------------------
  const board = frame('Dashboard — Overview', 0, 0, 1280, 800, {
    fills: solid('#141418'), cornerRadius: radius(18),
  })

  // sidebar
  rect('Sidebar', 0, 0, 232, 800, { fills: solid('#1a1a20') }, board)
  rect('Brand dot', 28, 30, 24, 24, { cornerRadius: radius(7), fills: grad('#15EAD6', '#6C74E8') }, board)
  text('Northwind', 62, 33, 140, 20, { fontSize: 15, fontWeight: 600 }, board)

  const NAV = ['Overview', 'Projects', 'Library', 'Members', 'Settings']
  NAV.forEach((label, i) => {
    const y = 92 + i * 44
    const on = i === 0
    rect('Nav item', 20, y, 192, 36, {
      cornerRadius: radius(9),
      fills: on ? grad('#15EAD6', '#6C74E8', { x: 0, y: 0 }, { x: 1, y: 0 }) : solid('#1a1a20'),
      opacity: on ? 0.18 : 1,
    }, board)
    rect('Icon', 34, y + 11, 14, 14, {
      cornerRadius: radius(4), fills: solid(on ? '#35C8E4' : '#5a5a64'),
    }, board)
    text(label, 60, y + 9, 130, 20, {
      fontSize: 13, fontWeight: on ? 600 : 400, fills: solid(on ? '#e6e6e6' : '#8b8b95'),
    }, board)
  })

  // header
  text('Overview', 272, 40, 300, 40, { fontSize: 28, fontWeight: 700, letterSpacing: -0.5 }, board)
  text('Last 30 days across every workspace', 272, 76, 420, 22, {
    fontSize: 13, fills: solid('#8b8b95'),
  }, board)
  rect('Primary action', 1096, 44, 144, 40, {
    cornerRadius: radius(10),
    fills: grad('#15EAD6', '#6C74E8', { x: 0, y: 0 }, { x: 1, y: 1 }),
    effects: [{ type: 'DROP_SHADOW', visible: true, color: rgb('#000000', 0.45), offset: { x: 0, y: 6 }, blur: 18 }],
  }, board)
  text('New project', 1120, 56, 110, 20, { fontSize: 13, fontWeight: 600, fills: solid('#08080a') }, board)

  // stat cards
  const STATS = [
    ['Active projects', '128', '#15EAD6'],
    ['Components', '1,904', '#35C8E4'],
    ['Contributors', '46', '#6C74E8'],
  ]
  STATS.forEach(([label, value, accent], i) => {
    const x = 272 + i * 328
    rect('Stat card', x, 128, 304, 132, {
      cornerRadius: radius(14), fills: solid('#1a1a20'), strokes: solid('#2a2a31'), strokeWeight: 1,
    }, board)
    rect('Accent', x + 24, 152, 34, 4, { cornerRadius: radius(2), fills: solid(accent) }, board)
    text(label, x + 24, 170, 200, 20, { fontSize: 12, fills: solid('#8b8b95') }, board)
    text(value, x + 24, 194, 200, 46, { fontSize: 34, fontWeight: 700, letterSpacing: -1 }, board)
  })

  // chart card
  rect('Chart card', 272, 288, 632, 464, {
    cornerRadius: radius(14), fills: solid('#1a1a20'), strokes: solid('#2a2a31'), strokeWeight: 1,
  }, board)
  text('Edits per day', 300, 316, 240, 24, { fontSize: 15, fontWeight: 600 }, board)
  text('journaled to disk, every one of them', 300, 340, 320, 20, { fontSize: 12, fills: solid('#8b8b95') }, board)

  // The bars live in their own frame. Twelve sibling rectangles directly under
  // the artboard turn the layer tree in the screenshot into a wall of the word
  // "Bar", which reads as generated filler — which it is, but it should not
  // look it.
  const bars = frame('Bars', 302, 384, 576, 300, { fills: [], clipsContent: false }, board)
  const BARS = [0.32, 0.51, 0.44, 0.68, 0.58, 0.79, 0.62, 0.9, 0.71, 0.84, 0.66, 0.97]
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']
  BARS.forEach((h, i) => {
    const full = 300
    const height = Math.round(full * h)
    rect(DAYS[i] + ' ' + (i < 7 ? 1 : 2), i * 48, full - height, 30, height, {
      cornerRadius: radius(7),
      fills: grad('#6C74E8', '#15EAD6', { x: 0, y: 1 }, { x: 0, y: 0 }),
      opacity: 0.35 + 0.65 * h,
    }, bars)
  })

  // donut card — an arc ellipse, which is a real v5 feature and looks like one
  rect('Split card', 928, 288, 312, 464, {
    cornerRadius: radius(14), fills: solid('#1a1a20'), strokes: solid('#2a2a31'), strokeWeight: 1,
  }, board)
  text('Storage', 956, 316, 200, 24, { fontSize: 15, fontWeight: 600 }, board)
  add(base('ELLIPSE', 'Ring', 984, 372, 200, 200, {
    fills: grad('#15EAD6', '#A322E0', { x: 0, y: 0 }, { x: 1, y: 1 }),
    arcStart: 0, arcSweep: 0.72, arcRatio: 0.66,
  }), board)
  text('72%', 1032, 448, 110, 44, { fontSize: 32, fontWeight: 700, textAlignH: 'CENTER' }, board)
  const LEGEND = [['Assets', '#15EAD6'], ['History', '#6C74E8'], ['Free', '#2f2f37']]
  LEGEND.forEach(([label, hex], i) => {
    const y = 612 + i * 34
    rect('Swatch', 956, y, 12, 12, { cornerRadius: radius(4), fills: solid(hex) }, board)
    text(label, 978, y - 2, 160, 20, { fontSize: 13, fills: solid('#c8c8d0') }, board)
  })

  // --- a second artboard, so the canvas looks like work rather than a demo ---
  const swatches = frame('Palette', 1420, 0, 360, 372, {
    fills: solid('#141418'), cornerRadius: radius(18),
  })
  text('Brand ramp', 32, 32, 240, 26, { fontSize: 16, fontWeight: 600 }, swatches)
  const RAMP = ['#15EAD6', '#35C8E4', '#6C74E8', '#A322E0']
  RAMP.forEach((hex, i) => {
    rect('Swatch ' + hex, 32, 76 + i * 68, 296, 56, {
      cornerRadius: radius(12), fills: solid(hex),
      effects: [{ type: 'DROP_SHADOW', visible: true, color: rgb('#000000', 0.4), offset: { x: 0, y: 4 }, blur: 14 }],
    }, swatches)
  })

  const buttons = frame('Buttons', 1420, 428, 360, 324, {
    fills: solid('#141418'), cornerRadius: radius(18),
  })
  text('Button / Primary', 32, 32, 260, 26, { fontSize: 16, fontWeight: 600 }, buttons)
  rect('Primary', 32, 76, 296, 48, {
    cornerRadius: radius(12), fills: grad('#15EAD6', '#6C74E8', { x: 0, y: 0 }, { x: 1, y: 0 }),
  }, buttons)
  text('Continue', 140, 91, 120, 22, { fontSize: 14, fontWeight: 600, fills: solid('#08080a') }, buttons)
  rect('Secondary', 32, 140, 296, 48, {
    cornerRadius: radius(12), fills: solid('#1f1f26'), strokes: solid('#33333c'), strokeWeight: 1,
  }, buttons)
  text('Learn more', 136, 155, 130, 22, { fontSize: 14, fontWeight: 600, fills: solid('#e6e6e6') }, buttons)
  rect('Ghost', 32, 204, 296, 48, { cornerRadius: radius(12), fills: solid('#16161b') }, buttons)
  text('Cancel', 150, 219, 100, 22, { fontSize: 14, fontWeight: 600, fills: solid('#8b8b95') }, buttons)

  s.activePage.name = 'Product'
  P.documentStore.emit()
  return JSON.stringify({ board, swatches, buttons, bars, nodes: seq })
})()`

/**
 * Frame the main artboard, not everything.
 *
 * Fitting all three artboards put the canvas at 41%, which photographs as a
 * postage stamp adrift in grey. Fitting the dashboard alone roughly doubles
 * it, and the nudge to the right lets the Palette artboard sit half-off the
 * edge — which is what a session someone is actually working in looks like.
 */
const FRAME_ALL = String.raw`(() => {
  const P = globalThis.__polyform
  const { viewportSize } = P.editor.get()
  const pad = 40
  const content = { x: 0, y: 0, w: 1280, h: 800 }
  const zoom = Math.min(
    (viewportSize.w - pad * 2) / content.w,
    (viewportSize.h - pad * 2) / content.h,
  )
  const cx = content.x + content.w / 2
  const cy = content.y + content.h / 2
  P.editor.set({ camera: { x: cx - viewportSize.w / (2 * zoom), y: cy - viewportSize.h / (2 * zoom), zoom } })
  return JSON.stringify({ zoom, viewportSize })
})()`

// ---------------------------------------------------------------------------
// The gallery: five pieces answering "what comes out of this thing?"
//
// Every one is BUILT IN POLYFORM and photographed off its own canvas. That is
// the argument the section makes, so buying stock art or mocking these up
// elsewhere would quietly make the page a lie. They are also the reason the
// range reads: a greyscale wireframe next to a finished UI next to a poster
// says "the whole way from sketch to print" faster than any list of features.
//
// Each builds one artboard at (0,0) so the capture below can compute its
// screen rect without knowing anything about the composition.
// ---------------------------------------------------------------------------
const GALLERY = [
  {
    key: '01-wireframe',
    w: 1600,
    h: 1000,
    label: 'Wireframe',
    caption: 'Grey boxes and nothing else. Structure before anyone argues about colour.',
    build: String.raw`
    const art = frame('Wireframe — Console', 0, 0, 1600, 1000, { fills: solid('#EFEFF1'), cornerRadius: radius(0) })
    const bar = (x, y, w, h, hex) => rect('bar', x, y, w, h, { cornerRadius: radius(h / 2), fills: solid(hex) }, art)
    const box = (x, y, w, h, fill, stroke) => rect('box', x, y, w, h, {
      cornerRadius: radius(8), fills: solid(fill), strokes: solid(stroke ?? '#D7D7DB'), strokeWeight: 2,
    }, art)
    const label = (t, x, y, w, size, hex) => text(t, x, y, w, size * 1.6, {
      fontSize: size, fontWeight: 600, fills: solid(hex ?? '#8A8A93'), letterSpacing: 0.4,
    }, art)

    // chrome
    rect('Top bar', 0, 0, 1600, 72, { fills: solid('#FFFFFF') }, art)
    rect('Hairline', 0, 70, 1600, 2, { fills: solid('#DEDEE3') }, art)
    rect('Logo', 32, 20, 32, 32, { cornerRadius: radius(8), fills: solid('#C2C2CA') }, art)
    ;['Overview', 'Library', 'Reports'].forEach((t, i) => label(t, 96 + i * 116, 28, 110, 15))
    add(base('ELLIPSE', 'Avatar', 1524, 20, 32, 32, { fills: solid('#CDCDD4') }), art)
    bar(1400, 30, 96, 14, '#DCDCE2')

    // sidebar
    rect('Sidebar', 0, 72, 264, 928, { fills: solid('#F6F6F8') }, art)
    rect('Sidebar rule', 262, 72, 2, 928, { fills: solid('#E4E4E9') }, art)
    for (let i = 0; i < 7; i++) {
      const y = 112 + i * 52
      if (i === 0) rect('Active', 16, y - 10, 232, 40, { cornerRadius: radius(8), fills: solid('#E6E6EB') }, art)
      rect('Icon', 32, y, 18, 18, { cornerRadius: radius(5), fills: solid('#C6C6CE') }, art)
      bar(62, y + 4, 118 + (i % 3) * 26, 10, i === 0 ? '#A9A9B3' : '#D3D3DA')
    }

    // header
    bar(304, 116, 300, 22, '#BFBFC8')
    bar(304, 152, 208, 12, '#D6D6DD')
    box(1352, 112, 216, 44, '#FFFFFF')
    bar(1392, 128, 136, 12, '#CFCFD7')

    // hero placeholder, with the diagonal cross that means "image goes here"
    const hx = 304, hy = 200, hw = 1264, hh = 296
    box(hx, hy, hw, hh, '#E7E7EB', '#D3D3D9')
    const diag = Math.round(Math.sqrt(hw * hw + hh * hh))
    const ang = (Math.atan2(hh, hw) * 180) / Math.PI
    ;[ang, -ang].forEach((r) => rect('Cross', hx + hw / 2 - diag / 2, hy + hh / 2 - 1, diag, 2, {
      fills: solid('#D3D3D9'), rotation: r,
    }, art))
    label('1264 × 296', hx + 24, hy + 24, 200, 13, '#A2A2AB')

    // three cards
    for (let i = 0; i < 3; i++) {
      const x = 304 + i * 432
      box(x, 536, 400, 232, '#FFFFFF')
      rect('Thumb', x + 24, 560, 352, 96, { cornerRadius: radius(6), fills: solid('#E7E7EB') }, art)
      bar(x + 24, 676, 196, 14, '#C6C6CE')
      bar(x + 24, 704, 352, 9, '#DCDCE2')
      bar(x + 24, 722, 300, 9, '#DCDCE2')
      bar(x + 24, 740, 148, 9, '#E3E3E8')
    }

    // footer note, so the piece reads as a real screen and not a swatch sheet
    bar(304, 812, 1264, 2, '#E1E1E6')
    label('WIREFRAME · v3 · not final', 304, 836, 420, 13, '#A2A2AB')
    return art`,
  },

  {
    key: '02-ui-design',
    w: 1400,
    h: 980,
    label: 'Product UI',
    caption: 'The same screens again, finished — type, colour, depth, states.',
    build: String.raw`
    // The wash spans the whole artboard. Starting it halfway down drew a hard
    // horizontal seam straight across the piece, which read as a rendering
    // bug rather than as a background.
    const art = frame('Mobile — Finished', 0, 0, 1400, 980, {
      fills: grad('#F5F5F8', '#E7E8FA', { x: 0, y: 0 }, { x: 0.2, y: 1 }),
    })

    const phone = (ox, oy) => {
      const p = frame('Screen', ox, oy, 340, 700, {
        fills: solid('#FFFFFF'), cornerRadius: radius(40),
        effects: [{ type: 'DROP_SHADOW', visible: true, color: rgb('#1B1B2A', 0.16), offset: { x: 0, y: 22 }, blur: 48 }],
      }, art)
      rect('Notch', 130, 16, 80, 8, { cornerRadius: radius(4), fills: solid('#E6E6EC') }, p)
      return p
    }

    // 1 — onboarding
    const a = phone(80, 130)
    rect('Hero', 0, 0, 340, 300, { fills: grad('#15EAD6', '#6C74E8', { x: 0, y: 0 }, { x: 1, y: 1 }) }, a)
    add(base('ELLIPSE', 'Orb', 196, 44, 168, 168, { fills: solid('#FFFFFF', 0.18) }), a)
    add(base('ELLIPSE', 'Orb', -46, 150, 130, 130, { fills: solid('#FFFFFF', 0.14) }), a)
    text('Everything, on your own disk.', 32, 344, 276, 100, {
      fontSize: 27, fontWeight: 700, lineHeight: 1.22, letterSpacing: -0.6, fills: solid('#15151C'),
    }, a)
    text('No account. No sync. No server deciding what you may open.', 32, 458, 268, 66, {
      fontSize: 14, lineHeight: 1.5, fills: solid('#6E6E7C'),
    }, a)
    rect('CTA', 32, 566, 276, 52, {
      cornerRadius: radius(14), fills: grad('#15EAD6', '#6C74E8', { x: 0, y: 0 }, { x: 1, y: 0 }),
    }, a)
    text('Get started', 130, 583, 140, 24, { fontSize: 15, fontWeight: 600, fills: solid('#07070B') }, a)
    rect('Dots', 148, 646, 44, 6, { cornerRadius: radius(3), fills: solid('#D8D8E0') }, a)

    // 2 — list
    const b = phone(530, 90)
    rect('Header', 0, 0, 340, 132, { fills: solid('#FAFAFC') }, b)
    text('Projects', 28, 52, 200, 40, { fontSize: 25, fontWeight: 700, letterSpacing: -0.5, fills: solid('#15151C') }, b)
    rect('Search', 28, 100, 284, 40, { cornerRadius: radius(11), fills: solid('#EFEFF4') }, b)
    text('Search everything', 48, 112, 200, 20, { fontSize: 13, fills: solid('#9A9AA8') }, b)
    const TINTS = ['#15EAD6', '#35C8E4', '#6C74E8', '#A322E0', '#35C8E4']
    for (let i = 0; i < 5; i++) {
      const y = 168 + i * 92
      rect('Row', 20, y, 300, 76, { cornerRadius: radius(16), fills: solid(i === 0 ? '#F4F4F8' : '#FFFFFF') }, b)
      rect('Thumb', 34, y + 14, 48, 48, { cornerRadius: radius(13), fills: grad(TINTS[i], '#6C74E8') }, b)
      rect('Title', 96, y + 22, 128 + (i % 3) * 22, 11, { cornerRadius: radius(6), fills: solid('#2A2A36') }, b)
      rect('Meta', 96, y + 44, 96, 9, { cornerRadius: radius(5), fills: solid('#C4C4D0') }, b)
    }

    // 3 — stats
    const c = phone(980, 150)
    text('This week', 28, 44, 220, 34, { fontSize: 22, fontWeight: 700, letterSpacing: -0.4, fills: solid('#15151C') }, c)
    add(base('ELLIPSE', 'Ring', 90, 100, 160, 160, {
      fills: grad('#15EAD6', '#A322E0', { x: 0, y: 0 }, { x: 1, y: 1 }),
      arcStart: 0, arcSweep: 0.78, arcRatio: 0.7,
    }), c)
    text('78%', 132, 158, 80, 42, { fontSize: 27, fontWeight: 700, textAlignH: 'CENTER', fills: solid('#15151C') }, c)
    for (let i = 0; i < 3; i++) {
      const y = 300 + i * 68
      rect('Stat', 28, y, 284, 56, { cornerRadius: radius(14), fills: solid('#F6F6FA') }, c)
      rect('Dot', 44, y + 22, 12, 12, { cornerRadius: radius(6), fills: solid(TINTS[i]) }, c)
      rect('Label', 68, y + 20, 120, 10, { cornerRadius: radius(5), fills: solid('#B6B6C4') }, c)
      text(['128', '1,904', '46'][i], 232, y + 16, 64, 26, {
        fontSize: 16, fontWeight: 700, textAlignH: 'RIGHT', fills: solid('#15151C'),
      }, c)
    }
    const BARS = [0.4, 0.62, 0.5, 0.86, 0.7, 0.95, 0.58]
    BARS.forEach((h, i) => rect('Bar', 30 + i * 42, 620 - Math.round(90 * h), 26, Math.round(90 * h), {
      cornerRadius: radius(7), fills: grad('#6C74E8', '#15EAD6', { x: 0, y: 1 }, { x: 0, y: 0 }), opacity: 0.45 + 0.55 * h,
    }, c))
    return art`,
  },

  {
    key: '03-social-post',
    w: 1080,
    h: 1080,
    label: 'Social post',
    caption: 'Square, legible at thumbnail size, exported straight to PNG.',
    build: String.raw`
    const art = frame('Post — 1080', 0, 0, 1080, 1080, { fills: solid('#0C0C0E') })
    add(base('ELLIPSE', 'Bloom', -180, -220, 780, 780, {
      fills: grad('#15EAD6', '#6C74E8'), opacity: 0.5,
      effects: [{ type: 'LAYER_BLUR', visible: true, radius: 130 }],
    }), art)
    add(base('ELLIPSE', 'Bloom', 560, 520, 700, 700, {
      fills: grad('#A322E0', '#6C74E8'), opacity: 0.45,
      effects: [{ type: 'LAYER_BLUR', visible: true, radius: 140 }],
    }), art)
    // A faint rule grid, so the flat areas are not dead space.
    for (let i = 1; i < 6; i++) rect('Rule', 0, i * 180, 1080, 1, { fills: solid('#FFFFFF', 0.05) }, art)
    for (let i = 1; i < 6; i++) rect('Rule', i * 180, 0, 1, 1080, { fills: solid('#FFFFFF', 0.05) }, art)

    rect('Chip', 88, 92, 250, 46, {
      cornerRadius: radius(23), fills: solid('#FFFFFF', 0.08), strokes: solid('#FFFFFF', 0.18), strokeWeight: 1,
    }, art)
    add(base('ELLIPSE', 'Dot', 110, 111, 10, 10, { fills: solid('#15EAD6') }), art)
    text('POLYFORM v0.8', 130, 105, 200, 24, {
      fontSize: 14, fontWeight: 600, letterSpacing: 1.6, fills: solid('#D8D8E2'),
    }, art)

    text('100,000', 84, 300, 920, 190, {
      fontSize: 168, fontWeight: 700, letterSpacing: -7, lineHeight: 1,
      fills: grad('#15EAD6', '#A322E0', { x: 0, y: 0 }, { x: 1, y: 1 }),
    }, art)
    text('shapes, panning', 88, 486, 920, 110, {
      fontSize: 88, fontWeight: 700, letterSpacing: -3.4, lineHeight: 1, fills: solid('#F2F2F5'),
    }, art)
    text('at 60fps.', 88, 588, 920, 110, {
      fontSize: 88, fontWeight: 700, letterSpacing: -3.4, lineHeight: 1, fills: solid('#F2F2F5'),
    }, art)

    text('One draw call. 0.18 ms of CPU per frame. Measured by the harness inside the app, not by us.',
      88, 748, 700, 96, { fontSize: 25, lineHeight: 1.5, fills: solid('#9C9CAA') }, art)

    rect('Footer rule', 88, 906, 904, 1, { fills: solid('#FFFFFF', 0.13) }, art)
    text('Free and open source · MIT', 88, 942, 560, 34, { fontSize: 22, fontWeight: 500, fills: solid('#C9C9D6') }, art)
    text('polyform', 800, 942, 200, 34, {
      fontSize: 22, fontWeight: 700, textAlignH: 'RIGHT', letterSpacing: -0.4, fills: solid('#F2F2F5'),
    }, art)
    return art`,
  },

  {
    key: '04-banner',
    w: 1600,
    h: 600,
    label: 'Banner',
    caption: 'Wide crop of the same system — ad slots, README headers, OG cards.',
    build: String.raw`
    const art = frame('Banner — 1600×600', 0, 0, 1600, 600, { fills: solid('#0C0C0E') })
    add(base('ELLIPSE', 'Sweep', 900, -300, 900, 900, {
      fills: grad('#15EAD6', '#A322E0', { x: 0, y: 0 }, { x: 1, y: 1 }), opacity: 0.42,
      effects: [{ type: 'LAYER_BLUR', visible: true, radius: 150 }],
    }), art)
    rect('Edge', 0, 0, 6, 600, { fills: grad('#15EAD6', '#A322E0', { x: 0, y: 0 }, { x: 0, y: 1 }) }, art)

    rect('Mark', 92, 88, 46, 46, { cornerRadius: radius(12), fills: grad('#15EAD6', '#6C74E8') }, art)
    text('Polyform', 154, 96, 260, 34, { fontSize: 24, fontWeight: 700, letterSpacing: -0.5, fills: solid('#F2F2F5') }, art)

    text('Design tools that', 92, 216, 1000, 92, {
      fontSize: 76, fontWeight: 700, letterSpacing: -3, lineHeight: 1.04, fills: solid('#F2F2F5'),
    }, art)
    text('answer to nobody.', 92, 300, 1000, 92, {
      fontSize: 76, fontWeight: 700, letterSpacing: -3, lineHeight: 1.04,
      fills: grad('#15EAD6', '#A322E0', { x: 0, y: 0 }, { x: 1, y: 0 }),
    }, art)
    text('Local-first vector design for Windows, macOS and Linux.', 92, 420, 760, 36, {
      fontSize: 22, lineHeight: 1.45, fills: solid('#9C9CAA'),
    }, art)

    rect('CTA', 1180, 396, 328, 62, { cornerRadius: radius(16), fills: solid('#F2F2F5') }, art)
    text('Download free', 1252, 414, 200, 28, { fontSize: 19, fontWeight: 600, fills: solid('#0C0C0E') }, art)
    text('MIT · no account · works offline', 1180, 486, 340, 26, {
      fontSize: 14, letterSpacing: 0.3, fills: solid('#8A8A98'),
    }, art)
    return art`,
  },

  {
    key: '05-poster',
    w: 1000,
    h: 1400,
    label: 'Poster',
    caption: 'Print-shaped and type-led, because vectors were never only for screens.',
    build: String.raw`
    const art = frame('Poster — A-series', 0, 0, 1000, 1400, { fills: solid('#0C0C0E') })
    // Structural grid, left visible on purpose — the poster is about the grid.
    for (let i = 1; i < 6; i++) rect('Column', i * 166, 0, 1, 1400, { fills: solid('#FFFFFF', 0.07) }, art)
    rect('Rule', 80, 150, 840, 1, { fills: solid('#FFFFFF', 0.22) }, art)
    rect('Rule', 80, 1268, 840, 1, { fills: solid('#FFFFFF', 0.22) }, art)

    text('POLYFORM', 80, 104, 400, 34, { fontSize: 17, fontWeight: 600, letterSpacing: 5.5, fills: solid('#C9C9D6') }, art)
    text('MMXXVI', 700, 104, 220, 34, {
      fontSize: 17, fontWeight: 600, letterSpacing: 5.5, textAlignH: 'RIGHT', fills: solid('#7C7C8A'),
    }, art)

    // The shape cluster is bounded ABOVE the type block on purpose: at 126px
    // with a 1.0 line height, three lines occupy 378px, and the first pass put
    // the last line through both the footer rule and the footer text.
    add(base('ELLIPSE', 'Ring', 300, 270, 520, 520, {
      fills: [], strokes: grad('#15EAD6', '#A322E0', { x: 0, y: 0 }, { x: 1, y: 1 }), strokeWeight: 2, strokeAlign: 'CENTER',
    }), art)
    add(base('ELLIPSE', 'Disc', 150, 430, 430, 430, {
      fills: grad('#15EAD6', '#6C74E8', { x: 0, y: 0 }, { x: 1, y: 1 }), opacity: 0.92,
    }), art)
    add(base('ELLIPSE', 'Arc', 470, 220, 380, 380, {
      fills: grad('#A322E0', '#6C74E8'), arcStart: 0.12, arcSweep: 0.46, arcRatio: 0.55, opacity: 0.95,
    }), art)

    text('VECTOR', 80, 894, 840, 140, { fontSize: 126, fontWeight: 700, letterSpacing: -4, lineHeight: 1, fills: solid('#F2F2F5') }, art)
    text('ON YOUR', 80, 1004, 840, 140, { fontSize: 126, fontWeight: 700, letterSpacing: -4, lineHeight: 1, fills: solid('#F2F2F5') }, art)
    text('OWN DISK', 80, 1114, 840, 140, {
      fontSize: 126, fontWeight: 700, letterSpacing: -4, lineHeight: 1,
      fills: grad('#15EAD6', '#A322E0', { x: 0, y: 0 }, { x: 1, y: 0 }),
    }, art)

    text('AN OPEN-SOURCE DESIGN TOOL', 80, 1300, 520, 30, { fontSize: 15, fontWeight: 600, letterSpacing: 3, fills: solid('#8A8A98') }, art)
    text('MIT', 700, 1300, 220, 30, {
      fontSize: 15, fontWeight: 600, letterSpacing: 3, textAlignH: 'RIGHT', fills: solid('#8A8A98'),
    }, art)
    return art`,
  },
]

/** Empty the page, so one piece cannot inherit the last one's shapes. */
const CLEAR = String.raw`(() => {
  const P = globalThis.__polyform
  const s = P.documentStore.scene
  for (const id of [...s.rootIds()]) s.removeNode(id)
  P.editor.set({ selection: [], vectorSelection: [] })
  P.documentStore.emit()
  return s.rootIds().length
})()`

/**
 * Fit one artboard on screen and report where it landed, in window
 * coordinates, so the capture can clip to the artwork alone.
 *
 * Clipping to the artboard rather than hiding the UI is what makes these read
 * as artwork instead of screenshots: the frame's name label, the rulers and
 * the panels all live outside this rectangle by construction.
 */
const framePiece = (w, h) => String.raw`(() => {
  const P = globalThis.__polyform
  const { viewportSize } = P.editor.get()
  const zoom = Math.min((viewportSize.w - 48) / ${w}, (viewportSize.h - 48) / ${h})
  P.editor.set({
    selection: [],
    camera: { x: ${w} / 2 - viewportSize.w / (2 * zoom), y: ${h} / 2 - viewportSize.h / (2 * zoom), zoom },
  })
  const cam = P.editor.get().camera
  const a = P.overlays.worldToScreen(cam, { x: 0, y: 0 })
  const b = P.overlays.worldToScreen(cam, { x: ${w}, y: ${h} })
  const r = document.querySelector('canvas').getBoundingClientRect()
  return JSON.stringify({
    zoom,
    x: a.x + r.left, y: a.y + r.top,
    width: b.x - a.x, height: b.y - a.y,
    fits: a.x >= -0.5 && a.y >= -0.5 && b.x <= r.width + 0.5 && b.y <= r.height + 0.5,
  })
})()`

// ---------------------------------------------------------------------------
// The social card and the touch icon.
//
// Rendered by handing the debugger a document rather than navigating to one:
// Page.setDocumentContent replaces the page in place, which keeps this working
// regardless of what the app's own navigation policy allows. The font is
// inlined as base64 for the same reason a data: URI is used for the mark —
// the page has no origin to resolve anything relative against.
// ---------------------------------------------------------------------------
function brandPage({ width, height, body, css }) {
  const font = fs.readFileSync(path.join(ROOT, 'site', 'src', 'fonts', 'inter-latin-var.woff2')).toString('base64')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:Inter;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:400 800}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${width}px;height:${height}px;overflow:hidden}
    body{background:#0e0e10;color:#e6e6e6;font-family:Inter,sans-serif;-webkit-font-smoothing:antialiased}
    ${css}
  </style></head><body>${body}</body></html>`
}

const MARK_PATH =
  'M 624 315.41 L 824.59 315.41 A 80 80 0 0 1 904.59 395.41 L 904.59 1651.09 A 80 80 0 0 1 824.59 1731.09 ' +
  'L 624 1731.09 A 80 80 0 0 1 544 1651.09 L 544 395.41 A 80 80 0 0 1 624 315.41 Z M 1007.32 315 L 1193.89 315 ' +
  'L 1193.89 656.95 L 1007.32 656.95 A 80 80 0 0 1 927.32 576.95 L 927.32 395 A 80 80 0 0 1 1007.32 315 Z ' +
  'M 1002.32 956.05 L 1193.32 956.05 L 1193.32 1297.94 L 1002.32 1297.94 A 80 80 0 0 1 922.32 1217.94 ' +
  'L 922.32 1036.05 A 80 80 0 0 1 1002.32 956.05 Z M 1190.9 315.11 A 496.58 491.41 0 0 1 1190.9 1297.92 ' +
  'L 1190.9 954.92 A 149.97 148.4 0 0 0 1190.9 658.11 Z'

const markSvg = (size) => `<svg viewBox="407.69 315 1416.09 1416.09" width="${size}" height="${size}">
  <defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="864.17" y1="315" x2="1230.09" y2="1731.09">
    <stop offset="0" stop-color="#15EAD6"/><stop offset=".34" stop-color="#35C8E4"/>
    <stop offset=".68" stop-color="#6C74E8"/><stop offset="1" stop-color="#A322E0"/>
  </linearGradient></defs><path fill="url(#g)" d="${MARK_PATH}"/></svg>`

const OG_PAGE = brandPage({
  width: 1200,
  height: 630,
  css: `
    body{display:flex;flex-direction:column;justify-content:center;padding:0 82px;position:relative}
    .glow{position:absolute;inset:-40% -10% auto -10%;height:150%;filter:blur(120px);opacity:.34;
      background:radial-gradient(closest-side at 22% 45%,#15EAD6,transparent 70%),
                 radial-gradient(closest-side at 72% 30%,#A322E0,transparent 70%)}
    .row{display:flex;align-items:center;gap:18px;position:relative}
    .row span{font-size:31px;font-weight:600;letter-spacing:-.01em}
    h1{position:relative;margin-top:38px;font-size:74px;line-height:1.06;font-weight:700;letter-spacing:-.035em}
    .grad{background:linear-gradient(100deg,#15EAD6,#35C8E4 34%,#6C74E8 68%,#A322E0);
      -webkit-background-clip:text;background-clip:text;color:transparent}
    p{position:relative;margin-top:26px;font-size:26px;line-height:1.5;color:#9a9aa2;max-width:830px}
    .feet{position:absolute;left:82px;bottom:54px;display:flex;gap:26px;font-size:20px;color:#6f6f79}
    .feet b{color:#9a9aa2;font-weight:500}`,
  body: `<div class="glow"></div>
    <div class="row">${markSvg(46)}<span>Polyform</span></div>
    <h1>Vector design that never<br>leaves <span class="grad">your machine</span>.</h1>
    <p>A free, open-source design editor for Windows, macOS and Linux. No cloud, no account — every project is a plain folder on your disk.</p>
    <div class="feet"><b>MIT licensed</b><b>Works offline</b><b>Open file format</b></div>`,
})

const ICON_PAGE = brandPage({
  width: 180,
  height: 180,
  css: `body{display:grid;place-items:center;background:#26292d;border-radius:40px}`,
  body: markSvg(118),
})

// ---------------------------------------------------------------------------

const electron = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', 'out/main/index.js', `--remote-debugging-port=${PORT}`],
  {
    cwd: ROOT,
    stdio: 'ignore',
    shell: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  },
)

let ws
let failed = false
const fail = (msg) => {
  console.error(`site-shots: ${msg}`)
  failed = true
}

try {
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
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate threw')
    }
    return r.result?.result?.value
  }

  await new Promise((r) => (ws.onopen = r))
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.bringToFront')

  /**
   * 1440x900 at 2x. The window itself is 1520x960, but pinning the metrics
   * means the screenshots do not change size with whatever the machine taking
   * them happens to have, and 2x is what makes the app's 12px UI text legible
   * on the website at any width.
   */
  const CSS_W = 1440
  const CSS_H = 900
  await send('Emulation.setDeviceMetricsOverride', {
    width: CSS_W,
    height: CSS_H,
    deviceScaleFactor: 2,
    mobile: false,
  })

  // clip.scale multiplies the device scale factor rather than replacing it, so
  // a clip at scale 2 under a 2x override comes out at 4x — a 520px crop
  // arriving as a 2080px file. The override is already doing the retina work;
  // the clip must stay at 1.
  const shoot = async (name, clip) => {
    const r = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    })
    const data = r.result?.data
    if (!data) return fail(`${name}: the debugger returned no image`)
    const dir =
      name === 'og' ? PUBLIC : name === 'apple-touch-icon' ? ICONS : /^\d\d-/.test(name) ? GALLERY_DIR : SHOTS
    const file = path.join(dir, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`site-shots: ${path.relative(ROOT, file)} (${Math.round(data.length * 0.75 / 1024)} KB)`)
  }

  // --- the app -------------------------------------------------------------
  for (let i = 0; i < 40 && !(await evaluate('!!globalThis.__polyform')); i++) await sleep(250)
  if (!(await evaluate('!!globalThis.__polyform'))) throw new Error('__polyform handle missing')

  await evaluate(`globalThis.__polyform.documentStore.loadFromResult({
    info: { path: 'Northwind.poly', manifest: { title: 'Northwind', name: 'Northwind', schemaVersion: 5 } },
    sceneBytes: null,
    journal: { entries: [], cursor: 0 },
  })`)
  await evaluate(`globalThis.__polyform.editor.set({ hasProject: true })`)
  await sleep(700)

  const built = JSON.parse(await evaluate(BUILD_DOC))
  console.log(`site-shots: built ${built.nodes} nodes`)
  await sleep(400)
  const framed = JSON.parse(await evaluate(FRAME_ALL))
  console.log(`site-shots: canvas ${framed.viewportSize.w}x${framed.viewportSize.h} @ ${framed.zoom.toFixed(3)}x`)

  // Select something so the inspector has content in it — an editor screenshot
  // with an empty right-hand panel looks like an editor nobody is using. It
  // has to be something ON SCREEN: selecting the off-canvas Palette filled the
  // inspector while the canvas showed no selection at all, which reads as a
  // bug. The bar group also gives the Selection colors list its gradients.
  await evaluate(`globalThis.__polyform.editor.set({ selection: ['${built.bars}'] })`)
  await sleep(1200)

  await shoot('hero')

  // Where the panels are, so the crops below follow the app instead of
  // guessing at pixel offsets that change the next time a panel is resized.
  const panels = JSON.parse(
    await evaluate(`(() => {
      const box = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      }
      return JSON.stringify({
        canvas: box('canvas'),
        left: box('[data-panel="left"]') ?? box('aside'),
        right: box('[data-panel="right"]'),
        w: innerWidth, h: innerHeight,
      })
    })()`),
  )
  console.log('site-shots: panels', JSON.stringify(panels))

  // 16:10 crops for the feature cards. The canvas ones are fractions of the
  // measured canvas box rather than absolute pixels, so resizing a side panel
  // moves the crop with the artwork instead of sliding it off.
  const crop16x10 = (x, y, width) => ({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round((width * 10) / 16),
  })
  if (panels.canvas) {
    const c = panels.canvas
    // The chart and the donut: gradients, a drop shadow and an arc ellipse,
    // which is exactly what the card beside it on the website claims.
    await shoot('shot-canvas', crop16x10(c.x + c.width * 0.17, c.y + c.height * 0.34, c.width * 0.74))
  }
  // Panel plus the artwork it is describing — a panel alone is a screenshot of
  // a sidebar, and says nothing about what it is attached to.
  await shoot('shot-inspector', crop16x10(CSS_W - 392, 48, 392))
  await shoot('shot-layers', crop16x10(0, 48, 460))

  // --- the gallery ---------------------------------------------------------
  for (const piece of GALLERY) {
    await evaluate(CLEAR)
    await sleep(150)
    const made = await evaluate(`(() => {\n${HELPERS}\n${piece.build}\n})()`)
    if (!made) {
      fail(`${piece.key}: the composition built nothing`)
      continue
    }
    await evaluate('globalThis.__polyform.documentStore.emit()')
    await sleep(250)
    const box = JSON.parse(await evaluate(framePiece(piece.w, piece.h)))
    // The artboard has to be wholly on the canvas or the capture clips the
    // artwork itself — the same class of mistake that made an E2E gate aim
    // one pixel off the canvas and fail only in CI.
    if (!box.fits) fail(`${piece.key}: artboard does not fit the canvas at ${box.zoom.toFixed(3)}x`)
    await sleep(500)
    await shoot(piece.key, {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    })
  }

  // --- the social card and the icon ----------------------------------------
  const { result: tree } = await send('Page.getFrameTree')
  const frameId = tree?.frameTree?.frame?.id
  if (!frameId) {
    fail('no frame id — skipped og.png and apple-touch-icon.png')
  } else {
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false })
    await send('Page.setDocumentContent', { frameId, html: OG_PAGE })
    await sleep(600)
    await shoot('og')

    await send('Emulation.setDeviceMetricsOverride', { width: 180, height: 180, deviceScaleFactor: 1, mobile: false })
    await send('Page.setDocumentContent', { frameId, html: ICON_PAGE })
    await sleep(400)
    await shoot('apple-touch-icon')
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
} finally {
  try {
    ws?.close()
  } catch {
    /* already gone */
  }
  electron.kill()
  await killElectronMatching('out/main/index.js')
}

process.exitCode = failed ? 1 : 0
