// Update checking, downloading and installing, against the GitHub Releases of
// AndreaDev3D/Polyform.
//
// WHAT CHANGED IN v0.8, AND WHAT DID NOT. Installing used to be off outright: with
// nothing code signed there is no signature for electron-updater to verify, and
// downloading-then-running an unverifiable binary is a remote-code-execution
// channel with a checksum in front of it (F-10, ADR-028). That reasoning has not
// improved — nothing is signed yet — so the install path is **user-initiated and
// disclosed** rather than silent by default:
//
//   * checking never installs anything;
//   * a download starts because someone pressed a button, or because they ticked
//     "install automatically" and can untick it;
//   * the UI says, on the same line as the button, that the download is unsigned.
//
// `allowDowngrade` stays off: a downgrade to a known-vulnerable version is an
// attack, not an update.
//
// MACOS CANNOT DO THIS AT ALL, and that is not our choice. Squirrel.Mac applies an
// update only if it is signed by the same team as the running app, and it needs a
// `zip` feed rather than a dmg. Ad-hoc signing (which is what a free build gets)
// fails that check *after* downloading. So on darwin the button opens the release
// page instead of pretending, and `canInstall` says so to the renderer rather than
// leaving the UI to guess from the platform.
//
// Nothing here runs unless asked. See settings.ts for why the launch check is off
// by default.

import { BrowserWindow, app, shell } from 'electron'
import type { AppUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'
import { readSettings } from './settings'

const RELEASES_URL = 'https://github.com/AndreaDev3D/Polyform/releases/latest'

/**
 * Can this platform apply an update we downloaded?
 *
 * Windows (NSIS) and Linux (AppImage/deb) can, unsigned. macOS cannot — see the
 * header. Reported to the renderer so the button can say "Download and install"
 * or "Open release page" from fact rather than from a platform check duplicated in
 * the UI.
 */
function canInstall(): boolean {
  return process.platform !== 'darwin'
}

/**
 * Where to send someone for a specific version. NOT `/releases/latest` for a
 * beta: that URL resolves to the newest *stable* release, so a beta notice would
 * link to a page that does not mention the version it just named.
 */
function releaseUrl(version: string | null): string {
  return version ? `https://github.com/AndreaDev3D/Polyform/releases/tag/v${version}` : RELEASES_URL
}

const isPrerelease = (version: string): boolean => /-(?:beta|alpha|rc)\./.test(version)

let checking = false
let lastStatus: UpdateStatus = { state: 'idle' }

function push(status: UpdateStatus): void {
  lastStatus = { canInstall: canInstall(), ...status }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:status', lastStatus)
  }
}

export function updateStatus(): UpdateStatus {
  return lastStatus
}

export function openReleasesPage(): void {
  // The page for the version we actually named, when we named one.
  void shell.openExternal(lastStatus.url ?? RELEASES_URL)
}

/**
 * electron-updater's messages describe its own plumbing, not the situation. The
 * ones users will actually hit deserve a sentence that names the cause:
 *
 * - `ERR_UPDATER_NO_PUBLISHED_VERSIONS` / "Unable to find latest version" — the
 *   repository has no *published* stable release. Reached by anyone with betas off
 *   while only pre-releases exist, and reported by the library as
 *   "Cannot parse releases feed", which sounds like corruption.
 * - `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` — the release exists but carries no update
 *   metadata. That is F-29, and if it ever comes back the message should say so
 *   rather than leave someone reading a stack trace about a yml file.
 */
function explain(err: unknown): string {
  const code = String((err as { code?: string })?.code ?? '')
  const text = String((err as Error)?.message ?? err)
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || /Unable to find latest version/i.test(text)) {
    return 'No release has been published yet, so there is nothing to update to.'
  }
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/.test(text)) {
    return 'That release is missing its update metadata, so Polyform cannot tell what it contains. Open the releases page instead.'
  }
  return text
}

// ---------------------------------------------------------------------------
// The updater instance
// ---------------------------------------------------------------------------

let instance: AppUpdater | null = null

/**
 * One updater, configured on every use, with its listeners attached once.
 *
 * It has to be a single instance now that downloading exists: `checkForUpdates`
 * leaves the resolved update on the object, and `downloadUpdate` needs the same
 * object to know what to fetch. Re-importing per call would also re-attach the
 * progress listeners and report every percentage N times.
 */
async function updater(): Promise<AppUpdater> {
  if (!instance) {
    // Imported lazily: it reads app-update.yml at module scope in some versions,
    // and a CLI run should not pay for it or fail on it.
    //
    // Resolved through BOTH shapes on purpose. `electron-updater` is CommonJS and
    // this process is ESM, so the named exports of a dynamic import come from
    // Node's CJS lexer — and it cannot see `autoUpdater`, because that one is a
    // lazy `Object.defineProperty(exports, …, { get })` that constructs the
    // platform updater on first access, not the TS re-export form the lexer
    // recognises. Every other export IS visible, which is what made this look
    // fine. Destructuring it therefore yielded `undefined` and the next line threw
    // "Cannot set properties of undefined (setting 'autoDownload')" — in the
    // packaged app only, because from source we never get past `isPackaged`
    // (F-29).
    const mod = await import('electron-updater')
    const resolved =
      mod.autoUpdater ?? (mod as unknown as { default?: { autoUpdater?: AppUpdater } }).default?.autoUpdater
    if (!resolved) {
      // Name the failure rather than throwing a TypeError one line later.
      throw new Error('electron-updater did not expose autoUpdater (module interop changed)')
    }
    instance = resolved
    instance.logger = null
    // A downgrade is an attack, not an update (F-10).
    instance.allowDowngrade = false

    instance.on('download-progress', (p) => {
      push({
        state: 'downloading',
        version: lastStatus.version,
        percent: Math.max(0, Math.min(100, Math.round(p.percent))),
        bytesPerSecond: Math.round(p.bytesPerSecond),
        beta: lastStatus.beta,
      })
    })
    instance.on('update-downloaded', (info) => {
      push({
        state: 'downloaded',
        version: info.version,
        url: releaseUrl(info.version),
        beta: isPrerelease(info.version),
        message: canInstall()
          ? `Polyform ${info.version} is ready. Restarting will install it.`
          : `Polyform ${info.version} was downloaded, but this platform cannot install it automatically.`,
      })
    })
    instance.on('error', (err) => {
      push({ state: 'error', message: explain(err) })
    })
  }

  const settings = await readSettings()
  // Beta opt-in. `allowPrerelease` is the whole mechanism and it is read at check
  // time, so toggling it needs no restart.
  //
  // Deliberately no explicit `channel`: with `allowPrerelease` and a stable current
  // version, the GitHub provider takes the newest entry from the releases feed and
  // derives the channel file from that tag's own prerelease component
  // (`v0.8.0-beta.7` → `beta.yml`). Pinning a channel here would instead demand
  // `beta.yml` from *every* release, including stable ones that correctly publish
  // `latest.yml`, and every check would fail with
  // ERR_UPDATER_CHANNEL_FILE_NOT_FOUND. Someone already running a beta gets their
  // channel from their own version, which is how a beta user keeps getting betas
  // and still gets the stable release that supersedes them.
  instance.allowPrerelease = settings.betaUpdates
  // Automatic download+install is opt-in and only where it can work. Checking
  // still never downloads by itself unless this is on.
  const auto = settings.autoInstallUpdates && canInstall()
  instance.autoDownload = auto
  instance.autoInstallOnAppQuit = auto
  return instance
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
  // A download in flight, or one already on disk, must not be thrown away by a
  // check that would reset the status back to "available".
  if (lastStatus.state === 'downloading' || lastStatus.state === 'downloaded') return lastStatus
  checking = true
  push({ state: 'checking' })
  try {
    const autoUpdater = await updater()
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version ?? null
    // `isUpdateAvailable`, not `version !== app.getVersion()`. That was a STRING
    // comparison, so anything merely DIFFERENT counted as an update — and with betas
    // on, a 0.8.0 install was offered `0.8.0-beta.19`, which is older. The library
    // does the semver comparison itself and honours `allowDowngrade` (off, F-10)
    // while doing it. If the field is ever absent we say "up to date": failing
    // toward silence is right for a notice nobody asked for.
    if (version && result?.isUpdateAvailable === true) {
      const beta = isPrerelease(version)
      const status: UpdateStatus = {
        state: 'available',
        version,
        url: releaseUrl(version),
        beta,
        // A beta says so, because "available" reads as "ready" and a pre-release is
        // a build nobody has read the release notes of.
        message: canInstall()
          ? `Polyform ${version}${beta ? ' (beta)' : ''} is available.`
          : `Polyform ${version}${beta ? ' (beta)' : ''} is available. macOS cannot install an unsigned update, so open the release page to get it.`,
      }
      push(status)
      return status
    }
    const status: UpdateStatus = { state: 'current', version: app.getVersion() }
    if (manual) push(status)
    else lastStatus = { canInstall: canInstall(), ...status }
    return status
  } catch (err) {
    const status: UpdateStatus = { state: 'error', message: explain(err) }
    if (manual) push(status)
    else lastStatus = { canInstall: canInstall(), ...status }
    return status
  } finally {
    checking = false
  }
}

/**
 * Fetch the update that the last check found. Progress arrives through
 * `update:status` events, not through this promise, so the UI can show a bar
 * without holding an IPC call open for a 140 MB download.
 */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!app.isPackaged) return updateStatus()
  if (lastStatus.state !== 'available') return lastStatus
  if (!canInstall()) {
    // Downloading something this platform cannot apply would fill the cache and
    // then fail at the last step. Send them to the page instead.
    openReleasesPage()
    return lastStatus
  }
  try {
    const autoUpdater = await updater()
    push({ state: 'downloading', version: lastStatus.version, percent: 0, beta: lastStatus.beta })
    await autoUpdater.downloadUpdate()
    // 'update-downloaded' fires the terminal status; if it somehow does not, the
    // percentage we last saw is still on screen rather than a lie about success.
    return lastStatus
  } catch (err) {
    const status: UpdateStatus = { state: 'error', message: explain(err) }
    push(status)
    return status
  }
}

/**
 * Quit and apply what was downloaded. `isSilent = false` so the installer's own
 * UI shows: an unsigned installer that runs invisibly is exactly the shape of the
 * thing F-10 is about, and the person pressing the button should see it happen.
 */
export async function installUpdate(): Promise<UpdateStatus> {
  if (lastStatus.state !== 'downloaded') return lastStatus
  if (!canInstall()) {
    openReleasesPage()
    return lastStatus
  }
  const autoUpdater = await updater()
  // Give the renderer a frame to paint "restarting" before the process goes.
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 120)
  return lastStatus
}
