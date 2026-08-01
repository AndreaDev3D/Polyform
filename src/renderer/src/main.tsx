import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import { initWasmEngine } from './engine/backend'
import './styles.css'

// Load the Rust/WASM engine core in the background; engine modules stay on
// their TS implementations until it resolves (and forever if it fails).
void initWasmEngine()

// No StrictMode: its dev-only effect double-invocation would fire the
// TextEditOverlay's commit-on-unmount during mount, instantly closing (and
// for new nodes, deleting) every text edit session. App state lives in
// external stores, so StrictMode's re-render checks add little here.
const root = document.getElementById('root')!
createRoot(root).render(<App />)
