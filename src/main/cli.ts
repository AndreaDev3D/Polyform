// v0.6 item 7.4: the headless CLI.
//
// Same binary, no window shown: `polyform <verb>` boots the app with a
// hidden renderer, drives it over the SAME main↔renderer bridge the MCP
// server uses, prints to stdout, and exits. One renderer implementation —
// a CLI export is pixel-identical to File → Export in the app, which is
// the point: a second renderer would be a parity trap (ADR-015 ethos).
//
//   polyform new <path.poly> [--title T]         create a bundle, no dialog
//   polyform query <path.poly> [--node ID] [--depth N]   document JSON
//   polyform export <path.poly> --frame NAME|ID [--scale N] [--out FILE]
//   polyform mcp serve <path.poly>               stdio MCP server (files at rest)
//
// Trust model of `mcp serve`: YOU spawned a process over a file you own,
// with your OS user's authority — that IS the consent, so every capability
// including edit is on. There is no port, no token, no listener: stdio
// only exists between this process and the client that spawned it. This is
// deliberately different from the in-app endpoint, where a foreign agent
// attaches to a LIVE session and each capability is granted by hand
// (ADR-021/022).

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { ProjectManager } from './project'
import type { SceneQuery } from './mcp'

export interface CliCommand {
  verb: 'new' | 'query' | 'export' | 'serve'
  bundle: string
  flags: Map<string, string>
}

/** stderr for humans; stdout carries ONLY payload (JSON / MCP protocol). */
function log(msg: string): void {
  process.stderr.write(msg + '\n')
}

/**
 * Recognize a CLI invocation. Dev shape: `electron out/main/index.js <verb> …`;
 * packaged shape: `polyform.exe <verb> …`. Returns null for the GUI app.
 */
export function parseCliCommand(argv: string[]): CliCommand | null {
  const args = [...argv.slice(1)].filter((a) => !a.endsWith('index.js') && !a.startsWith('--remote-debugging'))
  let verb = args[0]
  let rest = args.slice(1)
  if (verb === 'mcp' && rest[0] === 'serve') {
    verb = 'serve'
    rest = rest.slice(1)
  }
  if (verb !== 'new' && verb !== 'query' && verb !== 'export' && verb !== 'serve') return null

  const flags = new Map<string, string>()
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1))
      else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) flags.set(a.slice(2), rest[++i])
      else flags.set(a.slice(2), 'true')
    } else {
      positional.push(a)
    }
  }
  const bundle = positional[0]
  if (!bundle) {
    log(`polyform ${verb}: missing <bundle.poly> path`)
    app.exit(2)
    return { verb: 'query', bundle: '', flags } // unreachable; exit above
  }
  return { verb: verb as CliCommand['verb'], bundle: path.resolve(bundle), flags }
}

interface CliContext {
  projects: ProjectManager
  sceneQuery: SceneQuery
  /** Resolves once the hidden renderer has loaded the bundle. */
  rendererReady: Promise<void>
}

export async function runCli(cmd: CliCommand, ctx: CliContext): Promise<void> {
  try {
    switch (cmd.verb) {
      case 'query': {
        await ctx.rendererReady
        const summary = await ctx.sceneQuery('document.summary', {})
        const nodeId = cmd.flags.get('node')
        const out = nodeId
          ? await ctx.sceneQuery('node.detail', {
              id: nodeId,
              depth: Number(cmd.flags.get('depth') ?? 1),
            })
          : summary
        process.stdout.write(JSON.stringify(out, null, 2) + '\n')
        app.exit(0)
        return
      }

      case 'export': {
        await ctx.rendererReady
        const frame = cmd.flags.get('frame')
        if (!frame) throw new Error('export needs --frame <name or id>')
        const scale = Number(cmd.flags.get('scale') ?? 1)
        if (!Number.isFinite(scale) || scale <= 0 || scale > 8) throw new Error('--scale must be in (0, 8]')
        const result = (await ctx.sceneQuery('render.export', { frame, scale })) as {
          base64: string
          width: number
          height: number
          name: string
        }
        const outPath = path.resolve(
          cmd.flags.get('out') ?? `${result.name.replace(/[^\w.-]+/g, '_')}@${scale}x.png`,
        )
        await fs.writeFile(outPath, Buffer.from(result.base64, 'base64'))
        log(`exported "${result.name}" ${result.width}x${result.height} -> ${outPath}`)
        process.stdout.write(outPath + '\n')
        app.exit(0)
        return
      }

      case 'serve': {
        await ctx.rendererReady
        // An Electron GUI process on Windows never delivers piped stdin to
        // the main process (measured — see relay.ts), so serve is split:
        // this hidden GUI hosts the document on the hardened loopback
        // endpoint (ADR-021), and a RUN_AS_NODE relay child — plain Node,
        // where stdio works — inherits the REAL stdio and pumps messages.
        // All capabilities on, edit included: the user spawning a process
        // over their own file is the consent (ADR-023).
        const { mcpStart } = await import('./mcp')
        const status = await mcpStart(ctx.sceneQuery, { edit: true })
        if (!status.running || !status.port || !status.token) throw new Error('loopback endpoint failed to start')

        const relay = spawn(
          process.execPath,
          [path.join(import.meta.dirname, 'relay.js'), String(status.port), status.token],
          {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: 'inherit', // the relay owns the real stdin/stdout
          },
        )
        log(`polyform mcp serve: ${cmd.bundle} (all capabilities on; edits save to disk)`)
        relay.on('exit', (code) => app.exit(code ?? 0))
        relay.on('error', (err) => {
          log(`polyform mcp serve: relay failed: ${err.message}`)
          app.exit(1)
        })
        return // lives until the relay (i.e. the client) goes away
      }

      case 'new':
        // Handled window-less in index.ts; never reaches here.
        app.exit(2)
        return
    }
  } catch (err) {
    log(`polyform ${cmd.verb}: ${err instanceof Error ? err.message : String(err)}`)
    app.exit(1)
  }
}
