// Recent projects list stored in the app's userData directory.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { RecentEntry } from '../shared/types'
import { resolveBundle } from './project'

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
        // Through the resolver, so a recent entry survives either bundle shape
        // — checking for manifest.json alone dropped every v0.7 project from
        // this list.
        await resolveBundle(entry.path)
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

/**
 * The bundle's saved preview, for the welcome screen's cards.
 *
 * The path arrives from the renderer, so it is checked against the recents
 * list rather than trusted: plugin scripts share the renderer realm (F-15),
 * and "read me any file" is not a capability this needs to hand them.
 */
export async function readRecentThumbnail(bundlePath: string): Promise<Uint8Array | null> {
  const entries = await listRecents()
  if (!entries.some((e) => e.path === bundlePath)) return null
  try {
    return new Uint8Array(await fs.readFile(path.join(bundlePath, 'thumbnail.png')))
  } catch {
    // Projects saved before thumbnails, or never saved: the card falls back.
    return null
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
