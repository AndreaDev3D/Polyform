# v0.6 Research Spike — Agent Connectivity Protocol & Transport (Roadmap 7.1)

**Date:** 2026-08-02 · **Status:** complete — decision recorded in ADR-021,
validated by a committed prototype gate (`npm run test:mcp`).
**Question:** how does an AI agent connect to a **running** Polyform, watch
the work happen live, and eventually make edits — without becoming a
silent remote-control hole?

## Ground rules (from the roadmap)

1. **Attach to the live app.** The value is the *running* session — the
   document the human has open right now, not a file on disk.
2. **Security up front.** Localhost-only, explicit consent, a visible
   "agent connected" indicator. F-15 and F-17 say: no silent remote
   control, and never widen the sandbox for convenience.
3. **Local-first.** No cloud relay, no account, no telemetry.
4. **Best tool wins.** MCP is the lead candidate, not a foregone
   conclusion — it is measured against a plain local socket and a
   pure-CLI design.

## Protocol candidates

| Option | Verdict |
| :-- | :-- |
| **MCP (Model Context Protocol)** | **Chosen.** It is the interoperable standard agent clients already speak — Claude Code, and the wider ecosystem, connect to an MCP server with a two-line config entry and no bespoke adapter. It also already models exactly what 7.2/7.3 need: **tools** (actions), **resources** (readable state), and server→client **notifications**. The reference TypeScript SDK is MIT and runs unmodified in Electron's main process. |
| A bespoke local WebSocket / JSON-RPC bridge | Rejected as the primary. It is *less* work only until the first client — then every agent needs a custom adapter, and we would be reinventing capability negotiation, tool schemas, and change notifications that MCP already specifies. Worth revisiting only if MCP's shape actively fights a requirement; so far it doesn't. |
| Pure CLI (agent shells out to `polyform …`) | Rejected as the primary, kept as roadmap 7.4. A CLI cannot see the *running* app's unsaved state, and every invocation pays process startup. It is the right tool for scripting and CI over `.poly` bundles on disk — a complement, not a substitute. |

## Transport: why the app hosts an HTTP endpoint

MCP defines two standard transports: **stdio** (the client launches the
server as a subprocess) and **Streamable HTTP** (the server is an
independent process; one endpoint handles POST, and optionally GET for a
server→client SSE stream). The deprecated HTTP+SSE transport from
2024-11-05 is being removed across the ecosystem through mid-2026 and is
not a candidate.

**stdio cannot express "attach to the app I already have open"** — it
requires the client to spawn the server. So the server lives inside
Polyform and the agent dials in over loopback HTTP. This is exactly what
**Figma's desktop Dev Mode server** does (`http://127.0.0.1:3845/mcp`,
enabled from a toggle in the app), which is reassuring prior art for the
shape.

Claude Code, as a client, supports `stdio`, `http`, deprecated `sse`, and
`ws`, with no loopback restriction and static bearer tokens in `headers` —
so a Polyform entry is:

```json
{ "mcpServers": { "polyform": {
  "type": "http",
  "url": "http://127.0.0.1:<port>/mcp",
  "headers": { "Authorization": "Bearer <token shown in Polyform>" }
} } }
```

## The realtime question — the spike's most consequential finding

"See the work in realtime" sounds like a job for MCP resource
subscriptions (`resources/subscribe` → `notifications/resources/updated`).
**It isn't, today.** Client support for the server-push half of MCP is
patchy across the ecosystem, and specifically:

| Mechanism | Reality as of 2026-08 |
| :-- | :-- |
| `resources/subscribe` + `notifications/resources/updated` | **Not documented as supported by Claude Code.** Building the live view on it would produce a feature that silently does nothing. |
| `list_changed` (tools/resources/prompts) | **Supported** — Claude Code refreshes capabilities when it arrives. Good for "the document structure changed", useless as a data channel. |
| Channels (`--channels`, `claude/channel`) | The *right shape* — an MCP server pushing events into a live session so the agent reacts while the user is away. But it is a **research preview**, plugin-packaged, and gated to an Anthropic-maintained allowlist, so a third-party desktop app cannot register as one yet. |
| WebSocket transport (`"type": "ws"`) | Supported by Claude Code and explicitly recommended for servers that "push events unprompted" — but header-only auth, no OAuth, and not offered by `claude mcp add --transport`. A future upgrade path, not the baseline. |
| Sampling / logging / progress | Not documented in Claude Code; **sampling and logging are deprecated** in the 2026-07-28 MCP revision anyway. |

**Therefore: the realtime read surface is a cursor-based change feed, not a
subscription.** A `poll_changes(cursor)` tool over the existing PatchOp
journal gives an agent an ordered, gap-free view of everything the human
has done since it last looked — it works on *every* client today, it
survives disconnects (the cursor is the resume token), and it costs the
server nothing when nobody is asking. Push mechanisms layer on later as
an optimization, without changing the data model.

This is the single most useful thing the spike established: the obvious
design would have shipped a dead feature.

## Protocol revision: target 2025-11-25, watch 2026-07-28

MCP's **2026-07-28** revision is its largest yet: sessions are gone
(`Mcp-Session-Id` and the `initialize` handshake retired), the GET SSE
stream and `resources/subscribe` are replaced by a single
`subscriptions/listen`, and roots/sampling/logging are deprecated with a
12-month runway. The reference SDKs support it, and the TypeScript SDK
keeps the sessionful v1 path working alongside it.

We build against **2025-11-25** (what the SDK's `StreamableHTTPServerTransport`
serves by default and what shipping clients negotiate), and the migration
is small precisely because we do **not** depend on subscriptions: our
realtime story is a tool call, and tools are unchanged across the
revision. Statelessness is a good fit for a single-user desktop app.

## Security model (decided now, before any code that writes)

| Control | Rule |
| :-- | :-- |
| Off by default | The server never starts on its own. No background listener. |
| Loopback only | Binds `127.0.0.1`, never `0.0.0.0`. |
| Per-session bearer token | Freshly generated on each start; every request must carry it. Constant-time compare. |
| DNS-rebinding defence | `Origin`/`Host` validated against the loopback origin (MCP spec requirement) so a web page in the user's browser cannot drive the app. |
| Ephemeral port | Port 0 — the OS picks one. Nothing to squat, nothing to guess. |
| Visible indicator | The UI shows when an agent is connected (7.2). |
| Writes are journaled | Agent edits go through the same PatchOp journal: undoable, attributed, rollback-able (7.3) — never a side channel around history. |

## Prototype (committed as `npm run test:mcp`)

`src/main/mcp.ts` + `src/renderer/src/agent/bridge.ts` implement the
architecture end to end: the MCP server runs in the Electron **main**
process; the document lives in the **renderer**; each tool call
round-trips over one IPC bridge, so the main process holds no scene state.
Three read-only tools ship in the prototype: `get_document`,
`get_selection`, `poll_changes`.

`scripts/mcp-probe.mjs` boots the built app and connects with the
**official MCP SDK client** over Streamable HTTP — the same code path a
real agent client uses. Measured, all passing:

| Check | Result |
| :-- | :-- |
| Unauthenticated request | rejected **401** |
| Cross-origin request (`Origin: https://evil.example.com`) | rejected **403** |
| Client connect + initialize | ok |
| `tools/list` | `get_document`, `get_selection`, `poll_changes` |
| Live document read | saw the open project and its node, geometry correct |
| User selection | visible to the agent |
| **Edit made in the app → visible in the change feed** | `"Resize From Test"` on the touched node id |
| Server stop | clean, port released |

## Open questions for 7.2–7.4

- **Consent UI**: where the enable toggle and token live, and how the
  "agent connected" indicator is presented.
- **Snapshots**: per-node PNG via the existing render-to-canvas path;
  image results are supported by Claude Code but count against a 25k-token
  output budget, so size and downscale deliberately.
- **Write surface (7.3)**: which mutations to expose, and per-capability
  consent — reads and writes should not share one switch.
- **CLI (7.4)**: whether `polyform` shells into a running instance via the
  same loopback endpoint or opens bundles directly (it should do both).

## Sources

- [MCP transports (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) · [the 2026-07-28 revision](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP TypeScript SDK (MIT)](https://github.com/modelcontextprotocol/typescript-sdk) · [supporting 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [Claude Code MCP reference — transports, auth, list_changed, timeouts, reconnection](https://code.claude.com/docs/en/mcp) · [Channels (research preview)](https://code.claude.com/docs/en/channels)
- [Figma desktop Dev Mode MCP server on 127.0.0.1:3845](https://developers.figma.com/docs/figma-mcp-server/local-server-installation)
- [MCP client capability gap](https://www.pulsemcp.com/posts/mcp-client-capabilities-gap)
