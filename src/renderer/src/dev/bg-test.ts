// Background-removal inference harness (v0.4.1 acceptance gates 1/3/4).
// Booted via POLYFORM_BG_TEST=1 (+ POLYFORM_BGMODEL_PATH to skip the
// download). Renders a synthetic subject (solid disc on a busy background)
// through the REAL worker + model and asserts the matte keeps the subject
// and drops the backdrop. Logs BG_TEST lines, ends with BG_TEST_DONE.

import { runBgInference } from '../ui/bgremove'

function log(msg: string): void {
  console.log(`BG_TEST ${msg}`)
}

export async function runBgTest(): Promise<void> {
  try {
    const status = await window.polyform.bgModelStatus()
    log(`model ready=${status.ready}`)
    if (!status.ready) {
      log('FATAL model missing (set POLYFORM_BGMODEL_PATH or download first)')
      log('BG_TEST_DONE result=FAIL')
      return
    }

    // Synthetic scene: warm disc subject centered on a striped cool backdrop.
    const W = 640
    const H = 480
    const canvas = new OffscreenCanvas(W, H)
    const ctx = canvas.getContext('2d')!
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = i % 2 ? '#3a7d44' : '#2c5f8a'
      ctx.fillRect((i * W) / 16, 0, W / 16, H)
    }
    ctx.fillStyle = '#e2574c'
    ctx.beginPath()
    ctx.arc(W / 2, H / 2, 120, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f0c33a'
    ctx.beginPath()
    ctx.arc(W / 2, H / 2 - 40, 45, 0, Math.PI * 2)
    ctx.fill()
    const pixels = ctx.getImageData(0, 0, W, H)

    const t0 = performance.now()
    const { png, ms, ep } = await runBgInference(W, H, pixels.data.buffer as ArrayBuffer)
    log(`inference ok: ${ms.toFixed(0)}ms (${ep}), total ${(performance.now() - t0).toFixed(0)}ms incl. model load`)

    // Decode the cutout and probe alphas.
    const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }))
    const out = new OffscreenCanvas(W, H)
    const octx = out.getContext('2d')!
    octx.drawImage(bmp, 0, 0)
    const data = octx.getImageData(0, 0, W, H).data
    const alphaAt = (x: number, y: number) => data[(y * W + x) * 4 + 3]
    const subject = alphaAt(W / 2, H / 2)
    const corners = [alphaAt(8, 8), alphaAt(W - 8, 8), alphaAt(8, H - 8), alphaAt(W - 8, H - 8)]
    const cornerMax = Math.max(...corners)
    log(`alpha subject=${subject} corners=[${corners.join(',')}]`)

    const pass = subject > 200 && cornerMax < 50
    log(`gates: subject>200 ${subject > 200 ? 'PASS' : 'FAIL'}; corners<50 ${cornerMax < 50 ? 'PASS' : 'FAIL'}`)
    log(`BG_TEST_DONE result=${pass ? 'PASS' : 'FAIL'}`)
  } catch (err) {
    log(`FATAL ${String(err)}`)
    log('BG_TEST_DONE result=FAIL')
  }
}
