// Registration point for every shader that ships with the app. The list
// grows as the classes land: stripes proves procedural; bevel3d (sdf),
// pixelate (base) and glass (backdrop) are the exemplars for theirs, and the
// remaining looks are content once the machinery exists.

import { registerBuiltin } from '../registry'
import { stripes } from './stripes'
import { bevel3d } from './bevel3d'
import { pixelate } from './pixelate'

let registered = false

export function registerBuiltins(): void {
  if (registered) return
  registered = true
  registerBuiltin(stripes)
  registerBuiltin(bevel3d)
  registerBuiltin(pixelate)
}
