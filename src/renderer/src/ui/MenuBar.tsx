// The app's own menu bar, for the custom title bar.
//
// It renders the SHARED menu definition and invokes the NATIVE menu item by
// id, so every command has one implementation and this stays a view. The
// native Menu is still installed (hidden) because it registers the
// accelerators — see shared/menu-def.ts.

import { useEffect, useRef, useState } from 'react'
import { MENU, formatAccelerator } from '../../../shared/menu-def'
import type { MenuItemDef } from '../../../shared/menu-def'

export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const platform = window.polyform.platform

  // Close on any outside press, Escape, or window blur — a menu left open
  // over the canvas swallows the next click.
  useEffect(() => {
    if (open === null) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    const onBlur = () => setOpen(null)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const choose = (item: MenuItemDef) => {
    setOpen(null)
    if (!item.id) return
    void window.polyform.menuInvoke(item.id).then((ok) => {
      if (!ok) console.warn(`[polyform] no native menu item "${item.id}"`)
    })
  }

  return (
    <div ref={rootRef} className="pf-nodrag flex items-center h-full" role="menubar">
      {MENU.map((menu, i) => (
        <div key={menu.label} className="relative h-full">
          <button
            className={`pf-menu-title ${open === i ? 'active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? null : i)}
            // Once one menu is open, sliding across the bar moves between them
            // — the behaviour every desktop menu has.
            onPointerEnter={() => open !== null && setOpen(i)}
          >
            {menu.label}
          </button>
          {open === i && (
            <div className="pf-menu-panel pf-fade-in" role="menu">
              {menu.items.map((item, k) =>
                item.separator ? (
                  <div key={`sep-${k}`} className="pf-menu-sep" />
                ) : (
                  <button key={item.id ?? k} className="pf-menu-item" role="menuitem" onClick={() => choose(item)}>
                    <span className="truncate">{item.label}</span>
                    {item.accelerator && (
                      <span className="pf-menu-accel">{formatAccelerator(item.accelerator, platform)}</span>
                    )}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
