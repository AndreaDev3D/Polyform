// First-run screen: create/open a project, and pick up where you left off.
//
// Recent projects are cards carrying the preview each save already writes
// into the bundle (thumbnail.png), because "which of these is my poster" is
// answered by a picture far faster than by a filename.

import { useEffect, useRef, useState } from 'react'
import type { RecentEntry } from '../../../shared/types'
import { newProjectFlow, openProjectFlow } from '../state/actions'
import { FolderIcon, PlusIcon, PolyformMark } from './icons'
import { useTitlebarGeometry } from './titlebar'
import { UpdateBadge, UpdatePanel, useUpdate } from './Updates'

/** Blob URLs for the previews, loaded lazily and revoked on unmount. */
function useThumbnails(recents: RecentEntry[]): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map())
  const owned = useRef<string[]>([])

  useEffect(() => {
    let live = true
    void (async () => {
      for (const r of recents) {
        const bytes = await window.polyform.recentsThumbnail(r.path)
        if (!live) return
        if (!bytes || bytes.byteLength === 0) continue
        const buf = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }))
        owned.current.push(url)
        setUrls((prev) => new Map(prev).set(r.path, url))
      }
    })()
    return () => {
      live = false
    }
  }, [recents])

  // Revoke once, on unmount: the screen is replaced wholesale when a project
  // opens, and leaked blob URLs pin the decoded bitmaps for the session.
  useEffect(() => {
    return () => {
      for (const url of owned.current) URL.revokeObjectURL(url)
      owned.current = []
    }
  }, [])

  return urls
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Directory holding the bundle — the useful half of a long path. */
function parentDir(bundlePath: string): string {
  const parts = bundlePath.split(/[\\/]/)
  parts.pop()
  return parts.slice(-2).join('/') || bundlePath
}

export function WelcomeScreen() {
  const [recents, setRecents] = useState<RecentEntry[]>([])
  const [version, setVersion] = useState('')
  const update = useUpdate()
  const thumbs = useThumbnails(recents)
  const { height: titlebarHeight, inset: titlebarInset } = useTitlebarGeometry()
  const mod = window.polyform.platform === 'darwin' ? '⌘' : 'Ctrl'

  useEffect(() => {
    void window.polyform.recentsList().then(setRecents)
    void window.polyform.appVersion().then(setVersion)
  }, [])

  return (
    <div className="pf-welcome h-full flex flex-col">
      {/* This screen has no title bar of its own, and a frameless window with
          no drag region cannot be moved at all. Reserve the same strip the
          title bar occupies elsewhere. */}
      {/* The reserved strip is not decoration any more: the badge lives here, to
          the left of the OS window buttons, exactly where it sits once a project
          is open (TopBar). Padded by the OS-reported inset so it never lands
          under the controls. */}
      <div
        className="pf-drag shrink-0 flex items-center justify-end"
        style={{ height: titlebarHeight, paddingRight: titlebarInset + 8 }}
      >
        <UpdateBadge model={update} />
      </div>
      <div className="flex-1 overflow-y-auto">
      {/* Centred vertically while the content is short, top-aligned and
          scrolling once the recents grid outgrows the window. */}
      <div className="min-h-full flex items-center justify-center px-10 pb-14 pt-4">
        <div className="w-full max-w-[1120px] flex flex-col lg:flex-row gap-12">
        {/* Identity + the two things you can do from here. */}
        <div className="lg:w-[300px] shrink-0">
          <div className="flex items-center gap-2.5 mb-5">
            <PolyformMark size={30} className="shrink-0" />
            <h1 className="text-2xl font-semibold tracking-tight text-white">Polyform</h1>
            {version && (
              <span className="text-[11px] text-[var(--pf-text-dim)] self-end pb-1">v{version}</span>
            )}
          </div>
          <p className="text-[13px] leading-relaxed text-[var(--pf-text-dim)] mb-7">
            Local-first vector design. Every project is a plain folder on disk — no cloud, no
            account, nothing phoning home.
          </p>

          <div className="flex flex-col gap-2 mb-8">
            <button
              className="pf-welcome-action bg-[var(--pf-accent-solid)] text-white hover:bg-[var(--pf-accent-solid-hover)]"
              onClick={() => void newProjectFlow()}
            >
              <PlusIcon />
              New project
              <kbd className="pf-kbd ml-auto">{mod} N</kbd>
            </button>
            <button
              className="pf-welcome-action bg-[var(--pf-bg-2)] text-white hover:bg-[var(--pf-bg-3)]"
              onClick={() => void openProjectFlow()}
            >
              <FolderIcon />
              Open project…
              <kbd className="pf-kbd ml-auto">{mod} O</kbd>
            </button>
          </div>

          <div className="text-[11px] leading-relaxed text-[var(--pf-text-dim)] border-t border-[var(--pf-border)] pt-4">
            Saves are atomic and every edit is journalled, so history survives closing the app.
          </div>

          {/* Updates live here rather than in a settings panel, because this is
              the screen you are on just after installing. The panel owns its own
              state and preferences (ui/Updates.tsx) so the title-bar badge and
              this cannot disagree about what was found. */}
          <div className="mt-4">
            <UpdatePanel model={update} version={version ? `v${version}` : ''} />
          </div>
        </div>

        {/* Recents. */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 mb-3">
            <h2 className="text-[11px] uppercase tracking-wider text-[var(--pf-text-dim)]">Recent</h2>
            {recents.length > 0 && (
              <span className="text-[11px] text-[var(--pf-text-dim)] tabular-nums">
                {recents.length}
              </span>
            )}
          </div>

          {recents.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--pf-border)] px-6 py-12 text-center">
              <div className="text-sm text-white mb-1">Nothing here yet</div>
              <p className="text-[12px] text-[var(--pf-text-dim)] max-w-80 mx-auto leading-relaxed">
                Projects you open will show up here with a preview of the canvas.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
              {recents.map((r) => {
                const url = thumbs.get(r.path)
                return (
                  <button
                    key={r.path}
                    className="pf-project-card group text-left"
                    title={r.path}
                    onClick={() => void openProjectFlow(r.path)}
                  >
                    <div className="pf-project-thumb">
                      {url ? (
                        <>
                          {/* A blurred copy fills the card, so a 9:16 poster
                              is not a narrow strip in a sea of grey — while
                              the sharp copy still shows the whole document. */}
                          <img src={url} alt="" aria-hidden="true" className="pf-thumb-wash" />
                          <img src={url} alt="" className="pf-thumb-fit" />
                        </>
                      ) : (
                        <span className="text-[11px] text-[var(--pf-text-dim)]">No preview yet</span>
                      )}
                    </div>
                    <div className="px-2.5 py-2">
                      <div className="text-[13px] text-white truncate">{r.title}</div>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <span className="text-[10.5px] text-[var(--pf-text-dim)] truncate">
                          {parentDir(r.path)}
                        </span>
                        <span className="text-[10.5px] text-[var(--pf-text-dim)] shrink-0">
                          {relativeTime(r.openedAt)}
                        </span>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
