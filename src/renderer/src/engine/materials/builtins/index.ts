// Registration point for every shader that ships with the app. The list
// grows as the classes land: stripes proves procedural; bevel3d (sdf),
// pixelate (base) and glass (backdrop) are the exemplars for theirs, and the
// remaining looks are content once the machinery exists.

import { registerBuiltin } from '../registry'
import { stripes } from './stripes'
import { bevel3d } from './bevel3d'
import { pixelate } from './pixelate'
import { glass } from './glass'
import { dotgrid, foil, iridescent, noise } from './procedural'
import { dither, halftone } from './base-fx'
import { neon, neumorph } from './sdf-fx'

let registered = false

export function registerBuiltins(): void {
  if (registered) return
  registered = true
  registerBuiltin(stripes)
  registerBuiltin(bevel3d)
  registerBuiltin(pixelate)
  registerBuiltin(glass)
  registerBuiltin(noise)
  registerBuiltin(dotgrid)
  registerBuiltin(iridescent)
  registerBuiltin(foil)
  registerBuiltin(halftone)
  registerBuiltin(dither)
  registerBuiltin(neon)
  registerBuiltin(neumorph)
}
