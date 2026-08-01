# Polyform Plugin API — Design Sketch (v0.3)

> Status: **dev preview**, deliberately a sketch per [Roadmap 3.4](Roadmap.md). The
> stable, sandboxed API ships post-1.0 once the Rust core settles the object
> model. What exists today is a minimal proof-of-concept for experimentation.

## What ships in v0.3

**Plugins → Run Plugin Script…** picks a `.js` file and executes it in the
renderer with a `polyform` API object. All mutations funnel through the
command system, so a plugin run is **one undoable history entry**
(`Plugin: <filename>`).

⚠️ **Security model (current)**: none. The script runs with the privileges of
the editor page (no Node access — the renderer is context-isolated and
sandboxed — but full access to your document). Polyform shows a confirmation
dialog and you should only run scripts you wrote or trust. The post-1.0
plugin system will run plugins in isolated workers with a typed message
bridge (see below).

## Current API surface

```js
// example-plugin.js — creates a 3x3 grid of rectangles
const GAP = 20, SIZE = 80
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 3; col++) {
    polyform.create('RECTANGLE', {
      name: `Cell ${row * 3 + col + 1}`,
      x: col * (SIZE + GAP),
      y: row * (SIZE + GAP),
      width: SIZE,
      height: SIZE,
      fills: [{ type: 'SOLID', visible: true, opacity: 1,
                color: { r: col / 3, g: row / 3, b: 0.9, a: 1 } }],
    })
  }
}
polyform.notify('Grid created!')
```

| Method | Description |
| --- | --- |
| `polyform.selection(): NodeId[]` | Ids of the current selection. |
| `polyform.getNode(id): SceneNode \| null` | Deep copy of a node (see `docs/schema.fbs` for the shape). |
| `polyform.currentPageNodes(): NodeId[]` | Every node id on the active page in render order. |
| `polyform.create(type, props): NodeId` | Create `RECTANGLE \| ELLIPSE \| LINE \| POLYGON \| STAR \| TEXT \| FRAME` at root level. Structural keys are stripped from `props`. |
| `polyform.update(id, props)` | Patch simple properties (position, size, fills, text…). Structural keys are stripped. |
| `polyform.remove(id)` | Remove a node and its subtree (blocked inside instances). |
| `polyform.notify(message)` | Show a message to the user. |

Execution is synchronous; when the script returns, accumulated ops are
committed. Throwing rolls back everything the plugin did.

## Post-1.0 target design

- **Manifest** (`plugin.json`): `{ id, name, version, main, permissions: ["scene:read", "scene:write", "export"] }` in a plugin directory under the user's data folder.
- **Isolation**: plugins run in a dedicated `Worker` (no DOM), talking to the editor over a **typed message bridge** (`postMessage` + JSON-schema-validated commands). The API object above becomes async (`await polyform.getNode(...)`).
- **Capability gating**: manifest permissions are surfaced at install time; `scene:write` plugins get the OpRecorder path, read-only plugins get snapshots.
- **UI surface**: plugins may request a panel (rendered as a sandboxed `iframe` with its own CSP) — never direct DOM access to the editor.
- **Versioning**: the API is versioned with the scene schema (`schemaVersion`); the bridge negotiates the highest common version at load.
- **Rust-core note**: the API intentionally mirrors the engine's public surface (node CRUD via patch ops) so the WASM core can serve the same bridge without renderer changes.

## Non-goals

Network access grants, arbitrary Node.js/filesystem APIs, and plugin
marketplaces are out of scope for the local-first core. Distribution is a
folder you copy — like everything else in Polyform.
