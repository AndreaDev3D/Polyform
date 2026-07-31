import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import './styles.css'

// No StrictMode: its dev-only effect double-invocation would fire the
// TextEditOverlay's commit-on-unmount during mount, instantly closing (and
// for new nodes, deleting) every text edit session. App state lives in
// external stores, so StrictMode's re-render checks add little here.
const root = document.getElementById('root')!
createRoot(root).render(<App />)
