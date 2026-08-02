// Application shell: menu/shortcut wiring, autosave, close handling, layout.

import { useEffect } from 'react'
import { useEditor } from '../state/editor'
import { documentStore, useDocVersion } from '../state/document'
import { dispatchMenuAction, saveFlow } from '../state/actions'
import { listSystemFontFamilies } from '../engine/fonts'
import { installShortcuts } from './shortcuts'
import { Toolbar } from './Toolbar'
import { LayersPanel } from './LayersPanel'
import { Inspector } from './Inspector'
import { CanvasView } from './CanvasView'
import { StatusBar } from './StatusBar'
import { WelcomeScreen } from './WelcomeScreen'
import { ContextMenu } from './ContextMenu'
import { HistoryModal } from './HistoryModal'
import { AgentModal } from './AgentModal'

export function App() {
  const hasProject = useEditor((s) => s.hasProject)
  useDocVersion()

  useEffect(() => {
    const offMenu = window.polyform.onMenuAction((id) => dispatchMenuAction(id))
    const offClose = window.polyform.onRequestClose(() => {
      // Skip the thumbnail render on quit — the close fail-safe must not
      // fire while a slow full-scene render is still running.
      void saveFlow(false).finally(() => window.polyform.confirmClose())
    })
    const offShortcuts = installShortcuts()

    void listSystemFontFamilies().then((fonts) => useEditor.getState().setFonts(fonts))

    const autosave = window.setInterval(() => {
      if (documentStore.projectInfo && documentStore.dirty && !useEditor.getState().editingTextId) {
        void saveFlow()
      }
    }, 30_000)

    return () => {
      offMenu()
      offClose()
      offShortcuts()
      window.clearInterval(autosave)
    }
  }, [])

  if (!hasProject) {
    return <WelcomeScreen />
  }

  return (
    <div className="flex flex-col h-full">
      <Toolbar />
      <div className="flex flex-1 min-h-0">
        <LayersPanel />
        <div className="flex-1 min-w-0 relative">
          <CanvasView />
        </div>
        <Inspector />
      </div>
      <StatusBar />
      <ContextMenu />
      <HistoryModal />
      <AgentModal />
    </div>
  )
}
