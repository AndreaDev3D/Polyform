# Product Overview: Local-First Native Vector Design Tool

> **Historical document** — this is the original product vision (July 2026), kept as written.
> For what actually shipped and where implementation deviates (deliberately), see
> [Feature-Matrix.md](Feature-Matrix.md), [Architecture-Decisions.md](Architecture-Decisions.md),
> and the [CHANGELOG](../CHANGELOG.md). The project bundle extension shipped as `.poly`.

## Executive Summary
This document outlines the product vision and high-level architectural framework for a native, cross-platform desktop vector design application (a local-first "Figma clone"). Designed specifically for single-machine, local-first operation, the application eliminates cloud server dependencies, centralized database infrastructure, and SaaS platform lock-in. Every design project is represented as a self-contained, portable directory structure (`.poly`) on the user's filesystem.

---

## Technical Stack Architecture

| Layer | Technology | Role & Functionality |
| :--- | :--- | :--- |
| **Desktop Shell** | **Electron** (Chromium + Node.js) / **Tauri 2.0** | Cross-platform container providing OS windowing, hardware access, system font reading, and local filesystem I/O. |
| **Core Canvas Engine** | **Rust** compiled to **WebAssembly (WASM)** | High-performance logic layer handling the scene graph, vector networks, spatial indexing (BVH/R-Trees), and geometry calculations. |
| **Graphics Engine** | **WebGPU** (via **Skia / CanvasKit-WASM** or **Vello**) | GPU-accelerated 2D rendering loop executing hardware vector rasterization, shading, clipping, and subpixel text rendering at 60/120 FPS. |
| **User Interface Chrome** | **React** + **TypeScript** + **Tailwind CSS** | Non-canvas editor interface including layer trees, inspectors, toolbars, color pickers, modal windows, and context menus. |
| **Data Serialization** | **FlatBuffers** (Binary Schema) | Zero-copy deserialization format for loading and saving massive document scene graphs without JSON parsing overhead. |
| **State & History Journal** | **SQLite** (Embedded) + Command Log | Local transaction log storing document state changes, incremental undo/redo history, and rollback checkpoints. |
| **Asset Pipeline** | **Content-Addressed Local Directory** | Local file system storage using SHA-256 deduplication for images, fonts, and embedded binary assets. |

---

## Key Architectural Principles

### 1. 100% Local-First & Self-Contained Projects
* Projects exist purely as files and directories on the local disk.
* Zero cloud server requirements, zero remote database calls, and full functionality offline.
* Projects are fully portable: copying a project directory transfers all shapes, history, and embedded assets intact.

### 2. High-Performance Canvas Rendering
* The HTML DOM is strictly used for editor chrome UI; shapes and canvases are **never** rendered as DOM nodes or SVGs.
* Rendering is offloaded to WebGPU canvas layers driven directly by Rust WASM memory structures.
* Spatial indexing allows sub-millisecond hit testing and viewport culling on scenes with over 100,000 vector shapes.

### 3. File Bundle Architecture (`.poly`)
Each project is structured as a dedicated directory bundle:
```text
MyDesign.poly/
├── manifest.json       # Project metadata (schema version, canvas settings, thumbnail)
├── scene.bin           # FlatBuffers binary encoding of the scene graph
├── history.sqlite      # SQLite database storing undo/redo log & snapshots
└── assets/             # Deduplicated local media folder (SHA-256 hashed filenames)
    ├── e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.png
    └── a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e.jpg
```

---

## Feature Matrix & Scope

* **Vector Networks:** Non-linear vector geometry supporting branching paths from single vertices.
* **Boolean Operations:** Dynamic non-destructive CSG (Union, Subtract, Intersect, Exclude) calculated in Rust.
* **Auto-Layout & Constraints:** Flexible box layout models computed on Rust scene graph traversal.
* **System Font Access:** Automatic discovery and rendering of native Windows, macOS, and Linux system fonts.
* **Unlimited Local Undo/Redo:** Persistent, disk-backed command log allowing session-spanning history navigation.
