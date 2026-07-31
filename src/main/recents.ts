// Recent projects list stored in the app's userData directory.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { RecentEntry } from '../shared/types'

const MAX_RECENTS = 12

function recentsPath(): string {
  return path.join(app.getPath('userData'), 'recents.json')
}

export async function listRecents(): Promise<RecentEntry[]> {
  try {
    const raw = await fs.readFile(recentsPath(), 'utf-8')
    const entries = JSON.parse(raw) as RecentEntry[]
    // Filter to bundles that still exist on disk.
    const alive: RecentEntry[] = []
    for (const entry of entries) {
      try {
        await fs.access(path.join(entry.path, 'manifest.json'))
        alive.push(entry)
      } catch {
        /* dropped */
      }
    }
    return alive
  } catch {
    return []
  }
}

export async function pushRecent(bundlePath: string, title: string): Promise<void> {
  const entries = await listRecents()
  const filtered = entries.filter((e) => e.path !== bundlePath)
  filtered.unshift({ path: bundlePath, title, openedAt: new Date().toISOString() })
  try {
    await fs.writeFile(recentsPath(), JSON.stringify(filtered.slice(0, MAX_RECENTS), null, 2))
  } catch {
    /* non-fatal */
  }
}
