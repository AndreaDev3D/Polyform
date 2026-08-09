// Small persisted preferences, in userData next to recents.json.
//
// Deliberately not a document concern: these are properties of this person on
// this machine (like the panel widths in localStorage), so they never enter a
// .poly bundle.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface Settings {
  /**
   * Check GitHub for a newer release when the app starts. OFF by default, and
   * that is a product decision rather than caution: Polyform's first promise is
   * "no cloud, no account, no server", and an unannounced call to a web API on
   * every launch quietly breaks it. Help → Check for Updates is always there,
   * and turning this on is one click in the same menu.
   */
  checkUpdatesOnLaunch: boolean
  /**
   * Offer pre-release builds. Every push to `staging` publishes one as a GitHub
   * **pre-release** (not a draft — a draft has no tag and is invisible to anyone
   * without push access, so no updater can ever see one), versioned
   * `0.8.0-beta.<run>`. With this on, the updater is allowed to consider those;
   * with it off, GitHub's "latest release" excludes them and nothing changes.
   *
   * Off by default for the same reason as the launch check: a beta is a build
   * whose gates passed and whose *release* nobody read.
   */
  betaUpdates: boolean
}

const DEFAULTS: Settings = { checkUpdatesOnLaunch: false, betaUpdates: false }

let cache: Settings | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export async function readSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(file(), 'utf-8')
    cache = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings()), ...patch }
  cache = next
  // Same tmp+rename discipline as every other write (F-05): a torn settings
  // file would be read as "no settings" and silently reset the preference.
  const target = file()
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2))
  await fs.rename(tmp, target)
  return next
}
