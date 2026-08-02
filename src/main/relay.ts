// `polyform mcp serve` relay (7.4, ADR-023).
//
// Why this exists: an Electron GUI process on Windows NEVER delivers piped
// stdin to the main process — the message pump swallows it. Measured here
// directly: the in-process StdioServerTransport connected, logged its
// banner, and then never saw a single byte of `initialize`; stdin EOF was
// equally invisible, so the process could not even notice its client had
// gone. So serve splits in two:
//
//   GUI (hidden, stdin-blind)  ←loopback HTTP→  THIS RELAY  ←stdio→  client
//
// The GUI half hosts the document on the same hardened StreamableHTTP
// endpoint the app uses (ADR-021); this half runs under
// ELECTRON_RUN_AS_NODE — a plain Node process where stdio just works — and
// pumps JSON-RPC messages between the two transports. No protocol logic
// lives here: it is a pipe with two well-tested ends.
//
// Invoked as: ELECTRON_RUN_AS_NODE=1 <electron> relay.js <port> <token>

import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [, , port, token] = process.argv
if (!port || !token) {
  process.stderr.write('relay: expected <port> <token>\n')
  process.exit(2)
}

const stdio = new StdioServerTransport()
const http = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})

let closing = false
function shutdown(code: number): void {
  if (closing) return
  closing = true
  void Promise.allSettled([stdio.close(), http.close()]).then(() => process.exit(code))
  // A transport that refuses to close must not keep the client hanging.
  setTimeout(() => process.exit(code), 1500).unref()
}

stdio.onmessage = (message) => {
  http.send(message).catch((err) => {
    process.stderr.write(`relay: upstream send failed: ${err instanceof Error ? err.message : err}\n`)
    shutdown(1)
  })
}
http.onmessage = (message) => {
  void stdio.send(message)
}
stdio.onclose = () => shutdown(0) // client hung up (stdin EOF)
http.onclose = () => shutdown(0) // GUI went away
stdio.onerror = (err) => {
  process.stderr.write(`relay: stdio error: ${err.message}\n`)
  shutdown(1)
}
http.onerror = (err) => {
  process.stderr.write(`relay: http error: ${err.message}\n`)
  shutdown(1)
}

// Order matters: be ready to receive on stdio only after the HTTP side is
// up, so the client's `initialize` cannot race the upstream connection.
await http.start()
await stdio.start()
