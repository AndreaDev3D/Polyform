# Technical & Architectural Specification: Local-First Vector Design Tool

> **Historical document** — the original technical spec (July 2026), kept as written.
> Where the implementation deviates, an ADR records why: TypeScript engine first with a
> planned Rust port ([ADR-002](Architecture-Decisions.md), [V0.4-Porting-Plan.md](V0.4-Porting-Plan.md)),
> MessagePack envelope before FlatBuffers (ADR-004; current schema: [schema.fbs](schema.fbs)),
> Canvas2D before WebGPU (ADR-003), polygon-flattened booleans (ADR-007). The embedded
> `schema.fbs` below is the original v1 sketch — [docs/schema.fbs](schema.fbs) is current.

**Document Version:** 1.0.0  
**Target Architecture:** Cross-Platform Desktop (Windows, macOS, Linux)  
**Core Stack:** Rust (WASM/Native), Electron / Tauri 2.0, WebGPU / Skia, React, FlatBuffers, SQLite  

---

## 1. System Architecture & Process Model

The application follows a multi-process architecture to decouple high-frequency graphics execution and spatial logic from editor UI rendering.

```
+-----------------------------------------------------------------------+
|                         Desktop Main Process                          |
|         (Node.js / Rust Host: File System, Native Menus, OS IPC)      |
+-----------------------------------+-----------------------------------+
                                    | IPC Bridge
                                    v
+-----------------------------------------------------------------------+
|                        Renderer Process (Chromium)                    |
|                                                                       |
|  +---------------------------+     +-------------------------------+  |
|  |     React / TS UI Chrome  |     |     WebGPU Canvas Layer       |  |
|  | (Panels, Toolbar, Inspector)|     |  (Direct GPU Frame Buffer)    |  |
|  +-------------+-------------+     +---------------+---------------+  |
|                |                                   ^                  |
|                | Method Calls / Events             | Render Loop      |
|                v                                   | (60-120 FPS)     |
|  +-------------------------------------------------+---------------+  |
|  |                       Rust WASM Core Module                     |  |
|  |  - Scene Graph Memory          - Bounding Volume Hierarchy (BVH) |  |
|  |  - Vector Network Topology     - FlatBuffers Serialization      |  |
|  |  - Boolean Geometry Engine     - Command Undo/Redo Engine       |  |
|  +-----------------------------------------------------------------+  |
+-----------------------------------------------------------------------+
```

### 1.1 Process Isolation & Inter-Process Communication (IPC)
* **Main Process:** Handles native filesystem dialogs, window lifecycle management, system font directory indexing, and disk persistence.
* **Renderer Process:** Hosts the DOM UI and the `<canvas>` viewport.
* **WASM Core Engine:** Instantiated inside a Dedicated Web Worker or directly on the Renderer main thread using SharedArrayBuffer for zero-copy memory access to vertex and index buffers.

---

## 2. Core Vector Engine & Scene Graph Mathematics

### 2.1 Vector Network Representation
Unlike traditional SVG paths that consist of linear sequences of commands (`M`, `L`, `C`), vector geometry in this engine uses **Vector Networks**—an arbitrary topology graph where a single vertex can connect to $N$ edges.

#### Rust Data Structure Model
```rust
use std::collections::HashMap;

pub type VertexId = u32;
pub type EdgeId = u32;

#[derive(Clone, Debug)]
pub struct VectorVertex {
    pub id: VertexId,
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, Debug)]
pub struct VectorEdge {
    pub id: EdgeId,
    pub start_vertex: VertexId,
    pub end_vertex: VertexId,
    pub control_point_1: Option<(f32, f32)>,
    pub control_point_2: Option<(f32, f32)>,
}

#[derive(Clone, Debug)]
pub struct VectorNetwork {
    pub vertices: HashMap<VertexId, VectorVertex>,
    pub edges: HashMap<EdgeId, VectorEdge>,
}
```

### 2.2 Spatial Indexing & Hit Testing
To maintain 120 FPS hit-testing performance when mouse-hovering over tens of thousands of objects, the scene graph maintains a dynamic **Bounding Volume Hierarchy (BVH)** or **R-Tree** using axis-aligned bounding boxes (AABB).

$$	ext{AABB} = \{ x_{\min}, y_{\min}, x_{\max}, y_{\max} \}$$

* **Insert / Update Cost:** $O(\log N)$
* **Query Cost:** $O(\log N + K)$ where $K$ is the number of intersecting elements within cursor range.
* **Culling:** Off-screen shapes outside the active camera projection viewport are immediately discarded during frame rendering.

---

## 3. Storage Specification & Local Project Schema (`.poly`)

### 3.1 Directory Layout Specification
A `.poly` project is a directory formatted as follows:

```
<project_name>.poly/
├── manifest.json
├── scene.bin
├── history.sqlite
└── assets/
    └── [sha256_hash].[ext]
```

#### `manifest.json` Example
```json
{
  "version": "1.0.0",
  "app_build": "2026.7.31",
  "project_id": "8f3c2a11-0e4b-472d-9b34-82a170fbcd99",
  "title": "Mobile App Redesign",
  "created_at": "2026-07-31T10:15:00Z",
  "updated_at": "2026-07-31T10:20:00Z",
  "viewport_state": {
    "zoom": 1.25,
    "pan_x": 450.0,
    "pan_y": -120.0
  }
}
```

### 3.2 FlatBuffers Binary Schema (`schema.fbs`)

```flatbuffers
namespace FigClone.Schema;

enum NodeType : byte { Rectangle, Ellipse, VectorPath, Text, Frame, Group }

table Vec2 {
  x: float;
  y: float;
}

table Color {
  r: float;
  g: float;
  b: float;
  a: float;
}

table Fill {
  color: Color;
  visible: bool = true;
}

table Stroke {
  color: Color;
  width: float;
  visible: bool = true;
}

table Node {
  id: ulong;
  name: string;
  node_type: NodeType;
  position: Vec2;
  size: Vec2;
  rotation: float;
  opacity: float = 1.0;
  fills: [Fill];
  strokes: [Stroke];
  children: [Node];
  vector_data_ref: string;
}

table SceneGraph {
  root_nodes: [Node];
}

root_type SceneGraph;
```

---

## 4. Undo/Redo Engine & History Journaling

### 4.1 Command Pattern Architecture
Every mutation in the application is executed via a reversible command pattern stored in an in-memory stack and logged to an embedded SQLite database (`history.sqlite`).

```rust
pub trait Command {
    fn execute(&mut self, scene: &mut SceneGraph);
    fn undo(&mut self, scene: &mut SceneGraph);
    fn description(&self) -> String;
}

pub struct MoveNodeCommand {
    pub node_id: u64,
    pub delta: (f32, f32),
}

impl Command for MoveNodeCommand {
    fn execute(&mut self, scene: &mut SceneGraph) {
        if let Some(node) = scene.find_node_mut(self.node_id) {
            node.position.0 += self.delta.0;
            node.position.1 += self.delta.1;
        }
    }

    fn undo(&mut self, scene: &mut SceneGraph) {
        if let Some(node) = scene.find_node_mut(self.node_id) {
            node.position.0 -= self.delta.0;
            node.position.1 -= self.delta.1;
        }
    }

    fn description(&self) -> String {
        format!("Move Node {}", self.node_id)
    }
}
```

---

## 5. System Font Reader & Text Engine Specification

1. **System Font Scanning:** The main process executes native library bindings (`font-kit` in Rust or C++ Node modules) to scan OS font directories:
   * **Windows:** `C:\Windows\Fonts`
   * **macOS:** `/Library/Fonts`, `/System/Library/Fonts`, `~/Library/Fonts`
   * **Linux:** `/usr/share/fonts`, `/usr/local/share/fonts`, `~/.fonts`
2. **Text Shaping:** Text strings are passed to **HarfBuzz** (compiled to WASM or linked natively) to compute kerning, ligatures, and glyph positioning.
3. **Glyph Rasterization:** Vector paths for glyphs are extracted directly from TTF/OTF tables and rendered into a WebGPU dynamic glyph atlas texture.

---

## 6. Build, Cross-Compilation & Packaging

* **Windows:** Packaged as standard installer (`.exe` via NSIS) and portable executable targeting `x86_64-pc-windows-msvc`.
* **macOS:** Packaged as Universal Binary (`x86_64` and `aarch64` / Apple Silicon) wrapped in a `.dmg` bundle with Metal GPU backend bindings.
* **Linux:** Packaged as `.AppImage` and `.deb` targeting `x86_64-unknown-linux-gnu` with WebGL2/WebGPU Fallback drivers.
