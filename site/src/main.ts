// The site's only script. It does two things, and it is important that it
// does not do a third: the download links are already in the HTML, written
// there at build time by the transformIndexHtml plugin in vite.config.ts.
// Nothing here creates a link, so a blocked or failed script costs a visitor
// a nicety, never the download.

import release from './release.generated.json'

type OS = 'windows' | 'macos' | 'linux'

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

  const card = document.querySelector<HTMLElement>(`.dl-card[data-os="${os}"]`)
  if (card) card.dataset.current = ''

  // Point the hero button straight at the recommended build. Until this runs
  // it is an anchor to #download, which is never wrong — so if anything below
  // finds nothing, leaving it alone is the correct outcome.
  const pick = release.downloads[os]?.find((a) => a.primary)
  if (!pick) return

  const cta = document.getElementById('cta') as HTMLAnchorElement | null
  const label = document.getElementById('cta-label')
  if (!cta || !label) return

  cta.href = pick.url
  label.textContent = `Download for ${OS_NAME[os]}`

  const sub = document.createElement('span')
  sub.className = 'btn__sub'
  sub.textContent = `${Math.round(pick.size / 1_048_576)} MB`
  cta.append(sub)
}

/** The header is transparent over the hero and gains a surface once it covers
 *  content, so it never floats as an unexplained bar on top of a screenshot. */
function stickyHeader(): void {
  const header = document.getElementById('site-header')
  if (!header) return

  const sentinel = document.createElement('div')
  sentinel.setAttribute('aria-hidden', 'true')
  sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px'
  document.body.prepend(sentinel)

  const io = new IntersectionObserver(
    ([entry]) => {
      const stuck = !entry.isIntersecting
      header.classList.toggle('bg-ink-0/85', stuck)
      header.classList.toggle('backdrop-blur-md', stuck)
      header.classList.toggle('border-line', stuck)
      header.classList.toggle('border-transparent', !stuck)
    },
    { rootMargin: '-24px 0px 0px 0px' },
  )
  io.observe(sentinel)
}

applyOS()
stickyHeader()
