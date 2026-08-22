// Fetch the open project's shaders/ from main and hand them to the registry.
//
// Called at project open/new and from the explicit "Reload Project Shaders"
// menu action — the same import-on-use rule libraries follow (ADR-013).
// Guarded so engine tests, which have no preload bridge, can exercise the
// registry without a window.

import { loadProjectShaders } from './registry'
import { invalidateMaterialRasters } from './raster-cache'

export async function refreshProjectShaders(): Promise<void> {
  const api = (globalThis as { polyform?: { shadersList?: () => Promise<unknown> } }).polyform
  if (!api?.shadersList) return
  try {
    const files = (await api.shadersList()) as Parameters<typeof loadProjectShaders>[0]
    loadProjectShaders(Array.isArray(files) ? files : [])
  } catch {
    loadProjectShaders([])
  }
  // The generation in every cache key just changed; free the memory too.
  invalidateMaterialRasters()
}
