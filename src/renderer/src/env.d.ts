/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

// Vite inlines ?inline assets as data: URIs (used for the WASM engine binary).
declare module '*.wasm?inline' {
  const dataUri: string
  export default dataUri
}

import type { PolyformApi } from '../../shared/types'

declare global {
  interface Window {
    polyform: PolyformApi
  }
}

export {}
