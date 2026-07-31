/// <reference types="vite/client" />

import type { PolyformApi } from '../../shared/types'

declare global {
  interface Window {
    polyform: PolyformApi
  }
}

export {}
