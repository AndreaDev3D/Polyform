// Geometry of the OS window-controls overlay, for the custom title bar.
//
// The window is frameless (main sets titleBarStyle 'hidden'), so the app draws
// its own bar while the OS still paints the minimise/maximise/close buttons on
// top of the web content. Both numbers have to come from the OS rather than be
// guessed: the reserved width, or controls sit over our UI, and the height, or
// the buttons overhang the header onto whatever is below it.

import { useEffect, useState } from 'react'

interface WindowControlsOverlay {
  visible: boolean
  getTitlebarAreaRect: () => DOMRect
  addEventListener: (type: string, cb: () => void) => void
  removeEventListener: (type: string, cb: () => void) => void
}

export interface TitlebarGeometry {
  /** Width the window controls occupy on the right, in CSS px. */
  inset: number
  /** Height the OS gave the title bar region. */
  height: number
}

export function useTitlebarGeometry(): TitlebarGeometry {
  const isMac = window.polyform.platform === 'darwin'
  const [geo, setGeo] = useState<TitlebarGeometry>(() => ({ inset: isMac ? 0 : 138, height: 40 }))

  useEffect(() => {
    const wco = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay })
      .windowControlsOverlay
    if (!wco) return
    const read = () => {
      if (!wco.visible) return
      const r = wco.getTitlebarAreaRect()
      setGeo({
        // The titlebar area stops where the buttons begin.
        inset: Math.max(0, window.innerWidth - (r.x + r.width)),
        height: Math.max(28, Math.round(r.height)),
      })
    }
    read()
    wco.addEventListener('geometrychange', read)
    window.addEventListener('resize', read)
    return () => {
      wco.removeEventListener('geometrychange', read)
      window.removeEventListener('resize', read)
    }
  }, [])

  return geo
}
