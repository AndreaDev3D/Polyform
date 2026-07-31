// history.sqlite — the disk-backed undo/redo journal (Technical-Spec §4).
// sql.js (WASM SQLite) keeps the DB in memory and persists atomically to the
// project bundle; the file on disk is a standard SQLite database.

import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Database, SqlJsStatic } from 'sql.js'
import type { JournalEntry, JournalState } from '../shared/types'

const require = createRequire(import.meta.url)

let sqlJs: SqlJsStatic | null = null

async function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlJs) return sqlJs
  const initSqlJs = require('sql.js') as (config?: object) => Promise<SqlJsStatic>
  const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')
  sqlJs = await initSqlJs({
    locateFile: () => wasmPath,
  })
  return sqlJs
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  ops TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** Cap loaded/undoable entries to keep startup + memory bounded. */
const MAX_LOADED_ENTRIES = 500

export class HistoryDb {
  private db: Database | null = null
  private filePath: string | null = null
  private dirty = false
  private persistTimer: NodeJS.Timeout | null = null
  /**
   * Absolute journal position of the first entry handed to the renderer at
   * open(). Renderer cursors are relative to that window and to entries
   * appended since — both of which sit on top of this fixed base.
   */
  private windowBase = 0
  private persistChain: Promise<void> = Promise.resolve()

  async open(bundlePath: string): Promise<JournalState> {
    await this.close()
    const SQL = await getSqlJs()
    this.filePath = path.join(bundlePath, 'history.sqlite')
    try {
      const bytes = await fs.readFile(this.filePath)
      this.db = new SQL.Database(bytes)
    } catch {
      this.db = new SQL.Database()
    }
    this.db.run(SCHEMA)
    return this.readState()
  }

  private readState(): JournalState {
    if (!this.db) return { entries: [], cursor: 0 }
    const entries: JournalEntry[] = []
    const stmt = this.db.prepare(
      `SELECT seq, label, ops, created_at FROM journal ORDER BY seq DESC LIMIT ${MAX_LOADED_ENTRIES}`,
    )
    while (stmt.step()) {
      const row = stmt.getAsObject()
      entries.push({
        seq: Number(row.seq),
        label: String(row.label),
        ops: String(row.ops),
        created_at: String(row.created_at),
      })
    }
    stmt.free()
    entries.reverse()
    const totalStmt = this.db.prepare(`SELECT COUNT(*) AS c FROM journal`)
    totalStmt.step()
    const total = Number(totalStmt.getAsObject().c)
    totalStmt.free()
    this.windowBase = Math.max(0, total - entries.length)
    let cursor = entries.length
    const cursorStmt = this.db.prepare(`SELECT value FROM meta WHERE key = 'cursor'`)
    if (cursorStmt.step()) {
      // Stored cursor counts ALL applied entries; translate into the window.
      const stored = Number(cursorStmt.getAsObject().value)
      cursor = Math.max(0, Math.min(entries.length, stored - this.windowBase))
    }
    cursorStmt.free()
    return { entries, cursor }
  }

  /**
   * Append an entry at the current cursor, discarding any redo tail
   * (matching in-memory history semantics). Returns the new seq.
   */
  append(label: string, opsJson: string): number {
    if (!this.db) return -1
    const cursor = this.getStoredCursor()
    if (cursor !== null) {
      // Drop entries beyond the cursor (redo branch being overwritten).
      const totalStmt = this.db.prepare(`SELECT COUNT(*) AS c FROM journal`)
      totalStmt.step()
      const total = Number(totalStmt.getAsObject().c)
      totalStmt.free()
      if (cursor < total) {
        this.db.run(
          `DELETE FROM journal WHERE seq IN (SELECT seq FROM journal ORDER BY seq ASC LIMIT -1 OFFSET ${cursor})`,
        )
      }
    }
    this.db.run(`INSERT INTO journal (label, ops, created_at) VALUES (?, ?, ?)`, [
      label,
      opsJson,
      new Date().toISOString(),
    ])
    const seqStmt = this.db.prepare(`SELECT last_insert_rowid() AS seq`)
    seqStmt.step()
    const seq = Number(seqStmt.getAsObject().seq)
    seqStmt.free()
    const totalStmt = this.db.prepare(`SELECT COUNT(*) AS c FROM journal`)
    totalStmt.step()
    const total = Number(totalStmt.getAsObject().c)
    totalStmt.free()
    this.setStoredCursor(total)
    this.markDirty()
    return seq
  }

  private getStoredCursor(): number | null {
    if (!this.db) return null
    const stmt = this.db.prepare(`SELECT value FROM meta WHERE key = 'cursor'`)
    const val = stmt.step() ? Number(stmt.getAsObject().value) : null
    stmt.free()
    return val
  }

  private setStoredCursor(cursor: number): void {
    this.db?.run(`INSERT INTO meta (key, value) VALUES ('cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(cursor)])
  }

  /**
   * cursorInWindow is relative to the window reported by open() plus entries
   * appended since — i.e. always `windowBase + cursorInWindow` in absolute
   * journal rows. (Recomputing a base from the CURRENT total here would
   * drift once the journal exceeds the loaded window.)
   */
  setCursor(cursorInWindow: number): void {
    if (!this.db) return
    this.setStoredCursor(this.windowBase + Math.max(0, cursorInWindow))
    this.markDirty()
  }

  private markDirty(): void {
    this.dirty = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, 1500)
  }

  /** Persists are chained so overlapping calls never race on the same file. */
  persist(): Promise<void> {
    const run = this.persistChain.then(() => this.doPersist())
    this.persistChain = run.catch(() => {})
    return run
  }

  private async doPersist(): Promise<void> {
    if (!this.db || !this.filePath || !this.dirty) return
    this.dirty = false
    const filePath = this.filePath
    const bytes = this.db.export()
    const tmp = `${filePath}.${process.pid}.tmp`
    await fs.writeFile(tmp, Buffer.from(bytes))
    try {
      await fs.rename(tmp, filePath)
    } catch {
      // Windows rename-over-existing can fail transiently; retry once.
      await fs.rm(filePath, { force: true })
      await fs.rename(tmp, filePath)
    }
  }

  async close(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (this.db && this.filePath && this.dirty) {
      await this.persist()
    }
    this.db?.close()
    this.db = null
    this.filePath = null
    this.dirty = false
  }
}
