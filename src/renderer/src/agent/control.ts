// The claimed handle on the agent endpoint (v0.6 item 7.2, F-15 × F-20).
//
// Plugin scripts run inside this same realm (`new Function`, roadmap 3.4),
// so anything left on a global is plugin-reachable. Starting a network
// listener must not be — otherwise the consent panel describes a decision
// the user did not actually get to make. The preload hands this surface out
// exactly once; importing this module at startup is what claims it, long
// before a plugin can be loaded (which needs a file dialog and a confirm).

import type { PolyformAgentApi, PolyformAgentGate } from '../../../shared/types'

const gate = (globalThis as { polyformAgent?: PolyformAgentGate }).polyformAgent
const claimed: PolyformAgentApi | null = gate?.claim() ?? null

export function agentApi(): PolyformAgentApi {
  if (!claimed) {
    // Only reachable if something claimed it before Polyform's own startup
    // did, which would itself be the bug worth shouting about.
    throw new Error('agent control surface was already claimed')
  }
  return claimed
}

export function agentApiAvailable(): boolean {
  return claimed !== null
}
