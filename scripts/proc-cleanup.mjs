// Process cleanup shared by the harnesses (Windows).
//
// Every harness starts Electron through `npx.cmd` with shell:true, so the pid
// it holds is a cmd.exe wrapper. That wrapper frequently exits before the
// harness finishes, and `taskkill /T` then has no tree left to walk — the real
// electron.exe survives, holding its debug port and the userData profile until
// somebody goes looking. A leftover instance also makes the NEXT run fail in a
// way that reads like an app bug rather than a stale process.
//
// So kill by identity: match something unique to this run on the command line
// (its debug port, or its temp bundle path) and take those trees down.

import { spawnSync } from 'node:child_process'
import process from 'node:process'

export function killElectronMatching(needle) {
  if (process.platform !== 'win32' || !needle) return
  const ps =
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${String(needle).replace(/'/g, "''")}*' } | ` +
    `ForEach-Object { taskkill /F /T /PID $_.ProcessId }`
  try {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })
  } catch {
    /* best effort — cleanup must never fail a gate */
  }
}
