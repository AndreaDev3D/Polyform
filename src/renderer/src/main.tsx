import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import { initWasmEngine } from './engine/backend'
import { installFontLoader } from './ui/fontloader'
import './styles.css'

// Load the Rust/WASM engine core in the background; engine modules stay on
// their TS implementations until it resolves (and forever if it fails).
// The font loader resolves the shaping engine's font-byte requests from
// queryLocalFonts once the engine is up (Sprint E).
void initWasmEngine().then((ok) => {
  if (ok) installFontLoader()
})

// GPU/Canvas2D parity + perf harness (POLYFORM_RENDER_TEST=1).
const bootParams = new URLSearchParams(window.location.search)
if (bootParams.has('renderTest')) {
  void import('./dev/render-test').then((m) => m.runRenderTest())
}
if (bootParams.has('gpu')) {
  void import('./state/editor').then((m) => m.editor.get().setGpuRender(true))
}
// Background-removal inference harness (POLYFORM_BG_TEST=1).
if (bootParams.has('bgTest')) {
  void import('./dev/bg-test').then((m) => m.runBgTest())
}
// v0.5 spike 6.1 offscreen 3D prototype (POLYFORM_3D_TEST=1).
if (bootParams.has('m3dTest')) {
  void import('./dev/model3d-test').then((m) => m.runModel3dTest())
}

// Agent bridge (v0.6 spike 7.1): answers MCP tool calls from the live
// document. Installing the listener is inert until the user starts the
// server from the app.
void import('./agent/bridge').then((m) => m.installAgentBridge())
void import('./agent/status').then((m) => {
  m.installAgentStatus()
  // Read-only peek at the endpoint state for `npm run test:mcp`. Gated on
  // the harness flag because the status carries the session token, and a
  // plugin sharing this realm must not be able to lift it (F-15 × F-20).
  if (bootParams.has('agentTest')) {
    ;(globalThis as Record<string, unknown>).__polyformAgentStatus = m.mcpStatusNow
  }
})

// Debug/automation handle (local desktop app; also used by dev tooling).
void Promise.all([
  import('./state/document'),
  import('./state/editor'),
  import('./interactions/controller'),
]).then(([d, e, i]) => {
  ;(globalThis as Record<string, unknown>).__polyform = {
    documentStore: d.documentStore,
    editor: e.editor,
    interactionController: i.interactionController,
  }
})

// No StrictMode: its dev-only effect double-invocation would fire the
// TextEditOverlay's commit-on-unmount during mount, instantly closing (and
// for new nodes, deleting) every text edit session. App state lives in
// external stores, so StrictMode's re-render checks add little here.
const root = document.getElementById('root')!
createRoot(root).render(<App />)
