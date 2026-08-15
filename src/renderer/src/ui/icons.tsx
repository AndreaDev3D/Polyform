// Minimal inline SVG icon set (16x16, currentColor).

import type { SVGProps } from 'react'
import { MARK_AXIS, MARK_GLYPH, MARK_STOPS, MARK_VIEWBOX } from './mark-paths'

type P = SVGProps<SVGSVGElement>

function I({ children, ...props }: P & { children: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" {...props}>
      {children}
    </svg>
  )
}

export const CursorIcon = (p: P) => (
  <I {...p}>
    <path d="M4 2l8 6.5-4.2.8L6 13.5 4 2z" fill="currentColor" stroke="none" />
  </I>
)
export const FrameIcon = (p: P) => (
  <I {...p}>
    <path d="M4.5 1v14M11.5 1v14M1 4.5h14M1 11.5h14" />
  </I>
)
export const SquareIcon = (p: P) => (
  <I {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" />
  </I>
)
export const CircleIcon = (p: P) => (
  <I {...p}>
    <circle cx="8" cy="8" r="5.5" />
  </I>
)
export const LineIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 13.5l11-11" />
  </I>
)
export const PolygonIcon = (p: P) => (
  <I {...p}>
    <path d="M8 2.5L14 13H2L8 2.5z" />
  </I>
)
export const StarIcon = (p: P) => (
  <I {...p}>
    <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6L8 1.8z" />
  </I>
)
export const PenIcon = (p: P) => (
  <I {...p}>
    <path d="M3 13l1-4 7.5-7.5a1.4 1.4 0 012 2L6 11l-3 2z" />
    <path d="M9.5 3.5l2 2" />
  </I>
)
export const TypeIcon = (p: P) => (
  <I {...p}>
    <path d="M3 3h10M8 3v10" />
  </I>
)
export const HandIcon = (p: P) => (
  <I {...p}>
    <path d="M5 8V3.7a1 1 0 012 0V7m0-3.8a1 1 0 012 0V7m0-2.6a1 1 0 012 0V8m0-.8a1 1 0 012 0v3.3A4.5 4.5 0 018.5 15h-.8A4.7 4.7 0 013 10.3L3 9a1 1 0 012 0" />
  </I>
)
export const EyeIcon = (p: P) => (
  <I {...p}>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </I>
)
export const EyeOffIcon = (p: P) => (
  <I {...p}>
    <path d="M3 3l10 10M6.5 6.7A2 2 0 009.4 9.5M4.6 4.8C2.6 6 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.2 0 2.3-.4 3.2-1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.7 1.3-2 2.5" />
  </I>
)
export const LockIcon = (p: P) => (
  <I {...p}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
  </I>
)
export const ChevronRightIcon = (p: P) => (
  <I {...p}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </I>
)
export const ChevronDownIcon = (p: P) => (
  <I {...p}>
    <path d="M3.5 6L8 10.5 12.5 6" />
  </I>
)
export const CheckIcon = (p: P) => (
  <I {...p}>
    <path d="M3.5 8.5l3 3 6-7" strokeWidth="1.6" />
  </I>
)
/** Reverse a gradient: two arrows trading places. */
export const SwapIcon = (p: P) => (
  <I {...p}>
    <path d="M3 6h9" />
    <path d="M10 4l2 2-2 2" />
    <path d="M13 10H4" />
    <path d="M6 8l-2 2 2 2" />
  </I>
)

/** Update available: an arrow into a tray. */
export const DownloadIcon = (p: P) => (
  <I {...p}>
    <path d="M8 2v7.5" />
    <path d="M5 7l3 3 3-3" />
    <path d="M3 12.5h10" />
  </I>
)

/** Restart to install: a circular arrow. */
export const RestartIcon = (p: P) => (
  <I {...p}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13 2.5V5h-2.5" />
  </I>
)

export const PlusIcon = (p: P) => (
  <I {...p}>
    <path d="M8 3v10M3 8h10" />
  </I>
)
export const MinusIcon = (p: P) => (
  <I {...p}>
    <path d="M3 8h10" />
  </I>
)
/** Overflow menu — the commands a panel has room to keep but not to show. */
export const MoreIcon = (p: P) => (
  <I {...p}>
    <circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
  </I>
)
export const TrashIcon = (p: P) => (
  <I {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" />
  </I>
)
export const GroupIcon = (p: P) => (
  <I {...p}>
    <rect x="2" y="2" width="8" height="8" />
    <rect x="6" y="6" width="8" height="8" />
  </I>
)
export const BoolUnionIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 2.5h7v4h4v7h-7v-4h-4z" fill="currentColor" stroke="none" />
  </I>
)
export const BoolSubtractIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 2.5h7v4h-3v3h-4z" fill="currentColor" stroke="none" />
    <rect x="6.5" y="6.5" width="7" height="7" />
  </I>
)
export const BoolIntersectIcon = (p: P) => (
  <I {...p}>
    <rect x="2.5" y="2.5" width="7" height="7" />
    <rect x="6.5" y="6.5" width="7" height="7" />
    <rect x="6.5" y="6.5" width="3" height="3" fill="currentColor" stroke="none" />
  </I>
)
export const BoolExcludeIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 2.5h7v4h-3v3h-4zM13.5 13.5h-7v-4h3v-3h4z" fill="currentColor" stroke="none" />
  </I>
)
export const AlignLeftIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 2v12" />
    <rect x="4.5" y="4" width="8" height="3" fill="currentColor" stroke="none" />
    <rect x="4.5" y="9" width="5" height="3" fill="currentColor" stroke="none" />
  </I>
)
export const AlignHCenterIcon = (p: P) => (
  <I {...p}>
    <path d="M8 2v12" />
    <rect x="3" y="4" width="10" height="3" fill="currentColor" stroke="none" />
    <rect x="5" y="9" width="6" height="3" fill="currentColor" stroke="none" />
  </I>
)
export const AlignRightIcon = (p: P) => (
  <I {...p}>
    <path d="M13.5 2v12" />
    <rect x="3.5" y="4" width="8" height="3" fill="currentColor" stroke="none" />
    <rect x="6.5" y="9" width="5" height="3" fill="currentColor" stroke="none" />
  </I>
)
export const AlignTopIcon = (p: P) => (
  <I {...p}>
    <path d="M2 2.5h12" />
    <rect x="4" y="4.5" width="3" height="8" fill="currentColor" stroke="none" />
    <rect x="9" y="4.5" width="3" height="5" fill="currentColor" stroke="none" />
  </I>
)
export const AlignVCenterIcon = (p: P) => (
  <I {...p}>
    <path d="M2 8h12" />
    <rect x="4" y="3" width="3" height="10" fill="currentColor" stroke="none" />
    <rect x="9" y="5" width="3" height="6" fill="currentColor" stroke="none" />
  </I>
)
export const AlignBottomIcon = (p: P) => (
  <I {...p}>
    <path d="M2 13.5h12" />
    <rect x="4" y="3.5" width="3" height="8" fill="currentColor" stroke="none" />
    <rect x="9" y="6.5" width="3" height="5" fill="currentColor" stroke="none" />
  </I>
)
export const DistributeHIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 2v12M13.5 2v12" />
    <rect x="6.5" y="4.5" width="3" height="7" fill="currentColor" stroke="none" />
  </I>
)
export const DistributeVIcon = (p: P) => (
  <I {...p}>
    <path d="M2 2.5h12M2 13.5h12" />
    <rect x="4.5" y="6.5" width="7" height="3" fill="currentColor" stroke="none" />
  </I>
)
export const VectorIcon = (p: P) => (
  <I {...p}>
    <path d="M2 12c3-8 9-8 12 0" />
    <rect x="1" y="11" width="2.5" height="2.5" fill="currentColor" stroke="none" />
    <rect x="12.5" y="11" width="2.5" height="2.5" fill="currentColor" stroke="none" />
  </I>
)
export const ComponentIcon = (p: P) => (
  <I {...p}>
    <path d="M8 1.5L11 4.5 8 7.5 5 4.5zM11.5 8l3 3-3 3-3-3zM4.5 8l3 3-3 3-3-3zM8 8.5L11 11.5 8 14.5 5 11.5z" fill="currentColor" stroke="none" transform="scale(0.72) translate(3.1 3.1)" />
  </I>
)
export const InstanceIcon = (p: P) => (
  <I {...p}>
    <path d="M8 2.5L13.5 8 8 13.5 2.5 8z" />
  </I>
)
export const HistoryIcon = (p: P) => (
  <I {...p}>
    <circle cx="8.5" cy="8" r="5.5" />
    <path d="M8.5 5v3l2.2 1.8M3 8H1m1.2-2.5L1 4.5m1.2 6L1 11.5" />
  </I>
)
export const CubeIcon = (p: P) => (
  <I {...p}>
    <path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" />
    <path d="M2.5 4.8L8 7.9l5.5-3.1M8 7.9v6.3" />
  </I>
)

/**
 * The product mark: the logo's letter, without its dark tile — it sits on
 * app chrome that is already dark. Geometry comes from mark-paths.ts, which
 * `node scripts/make-logo.mjs` generates from the same source as
 * resources/polyform-logo.svg, so the two cannot drift.
 *
 * Inline rather than an <img>: no asset round-trip, and it can inherit size
 * from the caller. The gradient id is fixed because at most one mark is on
 * screen at a time (welcome screen OR top bar).
 */
export const PolyformMark = ({ size = 14, ...p }: P & { size?: number }) => (
  <svg width={size} height={size} viewBox={MARK_VIEWBOX} fill="none" aria-hidden="true" {...p}>
    <defs>
      {/* userSpaceOnUse: the axis lives in the glyph's own coordinates, so
          every subpath samples one continuous gradient. */}
      <linearGradient id="pf-mark-skin" gradientUnits="userSpaceOnUse" {...MARK_AXIS}>
        {MARK_STOPS.map((s) => (
          <stop key={s.at} offset={s.at} stopColor={s.color} />
        ))}
      </linearGradient>
    </defs>
    <path fill="url(#pf-mark-skin)" d={MARK_GLYPH} />
  </svg>
)

export const FolderIcon = (p: P) => (
  <I {...p}>
    <path d="M1.75 4.25a1 1 0 011-1h3l1.5 1.75h5a1 1 0 011 1v6a1 1 0 01-1 1H2.75a1 1 0 01-1-1v-7.75z" />
  </I>
)
export const ImageIcon = (p: P) => (
  <I {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="1" />
    <circle cx="5.5" cy="6" r="1.2" />
    <path d="M2.5 12l3.5-3.5 2.5 2.5 3-3.5 2 2" />
  </I>
)

// --- Inspector field glyphs ----------------------------------------------
// These sit inside number fields and on the toggles beside them, so a field
// says what it edits without spending a whole line on a word.

export const RotationIcon = (p: P) => (
  <I {...p}>
    <path d="M13 8a5 5 0 11-1.7-3.75" />
    <path d="M13.2 2v3h-3" />
  </I>
)
/** A quarter turn clockwise: the box, and the arc it swings through. */
export const Rotate90Icon = (p: P) => (
  <I {...p}>
    <path d="M7 9h6v5H7z" />
    <path d="M4 6.5A6 6 0 0110.5 3" />
    <path d="M10.6 1.2 12.8 3l-2.2 1.8" />
  </I>
)
/** Mirror left↔right: two halves facing each other across a dashed axis. */
export const FlipHIcon = (p: P) => (
  <I {...p}>
    <path d="M8 2v12" strokeDasharray="2 2" />
    <path d="M6 4.5 3 8l3 3.5z" />
    <path d="M10 4.5 13 8l-3 3.5z" />
  </I>
)
/** Mirror top↕bottom: the same, turned. */
export const FlipVIcon = (p: P) => (
  <I {...p}>
    <path d="M2 8h12" strokeDasharray="2 2" />
    <path d="M4.5 6 8 3l3.5 3z" />
    <path d="M4.5 10 8 13l3.5-3z" />
  </I>
)
/** One rounded corner: the uniform-radius field. */
export const CornerRadiusIcon = (p: P) => (
  <I {...p}>
    <path d="M3 13V7a4 4 0 014-4h6" />
  </I>
)
/** Four independent corners: the toggle that splits the radius field. */
export const CornersIcon = (p: P) => (
  <I {...p}>
    <path d="M2 6V4.5A2.5 2.5 0 014.5 2H6M10 2h1.5A2.5 2.5 0 0114 4.5V6M14 10v1.5A2.5 2.5 0 0111.5 14H10M6 14H4.5A2.5 2.5 0 012 11.5V10" />
  </I>
)
/** Four independent sides: the toggle that splits the stroke weight field. */
export const SidesIcon = (p: P) => (
  <I {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M2.5 8h11M8 2.5v11" opacity="0.45" />
  </I>
)
export const SideTopIcon = (p: P) => (
  <I {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" opacity="0.35" />
    <path d="M2.5 3.2h11" strokeWidth="2.2" />
  </I>
)
export const SideRightIcon = (p: P) => (
  <I {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" opacity="0.35" />
    <path d="M12.8 2.5v11" strokeWidth="2.2" />
  </I>
)
export const SideBottomIcon = (p: P) => (
  <I {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" opacity="0.35" />
    <path d="M2.5 12.8h11" strokeWidth="2.2" />
  </I>
)
export const SideLeftIcon = (p: P) => (
  <I {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" opacity="0.35" />
    <path d="M3.2 2.5v11" strokeWidth="2.2" />
  </I>
)
export const CornerTLIcon = (p: P) => (
  <I {...p}>
    <path d="M3 13V7a4 4 0 014-4h6" />
  </I>
)
export const CornerTRIcon = (p: P) => (
  <I {...p}>
    <path d="M13 13V7a4 4 0 00-4-4H3" />
  </I>
)
export const CornerBRIcon = (p: P) => (
  <I {...p}>
    <path d="M13 3v6a4 4 0 01-4 4H3" />
  </I>
)
export const CornerBLIcon = (p: P) => (
  <I {...p}>
    <path d="M3 3v6a4 4 0 004 4h6" />
  </I>
)
/** Opacity: a disc half-covered, the usual shorthand for alpha. */
export const OpacityIcon = (p: P) => (
  <I {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" stroke="none" />
  </I>
)
/** Blend mode: two overlapping discs. */
export const BlendIcon = (p: P) => (
  <I {...p}>
    <circle cx="6" cy="8" r="4" />
    <circle cx="10" cy="8" r="4" />
  </I>
)
export const BlurIcon = (p: P) => (
  <I {...p}>
    <circle cx="8" cy="8" r="5.5" strokeDasharray="1.6 1.9" />
    <circle cx="8" cy="8" r="2.4" />
  </I>
)
export const StrokeWeightIcon = (p: P) => (
  <I {...p}>
    <path d="M2 4.5h12" strokeWidth="0.9" />
    <path d="M2 8h12" strokeWidth="1.6" />
    <path d="M2 12h12" strokeWidth="2.6" />
  </I>
)
// Text alignment: rows of text, ragged on the side that isn't aligned. The
// object-align icons next door mean something else, so these are their own set.
export const TextAlignLeftIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 4h11M2.5 7.5h7M2.5 11h9" />
  </I>
)
export const TextAlignCenterIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 4h11M4.5 7.5h7M3.5 11h9" />
  </I>
)
export const TextAlignRightIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 4h11M6.5 7.5h7M4.5 11h9" />
  </I>
)
export const TextTopIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 2.5h11" />
    <path d="M4 5.5h8M4 8.5h5" />
  </I>
)
export const TextMiddleIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 8h11" strokeDasharray="2 2" />
    <path d="M4 4.5h8M4 11.5h5" />
  </I>
)
export const TextBottomIcon = (p: P) => (
  <I {...p}>
    <path d="M2.5 13.5h11" />
    <path d="M4 7.5h8M4 10.5h5" />
  </I>
)
export const CloseIcon = (p: P) => (
  <I {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </I>
)

// --- Vector editing ------------------------------------------------------

/** Move points: an anchor with arrows away from it. */
export const PointMoveIcon = (p: P) => (
  <I {...p}>
    <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
    <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
  </I>
)
/** Bend a segment: a curve pulled away from the straight run. */
export const BendIcon = (p: P) => (
  <I {...p}>
    <path d="M2 12.5C2 6 6 3.5 14 3.5" />
    <circle cx="2" cy="12.5" r="1.6" />
    <circle cx="14" cy="3.5" r="1.6" />
  </I>
)
/** Delete points: an anchor with a cross. */
export const PointDeleteIcon = (p: P) => (
  <I {...p}>
    <circle cx="6" cy="10" r="2.2" fill="currentColor" stroke="none" />
    <path d="M10 3l4 4M14 3l-4 4" />
  </I>
)
/** Mirroring off: two independent arms. */
export const MirrorNoneIcon = (p: P) => (
  <I {...p}>
    <circle cx="8" cy="10" r="1.8" fill="currentColor" stroke="none" />
    <path d="M8 10L2.5 6.5M8 10l4-5.5" />
    <circle cx="2.5" cy="6.5" r="1.2" />
    <circle cx="12" cy="4.5" r="1.2" />
  </I>
)
/** Mirroring by angle: arms in line, different lengths. */
export const MirrorAngleIcon = (p: P) => (
  <I {...p}>
    <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
    <path d="M8 8L2 5M8 8l5.5 2.75" />
    <circle cx="2" cy="5" r="1.2" />
    <circle cx="13.5" cy="10.75" r="1.2" />
  </I>
)
/** Mirroring by angle and length: arms in line, equal lengths. */
export const MirrorFullIcon = (p: P) => (
  <I {...p}>
    <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
    <path d="M8 8L2.5 5.25M8 8l5.5 2.75" />
    <circle cx="2.5" cy="5.25" r="1.2" />
    <circle cx="13.5" cy="10.75" r="1.2" />
  </I>
)

/** Carve: a solid shape with a hole punched out of it. */
export const CarveIcon = (p: P) => (
  <I {...p}>
    <path
      d="M2.5 3.5h11v9h-11z M6 6.5h4v3h-4z"
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
    />
  </I>
)

/** Focus the view on something: brackets closing in on a target. */
export const FocusIcon = (p: P) => (
  <I {...p}>
    <path d="M2 5.5V3a1 1 0 011-1h2.5M10.5 2H13a1 1 0 011 1v2.5M14 10.5V13a1 1 0 01-1 1h-2.5M5.5 14H3a1 1 0 01-1-1v-2.5" />
    <rect x="6" y="6" width="4" height="4" rx="0.5" />
  </I>
)
/** The agent: a four-point spark, the usual mark for "AI does this". */
export const SparkIcon = (p: P) => (
  <I {...p}>
    <path
      d="M8 1.5l1.35 3.65L13 6.5 9.35 7.85 8 11.5 6.65 7.85 3 6.5l3.65-1.35L8 1.5z"
      fill="currentColor"
      stroke="none"
    />
    <path d="M12.2 10.3l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55.55-1.45z" fill="currentColor" stroke="none" />
  </I>
)
export const ExportIcon = (p: P) => (
  <I {...p}>
    <path d="M8 10.5V2.5M4.75 5.5L8 2.25l3.25 3.25" />
    <path d="M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2" />
  </I>
)
