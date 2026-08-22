import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import { initWasmEngine } from './engine/backend'
import { installFontLoader } from './ui/fontloader'
import { registerBuiltins } from './engine/materials/builtins'
import './styles.css'

// The shaders the app ships. Registered before anything can render or the
// Inspector can list them; project shaders join at project open.
registerBuiltins()

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

// Headless CLI boot (7.4): open the bundle the CLI was pointed at through
// the normal project-open path, then tell main the bridge can be driven.
if (bootParams.has('cli')) {
  void Promise.all([
    import('./state/document'),
    import('./state/editor'),
    // The bridge has to be in this list, not just started above.
    //
    // It is what ANSWERS the CLI's queries, and it registers its ipcRenderer
    // listener inside its own dynamic import. Signalling ready from a different
    // async chain meant the two raced: main sends `mcp:sceneRequest` the moment
    // it hears `cli:ready`, and an IPC message with no listener yet is dropped
    // with no retry — so the query waited out its entire timeout and failed as
    // "scene query timed out: document.summary". Whoever won the race decided
    // whether the CLI worked; it won locally and on macOS, and lost on a cold
    // Windows CI runner where opening the bundle finished before the bridge
    // chunk loaded. installAgentBridge() is idempotent by design.
    import('./agent/bridge').then((m) => m.installAgentBridge()),
  ]).then(async ([d, e]) => {
    const bundle = bootParams.get('cliBundle')
    if (bundle) {
      const viewport = await d.documentStore.openProject(bundle)
      if (viewport) e.editor.set({ hasProject: true })
    }
    window.polyform.cliReady()
  })
}
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
  import('./engine/render/overlays'),
  import('./state/actions'),
]).then(([d, e, i, o, a]) => {
  ;(globalThis as Record<string, unknown>).__polyform = {
    documentStore: d.documentStore,
    editor: e.editor,
    interactionController: i.interactionController,
    // Screen-space geometry, so harnesses can aim real pointer events at the
    // handles the user sees instead of re-deriving where they ought to be.
    overlays: o,
    // The command layer, so a harness can invoke what a menu invokes rather
    // than reimplementing it.
    actions: a,
  }
})

// No StrictMode: its dev-only effect double-invocation would fire the
// TextEditOverlay's commit-on-unmount during mount, instantly closing (and
// for new nodes, deleting) every text edit session. App state lives in
// external stores, so StrictMode's re-render checks add little here.
const root = document.getElementById('root')!
createRoot(root).render(<App />)
