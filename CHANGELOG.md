# Changelog

All notable changes to Polyform. Versions follow the [Roadmap](docs/Roadmap.md) phases.

## Unreleased — 0.8.0

### Fixed

- **Dissolve now reads the points you selected.** It shipped able to do exactly
  one thing — find parts of a shape that OVERLAP and merge them — and
  `dissolveParts(net)` took a network and nothing else, so a selection could not
  reach it. Four points chosen either side of a seam were on screen, counted in
  the toolbar, and invisible to the command.
  - Two halves that share a seam do not overlap, they **touch**, so the honest
    answer came back "those parts do not overlap" while the seam sat there. True,
    useless, and indistinguishable from a broken tool.
  - With points selected it now removes the segments BETWEEN them and welds what
    is left, so the seam goes and the halves become one outline. Only edges with
    *both* ends selected are taken — that is what makes it aimable. With nothing
    selected it still merges overlapping parts, and that refusal now points at
    the other mode rather than stopping at a fact.
  - The weld is load-bearing: a seam is usually two edges, one per half, so
    removing them leaves two open chains with stacked ends. Without it you would
    have taken the line away and still had two parts (F-38).

- **A shape whose fill was "not being respected".** An open path cannot take a
  fill — every back end strokes it and skips the fill, which is right — but
  nothing said so: the Fill row went on showing the colour and the hex next to a
  shape that was plainly not that colour. The Fill section now says the path is
  open and what to do about it.
  - It is confusing precisely because the path **looks** closed. An outline that
    arrives in pieces (an imported `.fig` or `.svg`, or anything drawn one curve
    at a time) has ends at identical coordinates that are still separate anchors,
    with a gap of zero width between them.
  - **Close Path**, on the vector bar, welds those ends together and says whether
    that actually closed the shape. It had to exist: two anchors in the same place
    cannot be told apart by clicking, so the selection Join needs is one you
    cannot make — "join the ends" was advice nobody could follow.
  - Welding then dropped one edge as a duplicate, because two segments between
    the same pair of anchors looked like the same segment twice. **A lens is
    exactly that** — two curves sharing both ends, which is a leaf, an eye, the
    counter of an O — so the repair deleted half the shape. Duplicates have to
    match curvature, not just endpoints.
  - And a part was only called closed at three anchors or more, so every lens
    was reported open: unpaintable, and told its owner the fill had nowhere to
    go when it did. Two anchors is a closed outline (F-37).

- **The canvas going blank until you toggled GPU rendering off and on.** WebGPU
  reports its errors **asynchronously**, so `render()` returns normally whether the
  frame drew or was discarded — which meant the `try/catch` around it had never
  run once, and the Canvas2D fallback it guarded was unreachable. Nothing
  subscribed to `device.lost` at all. A device can go at any time for reasons
  that have nothing to do with this app (a driver reset, waking from sleep,
  another process taking the GPU, Chromium recycling its GPU process), and after
  that every command is silently dropped: the canvas stops being painted, nothing
  throws, and the one warning goes to a console nobody has open. The document was
  never damaged, which is exactly why it read as a mystery.
  - The renderer now reports its own death once, from either signal, and stops
    issuing commands to a dead device rather than burying the first error under
    the ones that follow. The view **rebuilds it** — which is precisely the repair
    people were making by hand — three times before giving up and staying on the
    CPU, and **says so on the status bar every time**. A renderer that restarts
    silently is one nobody can report a problem with, and that silence is why
    this lasted as long as it did (F-36).

### Added

- **Ctrl+V pastes an image from the clipboard, where the mouse is.** Copy a
  screenshot, a picture from a browser, anything on the system clipboard, and it
  arrives as a layer under the pointer — the same rectangle with an image fill
  that File → Import Image produces, so it behaves identically afterwards. It
  drops into the frame it lands on, and scales down if it would otherwise fill
  the screen.
  - Nothing in the app had ever read the system clipboard. `paste()` only knew
    about layers copied in Polyform, so an image on the clipboard was invisible
    to it — and the renderer cannot see one either: Ctrl+V is claimed by the
    menu accelerator, so the page never gets a `paste` event and there is no
    user gesture for the async Clipboard API to hang off. It goes through main.
  - **Which one you get is decided by what was copied last**, and the OS cannot
    be asked that — there is no "when did this change". It does not need to be:
    any copy, in any application, empties the clipboard first. So an image being
    there at all means it is the newest thing, and Copy claiming the clipboard
    is what makes that true the other way round.
  - **Pasted layers land at the pointer too**, centred on it as a group, with
    the old offset-by-ten kept for when the mouse is off the canvas — from the
    menu, or parked over the inspector, "here" has no meaning and the middle of
    the view is the honest answer.
  - Gated end to end with a real image written to the real Windows clipboard by
    PowerShell, because "an image copied in another application" is the whole
    feature and nothing of ours can stand in for it.

- **Ctrl+C, Ctrl+V and Ctrl+A work inside text fields.** They never had. All
  three are menu accelerators, which are claimed before the page sees them, so
  the app acted on the selected LAYERS however they were pressed — pasting into
  a layer name did nothing to the name, and Ctrl+A while renaming selected the
  whole document. When a field has focus they now perform the native edit on it.

- **Selection colors.** Select a frame — or anything with layers inside it — and
  the inspector lists every colour used in there, grouped, most-used first. Each
  is a row laid out like the Fill row below it: swatch, the hex as an editable
  field, and how many places use it. Type a new hex, or click the swatch for the
  picker; either way every one of those places changes at once, as a single undo
  step.
  - Grouped by the COLOUR, not by the layer: a fill and a stroke of the same brown
    are one swatch, because "the brown in this drawing" is the thing being edited.
    Gradient stops count individually — a two-stop gradient is two colours, and
    they are the ones somebody wants to change.
  - A hidden PAINT is skipped; a hidden LAYER is not. A layer you switched off
    still carries its colour, and dropping it would make the palette shift as you
    toggle visibility, which reads as the tool losing track of the document.
- **The colour row is a colour row now, not a dropdown.** The hex was the selected
  option of a `<select>` whose real job was picking the paint type — one control
  doing two things, and neither well: the value could not be selected to copy,
  could not be typed into, and the type picker hid behind something that looked
  like data.
  - The hex is a field: click it and it selects itself, so copying is click and
    Ctrl+C; type over it to set a colour, with or without the hash, three digits
    or six, any case. Anything unreadable is put back rather than committed.
  - **Opacity sits beside it**, because it is half of what a colour is and
    reaching it meant opening the picker and finding the alpha slider. The two
    fields keep out of each other's way — typing a hex leaves the alpha alone.
  - The paint type moved into the colour picker, which already had tabs for it.

- **Line ends you can choose: none, round, square, arrow, circle, diamond** — set
  independently at the start and the end, from the Stroke section. An arrow at
  one end and nothing at the other is the commonest thing anyone wants from this,
  and it is the case a rasterizer setting cannot express at all.
  - Built as filled GEOMETRY rather than `lineCap`. That setting applies to both
    ends of every subpath at once, so the moment the two ends can differ it is
    out of the running — and it has no arrowhead in it. Shapes cost a little more
    and buy three things: independent ends, arrowheads at all, and all three back
    ends drawing the same thing, because each is only filling a subpath.
  - Cap size scales with the stroke weight — a head that kept its size while its
    line thickened would end up narrower than the line it finishes. The direction
    comes from the curve's TANGENT, not the chord to the next anchor, so an arrow
    on a curve points where the path actually goes.
  - Absent on closed outlines, which have no ends: the control is not shown there
    rather than shown and ignored.
- **The pointer is drawn from a file you can edit.** `resources/cursor-arrow.svg`
  is the source; `node scripts/make-cursor.mjs` turns it into the path data the
  renderer uses, the same arrangement the logo already had. Draw a new arrow in
  any tool that exports SVG, drop it in, re-run. The hotspot is read from the
  shape's first point, so the tip and the aim cannot disagree — and the file says
  what the renderer needs from it: geometry only, no colours, tip clear of the
  edge, bottom-right kept free for the badge.
  - The arrow is rounder now — a round-joined stroke in its own fill colour,
    which softens the corners of whatever is dropped in, plus fillets drawn into
    the shape itself. The two compose; the stroke only ever adds.
  - **The corner under a rounded tip is reconstructed.** The hotspot had always
    been "the first point of the path", which is the tip only while the tip is
    sharp. Round it and the path starts *beside* the point, so the aim drifts a
    pixel diagonally and further as the radius grows. A fillet is a corner that
    was cut off, though, and it comes back exactly: the two tangents are
    extended and the hotspot is where they meet.
  - It keeps the white-over-black treatment even though most reference art for
    cursors is solid black: a black arrow is invisible on Polyform's own canvas.
  - **And "edit it in Polyform" now actually works.** That sentence had been in
    the file since it was written, with a test on each side of it and none across
    it. A real export would have made the frame's white background the outline —
    hotspot in the corner, arrow demoted to a hole in a white square — because
    node transforms live on wrapper `<g>` elements the reader never looked at and
    the 1024 viewBox came through as the box the badge is measured in.
    `scripts/cursor-svg.mjs` now flattens the transforms, rescales any square box
    into the renderer's 30 units, and ignores the background and the unfilled
    guide layers — printing what it ignored, and refusing with the fix in the
    message when it cannot. The gate runs the **real** exporter over a scene
    shaped like the real frame (F-39).

- **Drag a box over anchors to select them** in vector edit, including anchors
  sitting on top of each other. That pair is the whole reason it exists: clicking
  reaches whichever one the hit test found first and clicking again reaches the
  same one, so the selection Join needs was one nobody could make (F-37). A box
  does not care how many are under the pixel. Shift adds rather than toggles —
  crossing the same anchor twice during one drag is ordinary, and a toggle would
  quietly drop it again.
- **One pointer for the whole app, and it says what the click will do.** The
  cursor is our own arrow everywhere the pointer is just pointing, with a badge
  beside it naming the action: a plus for Add and the pen, a minus for Delete, a
  slash for Knife, a drop for Paint, a hook for Bend. The arrow never changes,
  which is what makes the badge readable — the eye tracks one shape and reads the
  change beside it. `engine/render/cursors.ts` is the one place any of them is
  defined; every string is memoised, because the cursor is read on every pointer
  move.
  - The badges were designed at the size they are actually seen. A four-way arrow
    with proper heads, an arc thick enough to notice, and an X for the knife all
    read fine blown up and turned to mush or to the wrong word at 13px — the X in
    particular is what `remove` looks like, and two badges that mean different
    things must not share a silhouette.

- **Six new tools in vector edit, and the pointer to use them with.** The bar
  under an open path is now Move / Add / Bend / Knife / Paint / Delete, with Join,
  Bridge and Dissolve beside them as commands on what you have selected.
  - They all turn on one idea the network never had a name for. A VECTOR node is
    a flat bag of vertices and edges, and which of them belong to the same
    outline is only ever implied by what is connected to what — so `.fig` and
    `.svg` imports, and anything with a hole in it, arrive as several detached
    outlines the editor could not talk about. `engine/vector-parts.ts` answers
    that once; everything below reads it.
  - **Add** — a dot rides the outline showing where the point will land, and a
    click places it. Clicking a point that already exists hands the gesture to
    Move rather than stacking a second anchor on the first: two points in the
    same place cannot be told apart afterwards, or selected separately.
  - **Knife** — drag across a shape, or click twice, and it becomes two closed
    outlines; the ends snap to anchors, which is what makes dot-to-dot a gesture
    rather than a steady hand. One stroke cuts every outline it crosses.
  - **Join** and **Bridge** — a segment between two points, and one segment per
    pair across two detached parts. Bridge pairs by shortest total length, so
    the order you happened to click in is not mistaken for a statement about
    which point goes with which.
  - **Dissolve** — two overlapping parts become one outline, repeated until
    nothing overlaps. It reports the part count every time, because it is the
    one command here whose success is invisible: two overlapping shapes of the
    same colour look identical before and after.
  - **Paint** — a bucket that gives one part of a shape its own fill, with its
    own colour well. Splitting the parts into separate nodes would have been the
    other answer and it is the wrong one: they are one shape, they move
    together, and Bridge or Dissolve can prove it. Stored as `partFills`, a set
    of EXCEPTIONS keyed by the part's smallest anchor id — a part with no entry
    keeps the node's fill, and a part whose anchor is gone falls back to it
    rather than inheriting a colour that belonged to a different outline.
  - **Neither the knife nor dissolve is a boolean**, though the Rust core does
    exact bezier CSG and would have made both nearly free. That binding returns
    POLYGONS, so either tool built on it would have quietly replaced every curve
    it did not touch with a polyline. Both walk the outline instead — De
    Casteljau splits at the crossings, then the ring rebuilt — so the rest of
    the shape comes through exactly as it was.
  - **The cursor in vector edit is our own arrow now**, with the hotspot on the
    tip. A crosshair is the right cursor for PLACING something, and the wrong one
    for pointing at something already there: its arms sit on top of the anchor
    you are reaching for, and the part you aim with is a gap.

- **Collapse the whole layer tree, then open the one branch you want.** A ⋯ menu in
  the layers tab strip: **Collapse All**, **Expand All**, **Expand Selected**. On a
  document with any depth the tree is mostly rows you are not looking at, and the
  only way back was clicking every triangle shut.
  - **Expand Selected opens the path DOWN to the layer, not just the layer.** After
    Collapse All a nested row does not merely sit folded — it is absent from the
    list, so unfolding the node alone would scroll to nothing and read as a dead
    command. Its ancestors open, then it, then its whole subtree, because “expand
    this” means “show me what is in it” and one level at a time is the clicking
    being replaced. Other branches are left folded, and expanding a second layer
    keeps the first one open.
  - It is on the **object’s context menu** as well, which is the point: once the
    tree is collapsed the layer you want is on the canvas, not in the list. Given
    from there while the Assets tab is showing, it switches back to Layers —
    otherwise the command would be correct and invisible.
  - Which rows are folded is view state: not recorded, not undoable, not saved. The
    rules are in `engine/layer-collapse.ts` so both callers share one answer, and an
    e2e gate drives the real ⋯ menu and a real right-click on the canvas, because
    nothing in the document changes and no unit test can see a row appear.

- **Gradients on a STROKE are editable at all.** The stops bar and the new direction
  control are gated on a gradient-mutation handler, and only the *fill* row ever passed
  one — so a gradient stroke could be created and then never edited: no stops, no
  angle. That is the gradient most people meet first, on a line, and it is why "I still
  can't rotate the gradient" was true after the direction control shipped. The fill
  case passing is exactly what hid it.
- **Gradients have a direction you can type.** A number field (0° runs left to right,
  90° top to bottom), a *turn 90°* button, and *reverse the stops*, on every linear
  gradient. Before this the direction was whatever the file happened to contain, with
  no way to change it. The angle is the angle **on screen**: it is computed through
  the box the paint is painted in, because unit space is not square and "45°" in a
  600×40 band points nowhere near 45°. Turning keeps the gradient's centre and spans
  the shape the way CSS does, so a rotation feels like turning a dial rather than
  rescaling the ramp.
- **The colour picker opens beside the panel instead of over it.** It is placed clear
  of the *whole inspector*, not of the swatch that opened it — measuring from the
  swatch left it three pixels over the panel border, which reads as a bug rather than
  a near miss. It flips to the other side only if the window is too narrow.
- **A stroke can have a different weight on each side.** Top, right, bottom and
  left, the way a corner radius already has four corners — the toggle sits beside
  the weight field and splits it into four. 0 turns a side off, so a rule under a
  heading or a border open on one edge is two clicks and a number. Rectangles,
  frames, components and instances: the four types that carry a radius, because
  only a box has sides, and the control is absent rather than inert elsewhere.
  - **Four widths are not a stroke.** There is no single width to hand a
    rasterizer, so the weights become a *region* — the space between the shape
    grown per side and the shape shrunk per side — and all three back ends fill
    that same region (`engine/strokesides.ts`): Canvas2D fills it, the GPU
    tessellates it and skips its stencil clip, SVG export writes it as a filled
    path because `stroke-width` is singular and writing one would export a border
    the document does not have. A stroke computed three times is a stroke that
    comes out different on the GPU (F-34).
  - Mitred corners and the corner radius carried through both offsets fall out of
    that geometry rather than being special-cased: a side set to 0 pinches the
    ring to nothing along that edge and its neighbours meet in the corner on their
    own. Inside, centre and outside all keep working.
  - **Collapsing the control clears the weights** instead of leaving them stored
    and invisible — a per-side weight the renderer still draws while the panel
    shows one uniform field is exactly the kind of lie F-30 is about. It is an
    `npm run test:e2e` check, along with the toggle opening and a typed value
    landing on the node, because a correct model behind a button that does nothing
    is how the styles feature shipped broken for two releases (F-31).
  - Dashes stay off the table while sides are in use: a dash pattern needs one
    continuous band to run along. The Style dropdown says so rather than storing a
    pattern nothing draws.
  - **Any closed shape, not just a box.** The first version allowed only the four
    types carrying a corner radius, on the grounds that a box has four edges to
    offset and a path does not — and the first thing it was tried on was a
    rectangle-with-a-wavy-top that wanted a rim along the wave. Every closed shape
    has a bounding box with four sides, so an ellipse, star, polygon, boolean or
    closed path takes per-side weights too. Its outline is split into **runs by the
    way each stretch faces** — outward normal pointing up means top, within 45°
    either way — and each run is stroked at its own weight, ending square. Runs are
    grouped by weight, so two sides set alike stay one continuous run with a proper
    join, and four alike collapse back to the plain closed outline with its curves
    unflattened. Text, groups, 3D models, open paths and lines are still excluded,
    and the control is absent there rather than inert.
  - The first attempt at that generalisation clipped the whole stroke to a **wedge**
    of the bounding box, and it was wrong in the one case people reach for: with the
    neighbouring sides at 0 there is no band to mitre against, so the diagonal is
    left showing and slices the band off at 45° near each corner instead of letting
    it run to the edge and stop. Reported within minutes of shipping, on a
    rectangle with a wavy top wanting a rim along the wave (F-35).
  - Also reachable from the agent surface (`edit_document`'s `strokeSides`), and
    inherited by instances like any other visual prop.
- **A shape's layer icon is the shape.** Rectangles, ellipses, polygons, stars,
  vectors and booleans draw their own silhouette as the row icon in the Layers panel,
  the way Figma does — so a group of seven layers all called *Vector* reads as
  **D I G B O R N** instead of as seven identical glyphs. The outline comes from the
  same `nodeOutline`/`booleanRings` the renderers draw, so an icon cannot drift from
  its layer; it is cached per scene version, and a path with more detail than 12 pixels
  can show falls back to the type icon. Frames, groups, components, text and models
  keep theirs, and an image-filled rectangle still shows the image icon.
- **Selecting on the canvas reveals the layer.** The row scrolls into view, and if the
  layer sits inside a collapsed group the group expands first — previously there was
  no row to highlight at all, so the panel looked like it had not noticed.
- **Updates download and install themselves now, and the UI says what is happening.**
  A badge appears in the title bar the moment an update is found — *Update
  v0.8.0-beta.21*, then a progress fill while it downloads, then a green *Restart to
  update* — and it is absent the rest of the time, because a permanent "up to date"
  chip is noise. The welcome screen's cramped line became a panel: the state in a
  sentence, one primary action, release notes, and three preferences (check on launch ·
  include betas · install automatically).
  - **Installing is user-initiated, or opted into, and never silent by default.**
    Nothing is code signed yet, so electron-updater still has no signature to verify
    (F-10, ADR-028). What changed from v0.7 is who decides, and with what in front of
    them: the words *"not code signed yet"* sit beside the button.
  - **macOS says so instead of pretending.** Squirrel.Mac applies an update only if it
    is signed by the running app's team and wants a `zip` feed rather than a dmg, so
    there the button opens the release page. The renderer learns that from `canInstall`
    rather than repeating a platform check.
  - Verified end to end on a packaged build: a real 137 MB download from the release,
    through *available* → *downloading* → *Restart to update*.
- **A beta channel you can opt into, and a branch layout that feeds it.** `staging`
  and `production` now mean two different kinds of release: every push to `staging`
  publishes `0.8.0-beta.<run>` as a GitHub **pre-release**, and a version bump on
  `production` opens a stable **draft** for a human to read and publish. In Polyform,
  tick **betas** next to *Check for updates* on the welcome screen and it starts
  telling you about those builds; untick it and they are gone.
  - **Off by default, and "off" means unreachable rather than unoffered.** The
    checkbox sets `allowPrerelease`, which decides *which GitHub endpoint the updater
    resolves*: with it off, that is `releases/latest`, and GitHub excludes
    pre-releases from it. There is no beta to skip.
  - **A beta is a published pre-release, not a draft** — a draft has no tag and is
    hidden from anyone without push access, so nothing an updater could fetch exists.
    That is why "trigger a draft build" cannot drive auto-update, and pre-release can.
  - **It still only tells you.** Ticking betas changes which versions Polyform will
    mention, not what it will run: nothing is signed, so there is no signature for
    electron-updater to verify, and a beta is less reviewed than a release, not more
    (ADR-028 amendment, F-10).
  - Every beta passes the same gates a release does — unit tests, the input-layer e2e
    gates, the CLI gate, and a packaging smoke test on all three platforms — and old
    betas beyond the newest ten are deleted with their tags, so the release list stays
    readable.

### Added

- **Loading a file says so.** A spinner and a label — *"Digborn.fig: writing 183
  images…"*, then *"placing 4,587 layers on 4 pages…"* — plus the wait cursor, for
  `.fig` and SVG import, opening a project, and placing images or a 3D model. A 90-
  second import with no feedback is indistinguishable from a hung app.
  - **The label is painted before the work starts, on purpose.** The expensive half
    of loading a file is synchronous, so setting a label and beginning in the same
    tick shows nothing: the frame it belongs to would render after the thread frees
    up, by which time it is stale. Each step yields for a frame and then once more
    through the task queue, so what you read is what is *about* to happen. Verified
    by starting an import and screenshotting while the thread was blocked.
  - The wait cursor is set on `<html>` with `!important`, because the canvas rewrites
    its own cursor inline on every frame (F-23) and anything less loses to it.
- **The zoom control is a menu, not a −/+ box.** Click the percentage and you get a
  field with the current zoom in it, already selected — type `250`, press Enter — over
  rows for zoom in/out, fit, focus on selection, and 50/100/200%, then the view
  toggles with a tick beside the ones that are on: grid, rulers, GPU rendering. The
  old box could do three things and hid the rest: "zoom to 200%" meant right-clicking
  a button whose tooltip mentioned presets, and there was no way to ask for an exact
  number at all.
  - **The command rows are built from the shared menu definition**, so their labels and
    shortcuts come from the same place the menu bar and the native accelerators do,
    and they run through the same `menuInvoke` — one implementation per command. The
    percentage and the two presets have no menu item behind them and set the camera
    directly, through a new `zoomTo` that keeps the middle of the viewport where it is
    (a factor cannot: 1.25 × 0.8 does not return to where it started).
  - **The zoom limits now live in one place** (`engine/zoom.ts`) instead of three
    copies of `0.02`/`64` — the typed field cannot offer a zoom the camera would
    refuse. A bare number is a percentage, a comma decimal is accepted, and anything
    that is not a number leaves the camera alone rather than moving it to NaN.

### Changed

- **The GPU renderer is the default.** Wherever the machine exposes a WebGPU device
  the scene now draws through the batched WebGPU pipeline — 100,000 shapes panning at
  60fps against a Canvas2D budget aimed at typical documents — and its 14 pixel-parity
  fixtures (shadows, blurs, all 16 blend modes, masks, shaped text) were re-run on the
  way in — 17 by the end of the release, the three new ones being masks (F-34). No device, or a device that fails to initialise, still falls back to Canvas2D
  by itself, and View → GPU Rendering still turns it off; a preference you set is
  remembered and the default never overrides it.
  - **The tick follows what is drawing, not what was asked for.** The editor now keeps
    the preference and the live state apart, so on a machine with no WebGPU device the
    row reads as off — with the reason in its tooltip — instead of claiming a renderer
    that is not running (F-30). It is also the honest answer to "am I on the fast one?"
- **The loading spinner sits under the rulers**, centred on the canvas rather than the
  window. It was crossing the ruler, which is a scale you read.
- **The bottom bar's controls are one height.** The agent button was 21px, the focus
  button 30px, and the zoom box 21px in a 40px row — three heights on one line. All of
  them, and the vector-edit buttons, are now 30px, matching the tool buttons in the
  middle. It is an `npm run test:e2e` check, because this is the kind of thing that
  drifts one utility class at a time.

### Fixed

- **Duplicate puts the copy where the original is.** Ctrl+D inserted into
  whichever container the viewport had been entered into — the page root unless
  you had drilled into something — so duplicating a layer inside a frame lifted
  the copy out of the frame, and out of its clipping and auto layout with it. Each
  copy now goes in beside its original; a selection spanning several parents is
  grouped so every copy lands in the right one, still as a single undo entry.
  Paste is unchanged and still lands in the container you are in, which is the
  point of paste.
  - A copy of something *inside an instance* goes beside the instance rather than
    into it: those children are regenerated from the component on every sync, so a
    copy placed among them would be wiped by the next pass.
- **Masks clip to what the mask actually covers** (F-34). Reported as "the subtraction
  isn't working" on an imported `.fig`, and the subtraction was fine: the mask over it
  was clipping to a bounding box. A mask's shape came from `nodeOutline`, which answers
  *what box is this in* — right for selection, wrong for a mask. So a **group** of seven
  letterform shapes clipped to a 948×155 rectangle, **text** clipped to its text box,
  and the wave that should have shown only inside the letters showed as a bar.
  - **A group masks with the union of its contents; text masks with its glyphs.** One
    function (`engine/mask.ts`) answers this for all three back ends — Canvas2D clips
    with it, the GPU tessellates it into a stencil mesh, SVG export writes it into a
    `<clipPath>` — because a mask shape computed three times is a mask that comes out
    differently on the GPU. A frame still masks with its own rectangle: a frame has a
    shape of its own and already clips its children to it.
  - **The two renderers disagreed about even-odd masks.** Canvas2D clipped every
    non-boolean mask nonzero while the GPU tessellated the same node even-odd, so an
    imported subtracted shape used as a mask rendered differently depending on which
    renderer was drawing — in the release that made the GPU the default.
  - **SVG export ignored masks completely.** `isMask` appeared nowhere in the exporter,
    so a mask was written out as a filled shape *on top of* the artwork it should have
    cut out. Every masked design exported wrong, and it exported as a plausible solid
    shape rather than as an error.
  - **The GPU ignored masks at the top level of a page.** Its bake walked the page's
    roots in a bare loop, while the only place `isMask` was read handled every other
    sibling list — so a mask on a top-level layer did nothing on the GPU and worked on
    the CPU. Found by the new fixtures, which failed at 23.46% differing pixels: exactly
    the area of the rectangle that should have been clipped.
  - **Three fixtures where there was one.** The old mask fixture used an ellipse inside
    a group — a plain shape, in the one position where masks worked, under the one fill
    rule both renderers agreed on, and green for months.
    `mask-group-coverage` / `mask-evenodd-vector` / `mask-text-glyphs` now cover the
    kinds; 17/17 pass, GPU perf unchanged (0.19 ms CPU per frame at 100k shapes).
  - Still a hard clip: no luminance masks and no soft alpha, so a semi-transparent mask
    cuts rather than fades — identical for the solid shapes nearly every mask is made
    of, and declared per file by the importer.
- **`.fig` import: a Figma group is a group** (F-34). The type `GROUP` is in Figma's
  schema and appears in no real file — a group is a `FRAME` that resizes to fit its
  children, and 538 of one file's 750 frames are groups. Reading them all as frames
  clipped content Figma draws in full, and made the logo's letterform mask clip by its
  rectangle instead of by its letters. Measured rather than guessed: every frame still
  named `Group N` / `Mask group` carries the flag (258 of 258, no counterexamples), and
  none of the file's 44 auto-layout frames does — so it is not "hug contents". The file
  now imports as 530 groups, 189 clipping frames and 15 masks (4 group, 4 text,
  5 vector, 2 rectangle).
- **`.fig` import: instances come through with their contents** (F-33). An `INSTANCE`
  in a `.fig` has **no children at all** — it is a `symbolID` plus overrides, the same
  shape as ours — so importing it as a frame produced an empty box, which is exactly
  what it looked like next to the component it was a copy of. A Figma component is now
  a Polyform component and an instance a linked instance, so the engine materialises
  its contents from the component and editing the original updates the copies.
  - The link is resolved *after* the walk: a symbol is usually written after the
    instances that use it, so its id does not exist while they are being mapped. An
    instance whose component is not in the file (a library component) becomes a plain
    frame and says so, rather than a copy of nothing.
  - The importer leaves an instance's children empty on purpose — filling them in
    would build a detached duplicate that no longer follows its component.
  - An instance's **own overrides are not carried**: it shows the component as
    designed. Reported per file.
  - Found while fixing it: `walk` assigned children only to a frame or a group, by
    name, so components linked correctly and still arrived empty. Both places that
    made that decision now ask `isContainer`, which already existed.
  - The rest of that screenshot — the DIGBORN logo as a brown bar — was the mask over
    it, not the import. Fixed separately, below (F-34).
- **`.fig` import: pages are pages, subtractions have holes, masks mask, and a
  component keeps what is inside it** (F-32). Four separate defects, found against a
  4,825-node file and each measured against what the file itself says.
  - **A Figma page becomes a Polyform page**, named the same, at the file's own
    coordinates. Everything used to land on one page with each page after the first
    shoved sideways so they did not overlap — a way of coping with pages rather than
    creating them. The page-add lands in the same commit as the nodes, so the whole
    import is still one undo, and an untouched document's starter page is reused so a
    fresh project gets the file's pages and nothing else.
  - **Even-odd paths arrive even-odd.** Figma's winding rule is spelled `ODD`; we
    compared against `EVENODD`, which is *our* word for it and a value a `.fig` never
    contains — so every even-odd path since the feature shipped came in as nonzero,
    and a subtraction's hole filled itself in. 56 paths in this one file. Their enum
    is in the schema the file carries: `WindingRule => NONZERO, ODD`.
  - **Masks come across as masks.** `mask: true` was never read, so 13 masks arrived
    as 13 opaque shapes covering the artwork they were meant to cut out. The renderer
    has done Figma's mask semantics all along.
  - **Components and instances keep their contents.** Neither counted as a container,
    so each mapped to a bare path made from its own background and then had its whole
    subtree deleted as if it were a boolean's operands — 26 components, 8 instances.
    Operand-dropping now keys off the *Figma* type instead of guessing from what our
    own mapper produced.
  - **Figma's `internalOnly` holding canvas is left out** — component definitions it
    has moved aside, deleted nodes, brushes. It is not a page in Figma, and it was
    arriving as the largest page in the document (477 roots).
  - Verified end to end on that file, in a real project: 4 pages (Assets, Banner,
    Tilemaps, RadMiner), 13/13 masks, 183 images, 4,587 layers, and the winding
    change proven to alter the picture by forcing every vector back to nonzero and
    diffing the screenshots. All four bugs were put back to watch their tests go red.
  - **Not fixed, and now measured properly:** a file this size takes about 90 s to
    import — 20 s to read, decode and cross the IPC boundary, **65 s writing its 183
    images**, 1 s mapping and 4 s committing 4,587 layers. The images are the cost,
    and the shape is worse than slow: main reads them out of the archive, ships them
    to the renderer, and the renderer sends them back one at a time to be written.
- **Frame names no longer pile into each other when you zoom out.** They were drawn
  at a fixed 11px whatever the zoom, so a sheet of a hundred small frames became a
  wall of overlapping text with the artwork somewhere underneath. Names now shrink as
  you zoom out — `sqrt(zoom)`, not `zoom`, because tracking the camera exactly puts a
  name at 5px by the time you are at half size, which is a zoom people work at — and
  hold at 8px rather than dwindling to nothing. Below that the answer is fewer names,
  not smaller ones: a name is dropped when its frame is under 16px wide on screen, and
  when it would be drawn over a name already placed. Zoomed out on a 72-frame sheet
  that is 31 names with no overlap instead of 72 in a heap; at 100% nothing changed.
  - **What you can click is exactly what you can see.** The pointer path shares this
    function, so a dropped name is not a hidden click target — and both sides now pass
    the viewport, which keeps the collision pass proportional to the screen instead of
    the document.
  - **Which names survive is decided in world space**, so panning and zooming cannot
    make them flicker in and out; only a real change in what overlaps does.
- **Shared styles could never be created, so the whole feature was unreachable**
  (F-31). Both "+ Style" buttons — Fill and Text — started with `window.prompt`, and
  **Electron does not implement `prompt()`**: it throws. The throw landed in devtools,
  so the button did nothing at all, visibly or otherwise. Those buttons were the only
  way to mint a style, and the "Apply style…" dropdown, the Color/Text styles sections
  and the library style importer are all gated on one existing — so a section of the
  product documented as working had never been reachable. Reported by a user asking
  what the button does.
  - **A style is born named, and renamed in place.** `135BEC` from the paint,
    `Inter Bold 24` from the text, `135BEC 2` when that name is taken; double-click
    the name to change it, on the applied chip as well as in the Styles panel, so
    naming no longer means deselecting the layer. No dialog — this is a desktop app
    that cannot show that particular one.
  - **A colour style no longer eats the fills above it.** Applying or editing one
    replaced the layer's entire fill list; a style is a single paint, so it owns the
    first fill slot and leaves the rest of the stack alone.
  - **A gradient style can no longer be flattened by accident.** The Styles panel's
    picker writes a solid colour, so its swatch is no longer clickable on a gradient
    or image style. Both of these were latent for as long as the feature was dead.
  - The click itself is now an `npm run test:e2e` gate — a real press on the button,
    then a read of the document, plus the double-click rename — and it was confirmed
    to fail with the `prompt` call put back (F-22).
- **The update feed was never published, so "Check for Updates" could not have
  worked for anybody** (F-29). electron-updater does not ask GitHub for a version
  number; it fetches a metadata file out of the release's assets (`latest.yml`,
  `latest-mac.yml`, `latest-linux.yml`) and raises
  `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` without it. The release workflow uploaded the
  installers and the checksums — **not the yml**. Every check we had looked at the
  app side (`app-update.yml` is present and points here) and nothing ever asked
  GitHub for the file that app then goes on to fetch.
  - The two halves also disagree about the *name*: electron-builder writes one
    channel file for the GitHub provider (`latest*.yml`, whatever the version says —
    `computeChannelNames` returns `[currentChannel]` unconditionally there, and its
    docs say the channel is "never auto-detected"), while the updater derives the name
    from the tag it picked (`v0.8.0-beta.7` → `beta.yml`). So each release now
    publishes **both** names from the one build, which also covers the beta user being
    offered the stable release that supersedes their build.
  - `npm run test:feed` reproduces `GitHubProvider.getLatestVersion()` against the
    live repo — read `releases.atom`, derive the channel from the newest tag, fetch
    each platform's feed file, check the version it declares, HEAD every file it names
    — and runs in the pipeline on every beta. It also asserts the property the opt-in
    rests on: `releases/latest` must never resolve to a pre-release.
- **Both workflows pointed at `main`, which no longer exists**, so nothing would have
  run at all on either new branch.
- **The update check crashed in every packaged build** — `Cannot set properties of
  undefined (setting 'autoDownload')` — and this is the same F-29 story a second
  time. `electron-updater` is CommonJS, the main process is ESM, and
  `const { autoUpdater } = await import('electron-updater')` depends on Node's CJS
  lexer finding that name. It cannot: `autoUpdater` is a lazy
  `Object.defineProperty(exports, …, { get })`, not the re-export form the lexer
  recognises. Every *other* export is visible, which is why nothing looked wrong.
  Resolved through both module shapes now, with an explicit error if neither works.
- **A 0.8.0 install with betas on was offered `0.8.0-beta.19`**, which is older. The
  "is there an update" test was `version !== app.getVersion()` — a string comparison,
  so anything merely *different* counted. Now it asks the library
  (`UpdateCheckResult.isUpdateAvailable`), which does the semver comparison and
  honours `allowDowngrade`.
- **The packaged app's update check is now a gate** (`scripts/update-check-gate.mjs`,
  inside `npm run test:packaging`, all three platforms). Everything in
  `checkForUpdates` sits behind `if (!app.isPackaged) return`, and every other gate
  drives the app *from source* — so the whole function was dead code under test, which
  is how it accumulated three defects. The gate drives the installed binary through the
  same IPC the button uses, with betas off and on, and fails only on
  programming-error-shaped results: offline and "nothing published" are legitimate
  answers, a `TypeError` is not. Shown red against the bug before being trusted.
- **Update errors say what happened.** electron-updater reports "no published stable
  release" as *"Cannot parse releases feed"*, which reads like corruption — you get
  "No release has been published yet, so there is nothing to update to." A missing
  feed file (the F-29 failure) likewise names itself instead of showing a stack trace
  about a yml file.

## 0.7.0 — "Distribution & .fig Import" — 2026-08-05

### Added

- **`.fig` import — File → Import .fig…, experimental and honest about it** (ADR-029). Reads a Figma export on your machine, offline, and turns it into ordinary editable layers in **one undoable entry**. On three real v106 exports every mapped node is checked **corner for corner against the matrix it came from** — 350 nodes, 0 misplaced — producing **95/158, 60/63 and 108/139** layers. What is not turned into a layer is Figma's own DOCUMENT and CANVAS wrappers (deliberately unwrapped, so nothing arrives inside boxes nobody drew) and the operands of flattened booleans (deliberately dropped, because the flattened result already *is* them combined).
  - **Shape comes from Figma's own flattened geometry**, not from reverse-engineering their editable vector network — every shape node carries its path in node-local coordinates, which is the space our vector networks already use. So booleans, stars, arcs, rounded rectangles with four different radii and glyph outlines all arrive looking right, as paths you can still edit. Where a native type is an exact fit (frame, rectangle, ellipse, line, text) it is used instead, because a rectangle whose radius you can still change beats a four-point path. The path ops were *derived*, not guessed: a 1024×1024 frame's fill is 46 bytes and parses exactly as MOVE + 4×LINE + CLOSE, all 93 geometry blobs in three files consume exactly their own length under one consistent assignment, and a 64×64 ellipse decodes with control points at the circle kappa.
  - **The layer tree is rebuilt** from GUIDs and `parentIndex.position` — a fractional index, an ordering *string*. Sorting those lexicographically reproduces the layer order you saw; using array order would reproduce the order your edits happened to be made in.
  - **Images become content-addressed assets**: their SHA-1 is re-hashed into our SHA-256 `assets/`, so the same bitmap from two files lands on disk once. 22 images out of one file, verified.
  - **It tells you what it could not carry.** A summary after every import: ellipse-as-path, boolean flattened (operands lost), gradient angle reset, text re-shaped by our own engine so wrapping may differ, per-range text styles collapsed, skew reduced to rotation, auto layout frozen into positions. Prototyping, variables and library links are not imported at all and say so. The full fidelity report is in [Fig-Import-Spike.md](docs/research/Fig-Import-Spike.md).
  - No new dependencies, and nothing leaves your machine.

- **`.fig` reading: the container and its Kiwi decoder, verified against real exports.** Not an import command yet — see below for what is left — but the hard half of the format work is done and tested. A `.fig` is a ZIP holding `canvas.fig`, which carries **its own schema**, so the decoder reads the schema out of the file it is decoding and never hardcodes a field name or chases Figma's releases. Ships as pure engine code (`engine/import/fig/`) with **21 tests**: the schema round-trips through an encoder written in the test, the float encoding is pinned to exact bytes (a wrong rotation yields plausible garbage, so approximate assertions would hide it), and error paths name what is wrong instead of throwing on an offset. No new dependencies: `zlib.zstdDecompressSync` exists in both Node 24 and Electron 38's Node 22.22, the ZIP is a 60-line central-directory read, and the Kiwi decoder is ours. Two published descriptions of the format turned out to be wrong and are corrected in [the spike](docs/research/Fig-Import-Spike.md) — chunk 0 is **raw** deflate, not zlib-wrapped, and the ZIP entries are stored. Reading three real v106 exports end to end: 158, 63 and 139 nodes, with paints, strokes, text, images and 82/30/65 geometry blobs. **`VECTOR` is the most common node type in all three**, which decides the order of the remaining work: the geometry blobs are the feature, not a follow-up.
- **A trademark policy** ([TRADEMARKS.md](TRADEMARKS.md)), and the product describes itself in its own words. Polyform is an independent project; other products are named in the docs for comparison and identification only, and the comparison matrix says so at the top. Nothing in the app's interface names another vendor — every such mention was already a code comment — and there is no borrowed logo, wordmark, typeface or brand colour anywhere.

### Fixed

- **A gradient stroke on a line painted nothing, and "Align" was a control that
  lied** (F-30, reported from an imported file). Both come from one fact that is not
  an edge case: a LINE has height 0 — that is what a line *is* here.
  - A paint's start/end are unit coordinates mapped through the node's box, so on a
    line the vertical axis collapses and the default vertical gradient's two ends
    land on the *same point*. Canvas2D paints a zero-length gradient as transparent
    and the GPU shader has no axis to project onto: weight 65, colours set, nothing
    on screen, no error. Strokes now map through the box the **stroke covers** — half
    its weight either side of the path — from one shared function, so Canvas2D and
    WebGPU cannot drift (`engine/paintbox.ts`).
  - **A line's stroke can now sit to one side of the path**, which is what picking
    "Inside"/"Outside" on a line always looked like it would do. Previously both
    renderers forced Center while the inspector stored and displayed Outside — a
    control that lied. (Briefly it was disabled instead; that was the wrong half of
    the fix. "No interior" rules out the clipping trick closed shapes use, not the
    feature.) A LINE is a straight segment, so the offset is an exact translation:
    ±half the weight, in both renderers, with the gradient box moving with the band.
    Open *curved* paths stay centred — offsetting those is a curve-offsetting problem
    rather than a translation — and there the control is disabled with the reason in
    its hint.
  - Verified by sampling canvas pixels across the band — red → purple → blue — not by
    reading the model back, which was correct all along and is exactly why no test
    caught it.
- **`.fig` import placed rotated layers wrongly, and five other things** (F-28). Found by rendering the three test files next to Figma rather than by any test — every check the importer had passed while a quarter of one file sat in the wrong place, because all of them examined our output alone. Nonsense also has finite coordinates.
  - **Rotation pivot (the visible one).** Figma's per-node matrix maps the node's local space, whose origin is the box's **top-left corner**, so its translation says where that corner goes and the rotation turns the box about it. We store an unrotated box and turn it about its **centre**. Copying the translation into x/y offset every rotated node by the gap between those pivots — **24 of Dipped.fig's 60 nodes**, one 90° bar landing 260 units away. The conversion is exact: `(x, y) = t + M·c − c`.
  - **A boolean's operands were drawn on top of its result.** A shape node with children is a boolean operation and its children are the operands, which the flattened result already contains; hoisting them next to it drew the union *and* both shapes it was made from. Twenty of those turned a logo into a black scribble.
  - **A zero-byte fill blob counted as geometry.** Figma writes a `fillGeometry` entry pointing at an **empty** blob for a shape with no fill, so choosing fill-over-stroke by array length produced vector nodes with **no vertices** — invisible — while a good stroke outline sat in the next field. 4 nodes in one file, **37** in another.
  - **Stroke outlines are filled, not stroked.** `strokeGeometry` is the region a stroke covers, as a fillable shape: it takes the stroke paint as its fill. Stroking it draws a line around the edge of a line.
  - **A mirror is kept.** `det < 0` is a reflection, and reducing the matrix to an angle silently unmirrored 9 nodes in one file and 5 in another. Any reflection is a rotation plus one fixed flip, so it becomes `flipV` — exact, not an approximation.
  - **Pages no longer stack.** Each Figma page has its own coordinates near its own origin, so a three-page file arrived as three pages of frames in one heap. A page that would collide with one already placed is moved aside and the offset is **reported**; pages that already sit apart keep their exact coordinates. One Polyform page per Figma page is still owed.
  - **What replaced the checks:** for every node, the four corners of its box through Figma's matrix must equal the same corners through ours. It was shown to fail before being trusted (F-22) — restoring the old pivot turns the run red with `24 misplaced` and names them. Two blunter checks came with it: no vector may have zero vertices, and the comparison must actually have compared something. **One existing test had frozen the bug as its expected value** (`expect(node.x).toBe(10)` for a rotated frame), which is how a defect ships with a test defending it.

### Changed

- The GitHub repository is **AndreaDev3D/Polyform**, capitalised like the product. Every reference moved with it, and the packaging gate now matches the update feed case-insensitively rather than pinning one spelling.

- **A project is a folder you can double-click into.** The manifest is now `<Name>.poly` *inside* the project folder — the shape `.csproj`, `.uproject` and `project.godot` all use, and the only one that works: a folder cannot carry a file association on Windows or Linux, so a project that is only a folder can never be opened from a file manager. Double-clicking `MyPoster/MyPoster.poly` opens the project; so does "Open with", and so does a second launch while Polyform is already running (it hands the path to the open window instead of starting a rival that would fight over the journal's lock). One resolver (`resolveBundle`) accepts the folder, the project file or a pre-0.7 `manifest.json`, because three places used to hardcode the manifest name and would have drifted apart. **Bundles written before 0.7 still open and still save to the `manifest.json` they were found in** — nothing is renamed behind your back; they just don't gain the double-click. `polyform new MyPoster.poly` and `polyform new MyPoster` both make `MyPoster/`. (ADR-027)
- **Update checking that tells you, and does not install** (ADR-028). Help → Check for Updates asks this repo's Releases and reports in one sentence; the same check, with a checkbox, sits on the welcome screen where you are right after installing. The launch check is **off by default** — the welcome screen promises nothing phones home, and an unannounced web call on every start would quietly make that false. It deliberately never downloads or installs: electron-updater's protection against a swapped artifact *is* signature verification, and nothing is signed yet (F-10), so the honest behaviour is a link to the release page and a sentence saying why. Downgrades are refused. One constant flips it to a real updater in the same commit that adds signing.
- **Free integrity for releases, since a certificate is not free.** Alongside the SHA-256 checksums, every release artifact now carries a **Sigstore build-provenance attestation** from the release workflow: `gh attestation verify <file> --repo AndreaDev3D/Polyform` proves the bytes came out of this repo's workflow at that commit. It is not code signing — SmartScreen and Gatekeeper still object, and the release notes now say exactly which override each OS will ask for — but it answers the supply-chain half of F-10 and is worth keeping after signing lands.

- **macOS builds are ad-hoc signed, and the pipeline says what it signed.** Not code signing — there is no certificate (Roadmap 5.2) — but Apple Silicon refuses to load a binary with *no* signature at all, so without this the arm64 dmg could not have launched. Ad-hoc alone was not enough either: under the hardened runtime, library validation rejects Electron's own frameworks, so `resources/entitlements.mac.plist` grants `disable-library-validation` (plus the two JIT entitlements V8 needs) and CI **asserts the entitlement is in the signature**, not merely in a file. The arm64 app is launched and exercised on an Apple Silicon runner. On Windows nothing is signed and the log now says so per file: electron-builder prints "signing with signtool.exe" even with no certificate, and the artifact comes out `NotSigned` — a log that implies a signature is worse than one that says nothing.
- **Both long-standing e2e flakes are fixed, with causes** (F-27). Neither was random: each sent one synthetic event at one instant to code that reads *time*. The double-click check spent two WebSocket round trips inside the app's own 400 ms window (now one gesture, 7–10 ms, with the gap measured and reported); the hover check sent a single mouse move into a 30 ms hover throttle, where a dropped move has no successor and the cursor stays wrong forever (now the move is re-sent every poll, like a real pointer). Three consecutive clean runs.
- **A version bump is now what makes a release.** `release.yml` runs on every push to `main`, asks whether `package.json`'s version has been released yet, and stops in ten seconds if it has — so a release cannot be forgotten, and no tag has to be remembered. `gh release create` makes the tag itself from the commit being released, which is why this needs no stored token: a tag created with the default token would not trigger workflows. Pushing a `v*` tag by hand still works for a re-cut, and then the tag must match `package.json`. One run at a time, queued rather than cancelled.
  - **Cutting 0.7.0 for real found four things** that only a live release could: `download-artifact` with no pattern pulled six artifacts instead of three (the CI build's copies collided with the release build's, and the merged checksums then described files that had been overwritten — caught by `sha256sum -c` before anything was published); `.blockmap` files were being checksummed but not uploaded; the publish step still used `$GITHUB_REF_NAME`, which on a version-bump run is `main`, so the first draft was tagged `main`; and **artifact names contained spaces**, which GitHub rewrites to dots on upload — meaning the one integrity check we ask people to run would have failed on every Windows download. Names are now `Polyform-Setup-0.7.0-x64.exe`.
  - **Intel Macs were getting nothing.** `macos-latest` is Apple Silicon, so a plain `dmg` target built arm64 only. Both architectures now build.
- **Distribution groundwork: releases you can verify, and a build that is tested as a package.** Four things that had to exist before anyone could be pointed at a download.
  - **Third-party notices ship with the binary.** `THIRD-PARTY-NOTICES.md` is generated by `npm run licenses` from what actually ships — 126 npm packages and 54 Rust crates, all MIT/ISC/Apache-2.0/BSD, each licence reproduced in full — and installed beside the app, reachable from **Help → Third-Party Licences**. Permissive is not the same as obligation-free: MIT requires the notice to travel with the copy, and an installer is a copy. CI regenerates and diffs it, so a dependency added or upgraded without regenerating fails there rather than in a shipped artifact. (The background-removal model is deliberately absent: it isn't shipped, it's downloaded on consent under its own MIT licence.)
  - **The packaging smoke test F-06 has been promising since v0.1 now exists** (`npm run test:packaging`, and in CI on Windows, macOS and Linux). Every other gate runs the app from source, which cannot see the class of bug where the code is right and the *package* is wrong. This one drives the packaged binary: asar layout and unpacked WASM, then the whole CLI gate against the installed app — create a document, take an agent edit over stdio, reopen it in a fresh process, export a PNG — and finally reads `history.sqlite` and finds the edit's journal entry in the bytes. It reads the bytes rather than asking the app on purpose: `HistoryDb.open` answers cheerfully even when the journal is unreadable.
  - **A tag now produces a release.** `git push origin v0.7.0` runs the whole CI suite, checks the tag against `package.json` (a `v0.7.0` tag on a `0.6.0` package fails instead of shipping mislabelled installers), builds and smoke-tests installers on all three platforms, computes **SHA-256 checksums**, verifies them, and opens a **draft** GitHub Release — so a tag can produce a release without announcing one. Until the artifacts are signed, those checksums are the only integrity signal a downloader has, which is why F-10 lists publishing them as an obligation now. Documented in [docs/Releasing.md](docs/Releasing.md).
  - **Every GitHub Action is pinned to a commit SHA**, not a floating tag (also F-10), and **the gates that catch real bugs now run in CI** — e2e, the agent probe and the CLI gate, on Windows, where they are proven. Only the release workflow can write to the repository, and only on a tag.

- **Flip horizontal, flip vertical, rotate 90°** — the three buttons Figma puts beside the rotation field, in the inspector's new Transform row, in Object, and on `Shift+H` / `Shift+V`. A flip is a **transform**, not a geometry edit: `flipH`/`flipV` ride in the node matrix, which is the only way one operation can mean the same thing for an image fill, shaped text, a vector network and a whole group — and it makes the flip exactly reversible. Because both renderers, hit-testing, snapping and the bounding box all read that one matrix, they mirrored for free; SVG export was the single consumer that writes its own transform, and a new test composes what it emits back into a matrix and compares it against the engine's. Rust twin and both fuzz suites moved with it, plus a `flip-transforms` render fixture — the GPU backend bakes its own copy of every transform, so a mirror is exactly the thing that can come out right on one rasterizer and backwards on the other. One node turns in place; several turn and mirror **rigidly** about the shared centre, so an arrangement flips rather than each piece flipping where it stands.
- **The side panels resize.** Drag either panel's inner edge; the width is remembered per machine (localStorage, not the `.poly` — a bundle copied to another screen should not carry someone else's layout), clamped to 180–560px and to 40% of the window so a panel can neither vanish nor eat the canvas.
- **Corner radius per vector point.** Select one point or twenty and give them a radius: the corner is replaced by a circular arc that cuts back along both segments. It is generated in `nodeOutline`, which means it is the shape itself and not a rendering trick — hit-testing, SVG export, booleans, Carve and the GPU tessellator all see the rounded path, and the new `vector-corner-radius` parity fixture holds the two rasterizers to the same picture. The radius is a request: it is capped at half the shorter neighbouring segment, so two rounded corners in a row can never overrun each other, and asking for 400 on a small shape gives you the roundest that outline can be. A point whose neighbour is already a **curve** stays sharp, and the panel says so — filleting into a curve means splitting the curve, which is a different piece of work; the value is kept either way, so straightening the segment later rounds the point without retyping it. The fillet is computed without trigonometry (half-angle identities and one `sqrt`) because `acos`/`tan` have no specified last ULP, and the Rust twin is compared to the TypeScript engine **exactly**.

- **A rotate handle you can see.** A round knob on a short stem above the top edge of the selection, and it is the *shape's* top edge — turn the shape and the knob goes with it, so it always reads as "above this object". Round and filled to distinguish it from the white resize squares: a different shape for a different verb. Dragging it shows the angle in a pill beside the knob, the same number as the inspector's Rotation field, and Shift still snaps to 15°. The four invisible corner zones keep working, because that is the reflex a Figma user arrives with — but they are no longer the *only* way to find rotation.
- **A real rotation cursor.** CSS has no keyword for one, so it is a circular arrow drawn inline: white ink over a solid black rim, legible on the canvas, on a pale shape and on a dark one. It shows on the knob and on the corner zones, and stays for the whole drag.
- Rotate affordances are hidden where rotation is refused — inside an instance, where nothing would commit. Previously the invisible corner zones swallowed the click and did nothing.

### Changed

- **Every dropdown is ours now, and it has a caret.** The menu is our own DOM instead of Chromium's `<select>` popup, so it can look like the panel it belongs to: a chevron in the box, a **checkmark on the current option** (the thing the native popup cannot draw), arrow keys, Home/End, Enter, Escape, and first-letter typeahead. It opens below the box, flips above it when there isn't room, and stays inside the window — gated with the viewport deliberately shrunk, because a full-height window never gets close enough for that case to be real. Re-picking the option you are already on now spends no undo entry, matching what a native select did (it fired no change event for it), while the "Apply style…" pickers still fire every time. Owning the surface is mostly about being able to *test* it: a native popup is an OS-level window that does not appear in a page screenshot, so the e2e gate can now photograph the menu, count its rows and read which one is checked. On speed, measured rather than assumed: with a desktop capture — the only instrument that can see the native popup — Chromium's showed its content 35–86 ms after the click with a 3,000-shape document open and ~50 ms with an empty one; ours opens in 20–32 ms. Roughly a frame either way, so speed is not the reason for the change.
- **The inspector is two columns, never four.** Position and Dimensions each get a full row. Four number fields on one line left every value clipped to three characters — an X of 5163 read as "516" — which is a strange way to treat the panel you check coordinates in.
- **"Place" is now "Import" in the File menu**: **Import Image…** (`Ctrl+Shift+K`) and **Import 3D Model…** now sit beside **Import SVG…**, because from where you stand they are one errand — bring a file on disk into the document — and the old wording split one group of menu items into two vocabularies. The native file dialogs and the history entries follow ("Import Image", "Import 3 Images"), so undo describes itself with the same word you clicked. The menu **ids** moved with the labels (`file.importImage`, `file.importModel`): `shared/menu-def.ts` is the single definition both the native menu and the app's own bar are built from, and a split vocabulary there is how the next reader gets confused. *(Entries below still cite "File → Place 3D Model…" — that is where it was in 0.5.0.)*

### Fixed

- **About Polyform said 0.1.0.** It had said so through five releases — the string was written into the dialog. It asks the app for its version now, the same one the title bar and the welcome screen show, and points at the licences.
- **Two claims in the findings register were not true, and are corrected rather than quietly dropped.** F-06 described a `resolveWasmPath()` helper that does not exist (there is one call site, in `getSqlJs()`) and a packaging smoke test that did not exist until this release. F-05 described open-time journal validation with a quarantine rename as *shipped since v0.1*: what exists is the fallback to a fresh journal, so the document is never held hostage, but there is no integrity probe and no `history.sqlite.corrupt-<timestamp>` rename — an unreadable journal is silently replaced and then overwritten. Found while building the packaging gate. Rename-before-replace is a handful of lines and is now an obligation on the register before v1.0.
- **The dropdowns had no down-arrow.** They were native `<select>`s with `appearance-none`, and that removes the arrow along with the box — so a control whose whole job is to say "there are other choices here" said nothing, and Blend mode read as a text field showing the word *Normal*.
- **A key typed into a dropdown could reach the canvas.** A native `<select>` counted as a typing target for the global shortcuts, so it swallowed single keys for free; a button does not. Left alone, "r" would switch to the rectangle tool with a menu open, and Escape closed the menu *and* cleared the selection — which emptied the inspector and unmounted the dropdown mid-gesture (F-24: React's `stopPropagation` does not stop the app's `window` listener from a `document.body` portal, measured by logging what actually arrived at the window). An open menu now claims the keyboard natively, and the gate asserts the selection survived rather than merely that the menu closed.
- **The app now claims its own Windows identity.** It sets the AppUserModelID from the installer's `appId`, as a build-time define from the same `package.json`, so the running window and the installed shortcut cannot drift apart — without it the shell attributes notification toasts to "Electron" and a pinned shortcut doesn't recognise the running window as itself. Note what this does *not* change: the name in Task Manager and the taskbar group is the executable's own version info, so a run from source still reads **Electron** (the binary is `node_modules/electron/dist/electron.exe`) while the packaged `Polyform.exe` reads **Polyform**. The taskbar *icon* was already correct in both, because the window icon is set explicitly for unpackaged runs.
- **Typing a value in the inspector took two undos, and Escape didn't cancel.** Enter committed the number and then blurred the field — and blur committed too, so one edit landed as two identical history entries. Escape had the mirror of the same bug: it blurred, so it committed the text it was supposed to throw away. Both keys now mark the blur they cause as already handled. This was every numeric field in the panel — X, Y, W, H, rotation, radius, opacity, stroke weight — and it is now an `npm run test:e2e` check, confirmed to fail without the fix.
- **The divider under the title bar stopped dead where the window buttons begin.** The OS paints its minimise/maximise/close overlay over the *whole* titlebar height it reports, not just the glyphs — and a CSS `border-b` lives inside that height, so the last 136 px of the line were behind the controls. The divider is now its own 1 px row below the bar, outside the overlay, and runs edge to edge. (Verified by capturing the real window off the desktop: a page screenshot can't see this, because the OS buttons aren't in it.)
- **Hovering a handle usually didn't change the cursor at all** (F-23). The cursor was written inside the canvas's dirty-gated repaint, but the cursor depends on where the *pointer* is, which changes nothing in the document or the editor store — so moving onto a resize handle or a rotate zone produced no repaint and therefore no cursor change. You got feedback only when a repaint happened to be triggered by something else, which made it feel intermittent rather than broken; combined with rotate zones that draw nothing, it is most of why rotating felt like guesswork. Now written every frame, outside the gate, diffed so it is still one DOM write per real change. Covered by a new `npm run test:e2e` check, verified to fail without the fix.

## 0.6.0 — "Agent Connectivity" — 2026-08-04

### Added

- **Carve.** Put shapes on top of another one and carve: the enclosed contours become **holes** in a single editable path. It winds contours by nesting depth the way a font glyph does, so a shape inside a hole fills again — an island in a lake — and the result is a vector whose hole you can then drag the points of, which is what separates it from a live boolean. Refuses text (it would become a rectangle) and refuses a single layer, saying why. Object → Carve Holes, Ctrl+Shift+H, the context menu, or the button beside the boolean ops.
- **Vector editing has modes.** Opening a path turns the centre of the bottom bar into its own tools — **Move**, **Bend**, **Delete** — plus a live count of selected points and a way out. Bend drags a segment and the curve follows the pointer exactly (both handles move, split by their influence at the point you grabbed); Delete removes a point and *heals* the path through it, so a closed outline stays closed, or opens the path if you click a segment instead.
- **Per-point handle mirroring**, chosen in the inspector for the selected point(s): none, mirror the angle (the other handle keeps its own length), or mirror angle and length. Choosing it makes a corner smooth immediately rather than waiting for the next drag, and **Alt** breaks the pairing for one drag without changing the point's mode. Stored per vertex, so one corner in an otherwise smooth curve is normal.
- **Round anchor handles.** A square handle on a path reads as "resize this box" — which is exactly what the transform handles mean.
- **A real bottom bar, replacing the floating tool pill.** Three zones with fixed homes: the agent on the left, the tools still centred, and framing the view on the right — a **Focus on Selection** button (Shift+2, falls back to fitting the page) next to the zoom stepper, which moved down from the title bar to sit beside the canvas it acts on. Nothing floats over the drawing any more, and the tool icons no longer shift sideways when the contextual boolean group appears.
- **Saving is automatic; the Save button is gone.** A save follows 1.2s after your last edit, with a 15s bound so continuous work still lands and a 30s backstop behind both; gestures and text edits are waited out rather than interrupted. The title bar shows the state instead of a button — a dot while there are edits, *Saving…*, then *Saved* — and **Not saved** in red, persistently, if a write ever fails. Ctrl+S still works, because pressing it is a reflex.
- **The inspector says what every field is for.** Each group of controls now carries its name — Alignment, Position, Dimensions, Rotation, Corner radius, Opacity, Blend mode, Weight/Align/Style for strokes, Offset/Blur/Color for shadows, Gap/Padding/Align/Sizing for auto layout, and the whole text section — so nothing depends on decoding a glyph. The glyph moved *inside* the field it names (`X 40`, `⟳ 0°`), units sit against their number instead of drifting to the far right of the box, and the remaining single-letter labels (`B`, `R`, `☀`, `◑`, `S`, `Yaw`, `Dist`) became words or drawn icons.
- **Corner radius has an explicit "each corner" toggle**, and the four fields carry the corner they edit. Collapsing works even when the corners differ — the single field then reads *Mixed*, where before the toggle was forced open and looked broken.
- **Multiple export targets at once.** The Export section is empty until you add a target, then lists one row per size and format: three PNGs and an SVG from one click. Several files ask for a folder **once** rather than a save dialog per file, and SVG greys out its scale because it doesn't have one. `+` stops offering targets once every size and format is listed.
- **A headless `polyform` CLI** (item 7.4, ADR-023): `new` / `query` / `export` / `mcp serve` run the same app with no window — exports go through the exact same renderer as File → Export, so they are pixel-identical by construction. **`polyform mcp serve <bundle>` serves the full agent toolset over stdio for a file at rest**: no port, no token, nothing listening — the client spawns the process, and spawning it over your own file is the consent, so all capabilities (edits included) are on. Every CLI-mode edit saves the bundle before the call returns. Built for CI render-diffs, batch exports, and agent work that shouldn't require the app to be open.
- **Agents can now edit the document — safely** (item 7.3). One tool, `edit_document`: a batch of create/update/move/delete ops lands as **one undoable history entry**, marked with an AGENT chip — one Ctrl+Z removes the whole thing, and a batch with any invalid op lands nothing. Writes are their own capability and **default to off**: letting an agent read your document never implies letting it change one. Boundaries are enforced app-side — writable properties are whitelisted (solid and gradient fills included), agents parent into frames with explicit z-order, and instance internals are untouchable.
- **Agents can bring images in and cut their backgrounds.** `import_image` receives the image as bytes over the loopback connection — the app never reads the agent's filesystem — stores it content-addressed like any placed image, and `edit_document` fills accept `{image: assetHash}`. `remove_background` drives the same on-device BiRefNet pipeline as the context menu (v0.4.1) and commits its own attributed entry; if the model was never downloaded it refuses with instructions rather than popping a consent dialog — that download stays a decision made by a human, in the app.
- **Agents can see the design, not just its structure** (item 7.2). `get_document` reports shared styles with their resolved values and how many layers use each, main components with instance counts, and attached libraries; `get_node` returns fills, strokes, effects, corner radius, auto-layout, constraints, fonts, instance overrides and shared-style **names**; `get_view_image` and `get_node_image` return PNGs of what you are looking at, or of one layer.
- **Agent → Agent Connection**: the consent panel. Four capabilities — read the document, read the selection, see the canvas, watch edits — each listed in plain language beside the tools it enables, each granted and **revoked individually while an agent is connected**. Revoking removes the tools from the live session and refuses the call if a stale client makes it anyway. The panel also hands you a paste-ready client command with the token masked by default.
- **You can always tell when an agent is attached.** The agent button on the bottom bar carries a light that distinguishes *connected* from *reading right now*, and clicking it opens the panel to revoke. Status is pushed from the main process, not polled, so it is never stale about whether something is reading.
- Snapshots are budgeted honestly: the long edge is clamped to 1568 px and the applied scale is reported, so an agent measuring off the image is not misled by a silent downscale. A full viewport costs about 1,073 image tokens against a ~25k client budget. Detail reads cap at 400 nodes and say when they truncate.

### Fixed

- **An effect on a group did nothing at all.** Canvas shadow state is per-draw-call, and a group draws nothing of its own, so a drop shadow or layer blur set on a group (or on a frame with no fill) was silently dropped — while the same file exported to SVG with the effect correctly on the `<g>`. Both renderers now flatten such a container to a scratch buffer and apply the effect to the **composite**: one shadow around the union silhouette of the children, with none falling in the seam where two of them touch, and a layer blur over the assembled picture rather than each piece separately. Held to the same picture by a new `group-effects` pixel-parity fixture (12 now). An inner shadow still needs a path to clip to, so it remains a no-op on groups.
- **A group's shadow was cropped out of exports.** `worldAABB` padded a container's own (usually zero-sized) rect for its effects but not the union of its children, so the box an export sizes itself to cut the shadow off. Fixed in the TS engine and its Rust twin together — the scene fuzz caught the mismatch immediately.
- **The endpoint accepted exactly one connection, ever.** The MCP transport binds to one session for its lifetime, and the server was built around a single shared transport — so a second agent could never attach, and a client that reconnected after a blip (Claude Code does, with backoff) was refused until the endpoint was restarted. Each session now gets its own transport; the gates cover two concurrent agents, disconnect/reconnect, and departure accounting. Found the first time a real client connected twice — the suite only ever connected once per boot.
- **Stop now stops.** Closing the endpoint while an agent was attached would hang: `server.close()` waits for keep-alive sockets to drain and an attached client holds one open indefinitely. Sockets are destroyed instead — 58 ms measured, and the gate fails over 2 s and re-checks that the port itself refuses connections.
- **A plugin could have started the agent endpoint without asking you.** Plugin scripts run in the renderer's own realm, so they could reach the endpoint controls on `window.polyform` — no dialog, no indicator, no decision. The controls are now handed out once at startup, before any plugin can load, and the test suite runs a plugin-shaped script to prove it is blocked. Plugins still have full document access by design (F-15); this closes the *network listener* path only.
- The endpoint stops when the last window closes, rather than outliving the document it serves.

### Research


- **Protocol decided** (spike 7.1 → ADR-021): AI agents will connect to the **running** app over **MCP**, on a Streamable HTTP endpoint Polyform hosts on `127.0.0.1` — stdio can't attach to a GUI that is already open, so the app listens and the agent dials in (the shape Figma's desktop Dev Mode server uses). The server lives in the main process, the document stays in the renderer, and one IPC bridge connects them.
- **Realtime is a change feed, not a subscription.** MCP's resource-subscription mechanism is not supported by shipping clients today, so watching the work happen is a `poll_changes(cursor)` tool over the existing PatchOp journal — ordered, gap-free, resumable after a disconnect, and it works on every client. Full reasoning and the client-support matrix in [docs/research/Agent-Connectivity-Spike.md](docs/research/Agent-Connectivity-Spike.md).
- **Security settled before the write surface exists**: off by default, loopback-only, an ephemeral OS-assigned port, a per-session bearer token, and `Origin`/`Host` validation so a web page can't drive the app by DNS rebinding.
- **Prototype gate** `npm run test:mcp`: boots the built app and connects with the official MCP SDK client — 401 without a token, 403 cross-origin, tools discovered, the live document and selection read back, and **an edit made in the app appears in the agent's change feed**.

## Unreleased — 0.5.0 "3D Model Import"

### Fixed

- **Double-click works again — everywhere** (F-19): the canvas read its click count from `PointerEvent.detail`, which the spec defines as always 0, so `isDouble` was never true. Every double-click gesture in the app had been silently dead since v0.1: drilling into groups and frames, opening an existing text layer for editing, entering vector-edit mode (masked by the Enter shortcut), and 3D orbit mode. Click counts are now timed (400 ms / 6 px), which also makes the gestures work for pen and touch input, which never report a click count at all.
- **Layers inside frames are selectable on canvas** (F-19): clicking anything in a frame used to select the whole frame, and with drill-down broken the contents were reachable only from the layers panel. Frames and components are now transparent to clicks the way Figma treats them — you click the layer you see — while groups, booleans and instances stay atomic and open with a double-click.
- **Inspector values apply live while you drag them**: scrubbing X/Y/W/H, rotation, opacity, corner radius, font size, effect and 3D pose fields now updates the canvas continuously instead of jumping only on release. The whole drag still collapses into exactly one undo entry — the coalescing moved to the commit sink, so every inspector control inherits it.

### Added

- **Place 3D models on the canvas** (File → Place 3D Model…, ADR-020): **GLB/glTF meshes** with real PBR lighting and **gaussian splats** (`.ply`, `.spz`, `.splat`, `.ksplat`, `.sog`) become first-class `MODEL3D` nodes — content-addressed in the bundle like images, journaled and undoable like every other edit. Polyform stays a 2D tool: this is render-of-3D-in-2D for composition, not a 3D editor.
- **Double-click a model to orbit it.** Drag spins, Alt+drag dollies, Escape leaves; the whole gesture lands as one undo entry. The Inspector exposes yaw/pitch/distance/FOV numerically, a Reset view button, four procedural lighting presets for meshes (Studio / Neutral / Dramatic / Flat — no HDRI assets ship), and an Upright toggle for splat captures.
- **Framing is automatic**: the model's bounding sphere is fitted to the node box, so distance is a multiplier of that fit and a pose survives resizing the node or swapping the asset.
- **Renders in both backends and both exporters**: one offscreen WebGL2 island (three.js r185 + Spark 2.1, both MIT) renders each posed model and hands a snapshot to Canvas2D (`drawImage`) or WebGPU (textured quad). PNG export bakes the finished render; SVG embeds it as a raster.
- **Measured** (`POLYFORM_3D_TEST=1`, NVIDIA Ampere, built app, driving the real document path): first render 135 ms mesh / 117 ms splat; re-posing a cached model costs 0.3 ms of main-thread time for a mesh and one frame (16.6 ms) for splats — both clear the 30 fps orbit gate. The 11/11 GPU pixel-parity fixtures and the 100k-shapes-at-60 fps gate are unchanged, and the three+Spark chunk stays **lazy** (main bundle +25 kB).
- **Document schema v4**: purely additive — v3 files open unchanged and gain nothing but a version stamp. `docs/schema.fbs` tracks the new node, formats, and pose struct.
- Renderer CSP now allows self-contained `data:`/`blob:` content (`connect-src`, explicit `worker-src`) — required by Spark's inlined WASM and blob-spawned sort worker; no network surface widened.
- Known gaps, tracked for 6.4: Spark reads SPZ **v3** (v4 shipped upstream May 2026), multi-million-splat captures have no measured memory ceiling yet, and model import is menu-only (no drag-and-drop — images have none either).
- Research: full landscape survey (Babylon, PlayCanvas, bare-WebGPU pipeline; SPZ v4; Khronos KHR_gaussian_splatting) in [docs/research/3D-Model-Spike.md](docs/research/3D-Model-Spike.md).

## 0.4.1 — Image Background Removal (2026-08-02)

- **Remove background on image fills** (ADR-019): one click in the inspector cuts out the subject with an on-device AI model — **fully offline**; the model downloads once (SHA-256-verified, explicit consent dialog) and lives in local app data. No cloud APIs, ever.
- **Model: BiRefNet (MIT, 512² input, ~473 MB fp16)** — upgraded from ISNet after real-image acceptance showed its mattes too aggressive/imprecise. BiRefNet is the architecture RMBG-2.0 is built on, without RMBG's non-commercial weight license; superseded model files are cleaned from app data automatically. (The 1024-input lite variant is unrunnable in onnxruntime-web on Windows today — WebGPU storage-buffer limit + wasm32 memory ceiling, both measured and documented in ADR-019.)
- **Runs on the GPU**: ~5 s per image on the WebGPU execution provider (ort 1.27 requires the asyncify runtime pair — the jsep files are pre-1.2x), with a run-time degradation ladder down to WASM, an allocation-failure retry, and a watchdog. Never blocks the canvas.
- **Non-destructive**: the cutout is written as a new content-addressed asset; the original stays in the bundle; "Restore original" swaps back; both directions are single, undoable journal entries.
- New harness: `POLYFORM_BG_TEST=1` runs real inference on a synthetic scene and gates the matte (subject kept, background dropped — passing).

## 0.4.0 — Performance Core (2026-08-02)

Sprints A–E below, plus the closeout: the `color.ts` Rust twin landed (exact parity, bit-identical string output under fuzz), completing the module inventory — **every portable engine module now has a fuzz-proven Rust twin**. The worker/scene-memory flip (Roadmap 4.3/4.6) is deferred out of v0.4 with a written re-entry trigger and precondition (op-coverage audit) in [docs/V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md); the SVG import/export port stays unported by the plan's own "only if profiling demands" rule. Exit criteria verified: **100,000-shape scenes pan at 60fps** (in-app harness), byte-compatible document round-tripping against v0.3 files (serialization parity gates).

### Fixed

- **Adding text works again** (F-18): freshly placed text nodes were instantly deleted by a spurious Chromium focus bounce off the just-mounted edit textarea (present since at least v0.3 in built apps; user-reported). The overlay now re-arms focus on a blur that lands nowhere while the window is focused, and only commits on real exits. New `npm run test:e2e` gate drives the built app through the actual gesture (T, click, type, Escape) over the DevTools protocol.

### Sprint E — the HarfBuzz text stack (ADR-018)

- **Text now shapes in the engine**: rustybuzz (the pure-Rust HarfBuzz port) runs in the WASM core behind the `text` backend flag (default on) — real kerning and ligatures from the font's own tables, letter-spacing applied per shaped cluster, and **deterministic layout** that no longer re-flows across Electron upgrades (closes F-02's fidelity/stability core). Font bytes come straight from Chromium's Local Font Access API (`queryLocalFonts().blob()`) — no native module; missing families resolve through sensible installed fallbacks, and every text node falls back to the legacy Canvas2D path until its font's bytes arrive.
- **One layout, both renderers**: `layoutText` stays the single seam — auto-resize, Canvas2D (fills the actual glyph outlines), the WebGPU backend, overlays and SVG export all consume the same positioned-glyph runs.
- **GPU glyph atlas**: the WebGPU backend replaces per-node text rasters with a shelf-packed glyph atlas — each (font, glyph, zoom-bucket) rasterizes once, text draws collapse into batched quads sharing one texture.
- **Verified**: 6 Rust unit tests + 7 vitest contract tests through the WASM boundary, plus three harness fixtures — shaped-vs-shaped parity 0.59% differing pixels, a kerning/ligature/alignment/rotation fixture at 1.22%, and the legacy raster path still pixel-exact. Known limits (documented): single-run shaping (no bidi/RTL itemization), no OpenType feature-toggle UI yet. WASM binary grows 1.16 → 1.97 MB.

### Sprint D follow-up — GPU effects & blend compositor (ADR-017)

- **Effects now composite in GPU mode**: drop shadows, inner shadows, layer blur and background blur render through the WebGPU pipeline. View-independent effects pre-render at bake time into world-anchored per-node textures (replay of the node's baked geometry through a layer-local camera + separable gaussian, σ matching Canvas2D semantics) — so panning remains a pure camera-uniform update, effect nodes included.
- **All 16 blend modes render in GPU mode**: MULTIPLY and SCREEN as exact fixed-function pipeline variants (batched and inherited per-primitive, mirroring Canvas2D); the other thirteen (OVERLAY…LUMINOSITY, incl. the HSL four) through backdrop-sampling composite shaders implementing the W3C formulas.
- **Frame graph**: the scene pass now resolves to an intermediate texture with a final canvas blit; background blur and backdrop-dependent blends split the pass (snapshot → blur → resume). Scenes without backdrop effects keep the old single-pass cost — the 100k gate is unchanged (0.18ms CPU/frame, one draw call).
- **Verified**: three new pixel-parity fixtures — shadows 0.10% differing pixels, blurs 2.69%, twelve blend modes **0.00%** — bringing the harness to **9/9 PASS**. Closes F-16's cost concern in GPU mode (scoped backdrop sampling).
- Remaining GPU beta gap: text uses cached Canvas2D rasters until the Sprint E glyph atlas; Canvas2D stays the default renderer pending real-document soak time.

### Sprint D — WebGPU renderer (beta): the 100k-shape claim is real

- **WebGPU scene backend** behind View → GPU Rendering (Beta), ADR-016: Rust/lyon tessellation (fills, strokes with all three aligns, dash splitting), world-space geometry arenas baked per scene version, one stencil stack for masks/rotated clips/stroke aligns, scissor fast path, gradient/image/text draws from a uniform arena, dual-canvas viewport (editor overlays stay Canvas2D). Canvas2D remains the default renderer; GPU failures fall back automatically.
- **Verified performance**: panning a **100,000-shape document runs at 60fps** — 0.18ms CPU per frame, a single draw call — with a 121ms full rebake after an edit (in-app harness, NVIDIA Ampere). The Product-Overview headline claim is no longer aspirational.
- **Verified fidelity**: six pixel-diff parity fixtures against the Canvas2D reference all pass (worst case 2.63% differing pixels, confined to anti-aliased edges; text rasters are pixel-identical). Run it yourself: `POLYFORM_RENDER_TEST=1 npm start`.
- Beta gaps (documented): effects (shadows/blurs) and non-NORMAL blend modes are not composited in GPU mode yet; text uses cached Canvas2D rasters until the Sprint E glyph atlas.

### Sprint C — the engine-port track is complete

- **Every P1–P3 engine module now has a fuzz-proven Rust twin**: constraints (bit-exact, 500-case matrix), serialization (**byte-identical** PFRM/msgpack output vs @msgpack/msgpack, cross-decoding interop, v1→v3 migration), hit-testing (`hitTestAll`/`nodesInRect`/`findDropFrame` agree exactly incl. z-order; BOOLEAN nodes evaluate through exact CSG fully inside Rust), and the derived-pass fixpoint (instance sync → auto-layout → group/boolean normalize → orphan GC) reaching identical fixpoints with identical materialized ids.
- **Cross-engine determinism hardening** (permanent contract improvements): the instance sync hash now uses canonical JSON (sorted keys — existing documents resync once, no visual change); materialized-node ids come from an injectable host-side factory; `encodeScene` accepts an injectable `savedAt` timestamp.
- Text auto-resize remains host-side by design until the HarfBuzz stack (Sprint E). Remaining v0.4 work is the renderer track: WebGPU backend (Sprint D), text + 100k-shape exit test (Sprint E), and the engine flip onto the Rust SceneGraph (worker + msgpack boundary).

### Sprint B

- **Exact boolean geometry** (closes F-03): union/subtract/intersect/exclude now run exact bezier CSG in the Rust core (flo_curves) by default — intersections are computed on the curves, not on flattened polygons, and the result is **2.02x faster** than the polygon-clipping path on top of being correct at any zoom. The TS implementation stays as an automatic fallback: any WASM runtime failure poisons the engine back to TS for the session, so degenerate geometry can never blank a shape. Verified by a ground-truth fuzz gate (sampled membership vs op semantics — which also exposed that the old TS path silently returns the *first child whole* when polygon-clipping throws).
- **Journal replay contract fixture**: a deterministic journal touching every PatchOp kind replays to a frozen, committed document snapshot, undoes back to the exact initial state, redoes to the exact final state, and survives JSON round-trips — the acceptance test the Rust `commands.rs` port must pass unchanged.
- **SceneGraph + PatchOp engine ported to Rust** (`scene.rs`): the full scene/commands surface — add/remove/update/move/page ops/styles, parent tracking, world matrices, padded world AABBs (strokes/effects/VECTOR outlines), render order — proven equivalent by the journal fixture replaying to the identical frozen snapshot through the WASM `SceneHandle`, plus a randomized op fuzz (180 entries) holding documents byte-equal through apply and undo-all. Runs as the test-proven substrate for the Sprint C/D scene-engine flip; the app still runs the TS SceneGraph.

### Sprint A

- **Rust engine core lands** (`crates/polyform-core`, ADR-015): `geometry`, `shapes` (outline generation + vector-network chain walking + SVG path data), and the spatial index ported to Rust and compiled to WASM (163 KB), per [docs/V0.4-Porting-Plan.md](docs/V0.4-Porting-Plan.md).
- **Per-module backend switch** (`engine/backend.ts`): TS and WASM implementations live behind unchanged function signatures; flags flip per module, persist in `localStorage`, and are console-tweakable via `__polyformEngine`. If WASM fails to load, everything stays on TS.
- **Spatial index runs on Rust by default**: rstar bulk-load measured **2.23x faster** than rbush at 10k nodes (the rebuild runs on every edit; queries are µs-scale either way). `shapes` stays TS by default — per-call boundary crossing costs 3–5x more than the math until Sprint B moves its consumers (booleans, hit-test) into Rust too.
- **Differential parity gate**: 13-test fuzz suite (1,000 seeded cases per function) holds TS and WASM byte-identical on all pure-IEEE arithmetic and within 1e-12 on libm transcendentals; runs in `npm test` and in CI against a freshly built WASM binary. `npm run bench` reproduces the perf gate.
- CSP now includes `'wasm-unsafe-eval'` (WASM compilation only — JS eval stays blocked). New scripts: `build:wasm`, `test:rust`, `bench`. CI builds and tests the Rust crate on every push; installer builds use the committed WASM pkg and need no Rust toolchain.

## 0.3.0 — Systems (2026-08-01)

- **Components & instances** (schema v3, auto-migrates): create components with `Ctrl+Alt+K` (or convert a frame in place); instances are materialized subtrees kept in sync by the engine, with stable child ids, a cycle guard, and orphan GC. Property edits inside instances are journaled as per-instance **overrides** that survive component edits, undo, and restarts. Swap, reset overrides, and detach (`Ctrl+Alt+B`) in the inspector. Structural edits inside instances are locked.
- **Local-file libraries**: attach any `.poly` bundle in the new Assets tab; insert its components (imported with provenance) and color styles; pull updates on demand — instances re-sync automatically.
- **Version history browser** (`Ctrl+Alt+H`): timestamped timeline over `history.sqlite`, click to time-travel, Save As to fork.
- **Plugin API dev preview**: Plugins → Run Plugin Script… executes a script against a minimal `polyform` API as one undoable entry; design doc at [docs/Plugin-API.md](docs/Plugin-API.md).

## 0.2.0 — Editing Depth (2026-08-01)

- **Multi-page documents** (schema v2, auto-migrates) with per-page guides and viewports; undoable page management.
- **Vector edit mode**: double-click/Enter on a vector — move vertices and bezier handles, click an edge to insert a point, Delete removes points.
- **Rulers & user guides** (`Shift+R`): drag guides from rulers, persisted per page, snap targets; **equal-spacing snapping**.
- **Masks** (`Ctrl+Alt+M`): shape-clip siblings above; **constraints** (pin/center/stretch/scale per axis) cascading through nested frames.
- **Effects**: inner shadow and background blur join drop shadow and layer blur.
- **Image crop & adjust**: non-destructive crop rect plus exposure/contrast/saturation on image fills.
- **Gradient stop editor**: drag/add/remove/recolor stops in the inspector.
- **Shared styles**: color/text/effect styles applied by reference with detach; edits propagate to referencing layers.
- **SVG import**: full path grammar (including arcs), shapes, groups, text, transforms baked in.

## 0.1.1 — Review fixes (2026-07-31)

- Fixed 19 bugs found in an adversarial review, including: redo recreating drawn shapes as 0.01px stubs; text editing broken in dev by StrictMode; File→Open/New discarding unsaved work and desyncing the journal; multi-select resize flinging frame children; drop-shadow collapse under rotation; journal cursor corruption past 500 entries; per-pixel undo spam from label scrubbing; z-order front/back inverting multi-selections.

## 0.1.0 — Local-first vector design tool (2026-07-31)

- Initial release: Electron + React + TypeScript editor with a dependency-light engine — scene graph, patch-based undo/redo journaled to SQLite (session-spanning), R-tree spatial index, Canvas2D renderer behind a swappable interface.
- `.poly` directory bundles: `manifest.json`, binary `scene.bin` (PFRM/MessagePack envelope), `history.sqlite`, SHA-256 content-addressed `assets/`.
- Tools: frame, rectangle, ellipse, line, polygon, star, pen (vector networks), text (system fonts via `queryLocalFonts`), hand; selection, resize/rotate handles, snapping with smart guides.
- Boolean operations (non-destructive groups), auto layout with hug sizing, align/distribute, blend modes, drop shadow + layer blur, gradients and image fills.
- PNG/SVG export, autosave, recents, per-project thumbnails; native menus; 231-row Figma parity matrix and full docs set.
