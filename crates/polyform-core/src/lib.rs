//! polyform-core — Rust ports of the Polyform TypeScript engine modules,
//! compiled to WASM for the renderer (ADR-002, docs/V0.4-Porting-Plan.md).
//!
//! Sprint A scope: geometry, shapes (outlines), spatial index. The pure-Rust
//! modules carry no wasm-bindgen types so they stay reusable for a future
//! native build; `wasm.rs` is the boundary layer.

pub mod booleans;
pub mod color;
pub mod components;
pub mod constraints;
pub mod geometry;
pub mod hit_test;
pub mod layout;
pub mod scene;
pub mod serialization;
pub mod shapes;
pub mod spatial;
pub mod tess;
pub mod text;

mod wasm;
