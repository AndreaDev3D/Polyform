// Assets tab: local components + attached local-file libraries.

import { useEffect, useState } from 'react'
import { documentStore, useDocVersion } from '../state/document'
import {
  attachLibraryFlow,
  createInstanceOf,
  detachLibrary,
  importLibraryColorStyle,
  insertLibraryComponent,
  loadLibraryIndex,
  updateLibraryComponents,
  type LibraryIndexEntry,
} from '../state/actions'
import { listComponents } from '../engine/components'
import { ComponentIcon, PlusIcon, TrashIcon } from './icons'

export function AssetsPanel() {
  useDocVersion()
  const scene = documentStore.scene
  const components = listComponents(scene)
  const libraries = scene.doc.libraries ?? []
  const [indexes, setIndexes] = useState<Record<string, LibraryIndexEntry | null>>({})
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    for (const lib of libraries) {
      if (indexes[lib.path] === undefined) {
        setIndexes((prev) => ({ ...prev, [lib.path]: null }))
        void loadLibraryIndex(lib.path).then((entry) => {
          setIndexes((prev) => ({ ...prev, [lib.path]: entry }))
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraries.map((l) => l.path).join('|')])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-3 py-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold">Local components</span>
      </div>
      {components.length === 0 && (
        <div className="px-3 pb-2 text-[11px] text-[var(--pf-text-dim)]">
          Select layers and press Ctrl+Alt+K to create a component.
        </div>
      )}
      {components.map((c) => (
        <div key={c.id} className="group flex items-center gap-2 px-3 h-7 hover:bg-[var(--pf-bg-2)]">
          <span className="text-[#a78bfa]">
            <ComponentIcon width={12} height={12} />
          </span>
          <span className="flex-1 truncate text-[11px]">{c.name}</span>
          {c.origin && <span className="text-[9px] text-[var(--pf-text-dim)]">lib</span>}
          <button
            className="hidden group-hover:block pf-btn !py-0.5 text-[10px] bg-[var(--pf-bg-3)]"
            title="Insert an instance"
            onClick={() => createInstanceOf(c.id)}
          >
            Insert
          </button>
        </div>
      ))}

      <div className="px-3 py-2 mt-2 flex items-center justify-between border-t border-[var(--pf-border)]">
        <span className="text-[11px] font-semibold">Libraries</span>
        <button className="pf-icon-btn !w-5 !h-5" title="Attach a .poly library" onClick={() => void attachLibraryFlow()}>
          <PlusIcon width={12} height={12} />
        </button>
      </div>
      {libraries.length === 0 && (
        <div className="px-3 pb-2 text-[11px] text-[var(--pf-text-dim)]">
          Attach another .poly project to reuse its components and styles.
        </div>
      )}
      {libraries.map((lib) => {
        const index = indexes[lib.path]
        return (
          <div key={lib.path} className="mb-2">
            <div className="group flex items-center gap-2 px-3 h-7">
              <span className="flex-1 truncate text-[11px] font-medium">{lib.name}</span>
              <button
                className="hidden group-hover:block pf-btn !py-0.5 text-[10px] bg-[var(--pf-bg-3)]"
                title="Re-read the library file and update imported components"
                disabled={busy === lib.path}
                onClick={() => {
                  setBusy(lib.path)
                  void updateLibraryComponents(lib.path)
                    .then((n) => {
                      void loadLibraryIndex(lib.path, true).then((entry) =>
                        setIndexes((prev) => ({ ...prev, [lib.path]: entry })),
                      )
                      window.alert(n > 0 ? `Updated ${n} component(s) from "${lib.name}".` : 'No imported components to update.')
                    })
                    .finally(() => setBusy(null))
                }}
              >
                {busy === lib.path ? '…' : 'Update'}
              </button>
              <button
                className="hidden group-hover:block pf-icon-btn !w-5 !h-5"
                title="Detach library"
                onClick={() => detachLibrary(lib.path)}
              >
                <TrashIcon width={11} height={11} />
              </button>
            </div>
            {index === null && <div className="px-3 text-[10px] text-[var(--pf-text-dim)]">Loading…</div>}
            {index === undefined && null}
            {index &&
              index.components.map((c) => (
                <div key={c.id} className="group flex items-center gap-2 pl-6 pr-3 h-6 hover:bg-[var(--pf-bg-2)]">
                  <span className="text-[#a78bfa]">
                    <ComponentIcon width={11} height={11} />
                  </span>
                  <span className="flex-1 truncate text-[11px]">{c.name}</span>
                  <button
                    className="hidden group-hover:block pf-btn !py-0.5 text-[10px] bg-[var(--pf-bg-3)]"
                    onClick={() => void insertLibraryComponent(lib.path, c.id)}
                  >
                    Insert
                  </button>
                </div>
              ))}
            {index && index.colorStyles.length > 0 && (
              <div className="pl-6 pr-3 py-1">
                <span className="text-[10px] text-[var(--pf-text-dim)]">Styles: </span>
                {index.colorStyles.map((s) => (
                  <button
                    key={s.id}
                    className="text-[10px] text-[var(--pf-accent)] hover:underline mr-2"
                    title="Import color style"
                    onClick={() => void importLibraryColorStyle(lib.path, s.id)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
            {index === null && null}
          </div>
        )
      })}
    </div>
  )
}
