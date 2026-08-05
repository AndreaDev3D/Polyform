// Update checking against the GitHub Releases of AndreaDev3D/Polyform.
//
// It NOTIFIES; it does not install. That is not timidity, it is F-10: an
// auto-updater is a remote-code-execution channel by design, and
// electron-updater's protection against a tampered artifact is signature
// verification — which needs signed packages. Ours are not signed yet (Roadmap
// 5.2), so there is nothing for it to verify, and downloading-then-running an
// unverifiable binary is strictly worse than telling someone a new version
// exists. So: `autoDownload = false`, and the "install it for me" path stays
// behind INSTALL_UPDATES until the certificates land. Flipping that flag is the
// last step of shipping signing, not a separate feature.
//
// On macOS this is the only correct behaviour regardless: Squirrel.Mac refuses
// to apply an unsigned update, so an install attempt would fail after the
// download rather than before it.
//
// Nothing here runs unless asked. See settings.ts for why the launch check is
// off by default.

import { BrowserWindow, app, shell } from 'electron'
import type { UpdateStatus } from '../shared/types'

/**
 * Flip to true in the same commit that adds code signing, and not before.
 * Downloading is only safe once `electron-updater` can verify what it got.
 */
const INSTALL_UPDATES = false

const RELEASES_URL = 'https://github.com/AndreaDev3D/Polyform/releases/latest'

let checking = false
let lastStatus: UpdateStatus = { state: 'idle' }

function push(status: UpdateStatus): void {
  lastStatus = status
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', status)
  }
}

export function updateStatus(): UpdateStatus {
  return lastStatus
}

export function openReleasesPage(): void {
  void shell.openExternal(RELEASES_URL)
}

/**
 * @param manual A manual check reports "you are up to date" and reports errors;
 *   a launch check stays quiet unless there is something to say, because a
 *   failed network call on startup is not news.
 */
export async function checkForUpdates(manual: boolean): Promise<UpdateStatus> {
  // Unpackaged runs have no app-update.yml, and electron-updater throws rather
  // than shrugging. Nothing to check from source anyway.
  if (!app.isPackaged) {
    const status: UpdateStatus = {
      state: 'unsupported',
      message: 'Update checks only work in an installed build.',
    }
    if (manual) push(status)
    return status
  }
  if (checking) return lastStatus
  checking = true
  push({ state: 'checking' })
  try {
    // Imported lazily: it reads app-update.yml at module scope in some versions,
    // and a CLI run should not pay for it or fail on it.
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = INSTALL_UPDATES
    autoUpdater.autoInstallOnAppQuit = INSTALL_UPDATES
    autoUpdater.allowPrerelease = false
    // A downgrade is an attack, not an update (F-10).
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = null

    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version ?? null
    if (version && version !== app.getVersion()) {
      const status: UpdateStatus = {
        state: 'available',
        version,
        url: RELEASES_URL,
        // Said plainly in the UI: this is why there is a link instead of a
        // progress bar.
        message: INSTALL_UPDATES
          ? `Polyform ${version} is available.`
          : `Polyform ${version} is available. Downloads are not signed yet, so Polyform will not install it for you — open the release page to get it.`,
      }
      push(status)
      return status
    }
    const status: UpdateStatus = { state: 'current', version: app.getVersion() }
    if (manual) push(status)
    else lastStatus = status
    return status
  } catch (err) {
    const status: UpdateStatus = { state: 'error', message: String((err as Error)?.message ?? err) }
    if (manual) push(status)
    else lastStatus = status
    return status
  } finally {
    checking = false
  }
}
