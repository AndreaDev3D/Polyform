// Update UI: one state machine, two surfaces.
//
// `useUpdate()` owns the state so the header badge and the welcome panel cannot
// disagree — a check started from either place lands in both. The main process
// pushes every transition (`update:status`), and a window that opened *after* a
// check asks for the current one, because a badge that misses the launch check
// would sit blank while an update waits.
//
// What the surfaces are for:
//
//   * `UpdateBadge` — in the title bar, and SILENT unless there is something to
//     act on. A permanent "up to date" chip is noise; the whole point of a badge is
//     that its presence is the message.
//   * `UpdatePanel` — on the welcome screen, where the preferences live and where
//     "nothing to do" is worth saying out loud.
//
// Downloading is user-initiated (or opted into) and the panel says the download is
// unsigned on the same line as the button, because that is the honest place for it
// (F-10). macOS cannot install an unsigned update at all, so `canInstall` turns the
// button into "Open release page" rather than a promise the platform will refuse.

import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../../shared/types'
import { DownloadIcon, RestartIcon } from './icons'

export interface UpdateModel {
  status: UpdateStatus
  busy: boolean
  check: () => Promise<void>
  act: () => Promise<void>
  /** Label for the one action that makes sense in this state, or null. */
  actionLabel: string | null
}

const EMPTY: UpdateStatus = { state: 'idle' }

export function useUpdate(): UpdateModel {
  const [status, setStatus] = useState<UpdateStatus>(EMPTY)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.polyform.updateStatusNow().then((s) => {
      // Do not clobber a fresher status that arrived while this promise was in
      // flight — the IPC round trip is slower than a push.
      setStatus((prev) => (prev.state === 'idle' ? s : prev))
    })
    return window.polyform.onUpdateStatus(setStatus)
  }, [])

  const check = async () => {
    setBusy(true)
    try {
      setStatus(await window.polyform.checkUpdates())
    } finally {
      setBusy(false)
    }
  }

  const act = async () => {
    if (status.state === 'available') {
      // On a platform that cannot apply an update, main opens the release page and
      // leaves the status alone; either way the answer comes back as a status.
      setBusy(true)
      try {
        setStatus(await window.polyform.downloadUpdate())
      } finally {
        setBusy(false)
      }
      return
    }
    if (status.state === 'downloaded') {
      await window.polyform.installUpdate()
      return
    }
    if (status.state === 'error' || status.state === 'current') await check()
  }

  const actionLabel =
    status.state === 'available'
      ? status.canInstall === false
        ? 'Open release page'
        : 'Download and install'
      : status.state === 'downloaded'
        ? 'Restart to install'
        : null

  return { status, busy, check, act, actionLabel }
}

const rate = (bytesPerSecond?: number): string => {
  if (!bytesPerSecond || bytesPerSecond <= 0) return ''
  const mb = bytesPerSecond / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bytesPerSecond / 1024)} KB/s`
}

// ---------------------------------------------------------------------------
// The title-bar badge
// ---------------------------------------------------------------------------

/**
 * Shown only when there is an update to act on. `pf-nodrag` because it lives
 * inside the window's drag region, where a button without it is only draggable.
 */
export function UpdateBadge({ model }: { model: UpdateModel }) {
  const { status, act } = model
  const version = status.version ? `v${status.version}` : ''

  if (status.state === 'available') {
    return (
      <button
        className="pf-update-badge pf-nodrag"
        onClick={() => void act()}
        title={status.message ?? `Polyform ${version} is available`}
      >
        <DownloadIcon width={13} height={13} />
        <span>Update {version}</span>
      </button>
    )
  }
  if (status.state === 'downloading') {
    const percent = status.percent ?? 0
    return (
      <div className="pf-update-badge pf-update-badge--progress pf-nodrag" title={`Downloading ${version}`}>
        {/* The fill is the progress bar: no separate element to keep in sync. */}
        <span className="pf-update-badge-fill" style={{ width: `${percent}%` }} aria-hidden />
        <span className="relative tabular-nums">Downloading {percent}%</span>
      </div>
    )
  }
  if (status.state === 'downloaded') {
    return (
      <button
        className="pf-update-badge pf-update-badge--ready pf-nodrag"
        onClick={() => void act()}
        title={status.message ?? `Polyform ${version} is ready to install`}
      >
        <RestartIcon width={13} height={13} />
        <span>Restart to update</span>
      </button>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// The welcome-screen panel
// ---------------------------------------------------------------------------

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}) {
  return (
    <label className="pf-update-toggle" title={hint}>
      <input
        type="checkbox"
        className="accent-[var(--pf-accent-solid)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

export function UpdatePanel({ model, version }: { model: UpdateModel; version: string }) {
  const { status, busy, check, act, actionLabel } = model
  const [onLaunch, setOnLaunch] = useState(false)
  const [beta, setBeta] = useState(false)
  const [autoInstall, setAutoInstall] = useState(false)

  useEffect(() => {
    void window.polyform.updateOnLaunch().then(setOnLaunch)
    void window.polyform.updateBeta().then(setBeta)
    void window.polyform.updateAutoInstall().then(setAutoInstall)
  }, [])

  // One line, in the voice of the state it describes.
  const line = (() => {
    switch (status.state) {
      case 'checking':
        return 'Checking for updates…'
      case 'available':
        return `${status.version}${status.beta ? ' (beta)' : ''} is available.`
      case 'downloading':
        return `Downloading ${status.version}${status.beta ? ' (beta)' : ''}… ${rate(status.bytesPerSecond)}`
      case 'downloaded':
        return `${status.version} is ready. Polyform will restart to install it.`
      case 'current':
        return 'You have the latest version.'
      case 'unsupported':
        return 'Update checks only work in an installed build.'
      case 'error':
        return status.message ?? 'Could not check for updates.'
      default:
        return 'Not checked yet.'
    }
  })()

  const percent = status.percent ?? 0

  return (
    <section className="pf-update-panel">
      <header className="pf-update-panel-head">
        <span className="text-[var(--pf-text)] font-medium">Updates</span>
        <span className="tabular-nums">{version}</span>
      </header>

      <p className={status.state === 'error' ? 'pf-update-line pf-update-line--warn' : 'pf-update-line'}>{line}</p>

      {status.state === 'downloading' && (
        <div className="pf-update-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${percent}%` }} />
        </div>
      )}

      <div className="pf-update-actions">
        {actionLabel ? (
          <button className="pf-update-primary" disabled={busy} onClick={() => void act()}>
            {actionLabel}
          </button>
        ) : (
          <button className="pf-update-secondary" disabled={busy || status.state === 'checking'} onClick={() => void check()}>
            {status.state === 'checking' ? 'Checking…' : 'Check now'}
          </button>
        )}
        {(status.state === 'available' || status.state === 'downloaded') && (
          <button className="pf-update-link" onClick={() => void window.polyform.openReleases()}>
            Release notes
          </button>
        )}
        {actionLabel && status.canInstall !== false && (
          // Said next to the button rather than in a settings page: this is the
          // moment the decision is being made.
          <span className="pf-update-caveat">not code signed yet</span>
        )}
      </div>

      <div className="pf-update-toggles">
        <Toggle
          checked={onLaunch}
          onChange={(v) => {
            setOnLaunch(v)
            void window.polyform.updateOnLaunch(v)
          }}
          label="Check on launch"
          hint="Off by default: Polyform promises not to phone home, so this asks first."
        />
        <Toggle
          checked={beta}
          onChange={(v) => {
            setBeta(v)
            void window.polyform.updateBeta(v)
            if (v) void check()
          }}
          label="Include betas"
          hint="Pre-release builds, published from the staging branch on every push. Same gates as a release; no human has read them."
        />
        <Toggle
          checked={autoInstall}
          onChange={(v) => {
            setAutoInstall(v)
            void window.polyform.updateAutoInstall(v)
          }}
          label="Install automatically"
          hint="Download an update as soon as it is found and apply it when Polyform quits. Nothing is code signed yet, so there is no signature to verify — off unless you want it."
        />
      </div>
    </section>
  )
}
