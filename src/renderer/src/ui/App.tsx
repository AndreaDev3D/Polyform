// Application shell: menu/shortcut wiring, autosave, close handling, layout.

import { useEffect } from 'react'
import { useEditor } from '../state/editor'
import { documentStore, useDocVersion } from '../state/document'
import { dispatchMenuAction } from '../state/actions'
import { flushSave, installAutosave } from '../state/autosave'
import { listSystemFontFamilies } from '../engine/fonts'
import { installShortcuts } from './shortcuts'
import { TopBar } from './TopBar'
import { BottomBar } from './BottomBar'
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
      void flushSave().finally(() => window.polyform.confirmClose())
    })
    const offShortcuts = installShortcuts()

    void listSystemFontFamilies().then((fonts) => useEditor.getState().setFonts(fonts))

    const offAutosave = installAutosave()

    return () => {
      offMenu()
      offClose()
      offShortcuts()
      offAutosave()
    }
  }, [])

  if (!hasProject) {
    return <WelcomeScreen />
  }

  return (
    <div className="flex flex-col h-full">
      <TopBar />
      <div className="flex flex-1 min-h-0">
        <LayersPanel />
        <div className="flex-1 min-w-0 relative">
          <CanvasView />
        </div>
        <Inspector />
      </div>
      {/* Tools, the agent and the zoom controls live on their own row now, so
       * nothing floats over the canvas and the zoom sits next to what it
       * zooms. The status line stays the thinnest thing on screen. */}
      <BottomBar />
      <StatusBar />
      <ContextMenu />
      <HistoryModal />
      <AgentModal />
    </div>
  )
}
