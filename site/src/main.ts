// The site's only script.
//
// Three jobs, and it is important it does not take a fourth: the download
// links and every gallery figure are already in the HTML, written there at
// build time. Nothing here creates content. A blocked script, a failed bundle
// or a crawler costs a visitor the motion, never the page — which is why the
// gallery's static column is the DEFAULT and the pinned version is opt-in.

import release from './release.generated.json'

type Asset = { name: string; label: string; arch: string; primary: boolean; url: string; size: number }
type Channel = {
  version: string
  tag: string
  publishedAt: string | null
  htmlUrl: string
  checksumsUrl: string | null
  downloads: { windows: Asset[]; macos: Asset[]; linux: Asset[] }
}
type OS = 'windows' | 'macos' | 'linux'

const mb = (bytes: number): string => `${Math.round(bytes / 1_048_576)} MB`

/** What the hero button offers: the stable build, or the nightly if there is
 *  no stable yet. Same rule the download section renders under. */
const primaryChannel: Channel | null = (release.stable as Channel | null) ?? (release.nightly as Channel | null)

// ---------------------------------------------------------------------------
// Which build to put in front of this visitor
// ---------------------------------------------------------------------------

/**
 * Chromium exposes a clean platform string; everyone else needs the User-Agent
 * sniffed. Both are guesses, which is why the result only ever *highlights* a
 * platform — every download stays visible, because people download for the
 * laptop they are not currently holding.
 */
function detectOS(): OS | null {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; mobile?: boolean }
  }
  const ua = nav.userAgent

  // Phones and tablets get nothing, and they are checked first because both
  // lie about their platform: Android carries "Linux" in every field it has,
  // and an iPad reports "MacIntel" running "Macintosh" — any check that
  // trusts that hands an iPad a .dmg.
  if (nav.userAgentData?.mobile) return null
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return null
  if (/Mac/i.test(nav.platform) && nav.maxTouchPoints > 1) return null

  // Most trustworthy source first, each tested on its own. Joining them into
  // one string and matching patterns against the result is wrong the moment
  // two sources disagree: whichever pattern is tested first wins, no matter
  // which field it actually matched, and the visitor is handed the wrong
  // installer with full confidence.
  for (const source of [nav.userAgentData?.platform, nav.platform, ua]) {
    if (!source) continue
    if (/win/i.test(source)) return 'windows'
    if (/mac|darwin/i.test(source)) return 'macos'
    if (/linux|x11|cros/i.test(source)) return 'linux'
  }
  return null
}

const OS_NAME: Record<OS, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }

function applyOS(): void {
  const os = detectOS()
  if (!os) return

  document.querySelector<HTMLElement>(`.dl-card[data-os="${os}"]`)?.setAttribute('data-current', '')

  // Until this runs the hero button is an anchor to #download, which is never
  // wrong — so if anything below finds nothing, leaving it alone is correct.
  const pick = primaryChannel?.downloads[os]?.find((a) => a.primary)
  const cta = document.getElementById('cta') as HTMLAnchorElement | null
  const label = document.getElementById('cta-label')
  if (!pick || !cta || !label) return

  cta.href = pick.url
  label.textContent = `Download for ${OS_NAME[os]}`
  const sub = document.createElement('span')
  sub.className = 'btn__sub'
  sub.textContent = mb(pick.size)
  cta.append(sub)
}

// ---------------------------------------------------------------------------
// The gallery
// ---------------------------------------------------------------------------

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)')

/**
 * Turn the static column into a pinned stage that crossfades on scroll.
 *
 * Nothing here runs when motion is reduced or when there is only one piece:
 * the markup is already a readable list of figures, and the correct response
 * to "do not animate" is to leave it that way rather than to animate faster.
 */
function gallery(): void {
  const list = document.querySelector<HTMLElement>('[data-gallery]')
  const index = document.querySelector<HTMLElement>('[data-gallery-index]')
  const container = list?.parentElement
  if (!list || !index || !container) return

  const figures = [...list.querySelectorAll<HTMLElement>('.gal__figure')]
  if (figures.length < 2 || REDUCED.matches) return

  // Build the index from the captions rather than duplicating the text in the
  // HTML — two lists of the same five names would drift the first time one is
  // edited.
  index.replaceChildren(
    ...figures.map((fig, i) => {
      const li = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'gal__step'
      button.setAttribute('aria-current', String(i === 0))
      button.innerHTML =
        `<span class="gal__step-n">${String(i + 1).padStart(2, '0')}</span>` +
        `<span class="gal__step-t"></span>`
      button.querySelector('.gal__step-t')!.textContent =
        fig.querySelector('.gal__name')?.textContent ?? `Piece ${i + 1}`
      button.addEventListener('click', () => {
        const total = list.offsetHeight - window.innerHeight
        window.scrollTo({
          top: window.scrollY + list.getBoundingClientRect().top + ((i + 0.5) / figures.length) * total,
          behavior: 'smooth',
        })
      })
      li.append(button)
      return li
    }),
  )

  // The track's height is the scroll distance the crossfade is spread over.
  // Derived from the real item count so CSS and JS cannot disagree about how
  // many pieces there are.
  container.style.setProperty('--gal-track', `${figures.length * 100 + 60}vh`)
  container.classList.add('pin')

  let active = -1
  let queued = false

  const update = (): void => {
    queued = false
    const total = list.offsetHeight - window.innerHeight
    if (total <= 0) return
    const progress = Math.min(Math.max(-list.getBoundingClientRect().top / total, 0), 1)
    const next = Math.min(figures.length - 1, Math.floor(progress * figures.length))
    if (next === active) return
    active = next
    figures.forEach((fig, i) => fig.toggleAttribute('data-active', i === next))
    index.querySelectorAll('.gal__step').forEach((b, i) => b.setAttribute('aria-current', String(i === next)))
  }

  // rAF-throttled: scroll fires far more often than the screen refreshes, and
  // reading offsetHeight on every event is a layout read per event.
  const onScroll = (): void => {
    if (queued) return
    queued = true
    requestAnimationFrame(update)
  }

  addEventListener('scroll', onScroll, { passive: true })
  addEventListener('resize', onScroll)
  update()
}

// ---------------------------------------------------------------------------
// Reveals and the header
// ---------------------------------------------------------------------------

function reveals(): void {
  const items = [...document.querySelectorAll<HTMLElement>('.reveal')]
  if (!items.length) return
  // Reduced motion still needs the class, because `.js .reveal` hid them.
  if (REDUCED.matches || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-in'))
    return
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-in')
        io.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -12% 0px' },
  )
  items.forEach((el) => io.observe(el))
}

/** Transparent over the hero, a surface once it covers content. */
function stickyHeader(): void {
  const header = document.getElementById('site-header')
  if (!header) return

  const sentinel = document.createElement('div')
  sentinel.setAttribute('aria-hidden', 'true')
  sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px'
  document.body.prepend(sentinel)

  new IntersectionObserver(
    ([entry]) => {
      const stuck = !entry.isIntersecting
      header.classList.toggle('bg-ink-0/85', stuck)
      header.classList.toggle('backdrop-blur-md', stuck)
      header.classList.toggle('border-rule', stuck)
      header.classList.toggle('border-transparent', !stuck)
    },
    { rootMargin: '-16px 0px 0px 0px' },
  ).observe(sentinel)
}

applyOS()
gallery()
reveals()
stickyHeader()
