import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { BASE, SITE_URL, SITE_TITLE, SITE_DESCRIPTION, GITHUB_URL, RELEASES_URL, abs } from './site.config'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RELEASE_JSON = path.join(HERE, 'src', 'release.generated.json')

type Asset = { name: string; label: string; arch: string; primary: boolean; url: string; size: number }
type Channel = {
  version: string
  tag: string
  publishedAt: string | null
  htmlUrl: string
  checksumsUrl: string | null
  downloads: { windows: Asset[]; macos: Asset[]; linux: Asset[] }
}
type Release = { ok: boolean; releasesUrl: string; stable: Channel | null; nightly: Channel | null }

/**
 * Written by `node scripts/site-release.mjs`, which `npm run site:build` runs
 * first. Tolerate its absence anyway — someone will run `vite build` directly,
 * and a missing derived file should degrade the page, not break it.
 */
function readRelease(): Release {
  try {
    return JSON.parse(fs.readFileSync(RELEASE_JSON, 'utf8')) as Release
  } catch {
    return { ok: false, releasesUrl: RELEASES_URL, stable: null, nightly: null }
  }
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const mb = (bytes: number): string => `${Math.round(bytes / 1_048_576)} MB`

const PLATFORMS = [
  { key: 'windows', name: 'Windows', note: '10 and 11, 64-bit' },
  { key: 'macos', name: 'macOS', note: '11 Big Sur and later' },
  { key: 'linux', name: 'Linux', note: 'x86-64' },
] as const

/**
 * The download grid, as real markup in the shipped HTML.
 *
 * Deliberately NOT rendered by JavaScript on load. These links are the single
 * thing the whole page exists to deliver: they must survive a blocked script,
 * a slow connection and a crawler that does not run JS. main.ts only marks
 * which card matches the visitor's OS — it never creates the links.
 */
function channelGrid(channel: Channel): string {
  const cards = PLATFORMS.map(({ key, name, note }) => {
    const assets = channel.downloads[key]
    if (!assets.length) return ''
    const rows = assets
      .map(
        (a) => `
        <li>
          <a class="dl-asset${a.primary ? ' dl-asset--primary' : ''}" href="${esc(a.url)}">
            <span class="dl-asset__label">${esc(a.label)}</span>
            <span class="dl-asset__meta">${esc(a.arch)} · ${mb(a.size)}</span>
          </a>
        </li>`,
      )
      .join('')
    return `
      <article class="dl-card" data-os="${key}">
        <h3 class="dl-card__name">${name}</h3>
        <p class="dl-card__note mono">${note}</p>
        <ul class="dl-card__assets">${rows}</ul>
      </article>`
  }).join('')
  return `<div class="dl-grid">${cards}</div>`
}

/** The nightly channel, as a compact list rather than a second full grid. */
function nightlyBlock(nightly: Channel): string {
  const links = (['windows', 'macos', 'linux'] as const)
    .map((os) => nightly.downloads[os].find((a) => a.primary))
    .filter((a): a is Asset => Boolean(a))
    .map(
      (a) =>
        `<a class="link" href="${esc(a.url)}">${esc(
          a.name.endsWith('.exe') ? 'Windows' : a.name.endsWith('.dmg') ? 'macOS' : 'Linux',
        )}</a>`,
    )
    .join(' · ')

  return `
    <div class="card mt-6 p-6">
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <h3 class="text-sm font-semibold">Nightly build</h3>
        <span class="mono">${esc(nightly.tag)}</span>
      </div>
      <p class="mt-2 text-sm leading-relaxed text-dim">
        Cut automatically from <code class="font-mono text-body">staging</code> on every push, published as a
        pre-release. Newer, and correspondingly less settled. ${links}
        · <a class="link" href="${esc(nightly.htmlUrl)}">release notes</a>
      </p>
    </div>`
}

/** The part of the page that has to stay honest about what it is offering. */
function honestNotes(channel: Channel, isNightly: boolean): string {
  const checksums = channel.checksumsUrl ?? RELEASES_URL
  return `
    <div class="card mt-8 p-6">
      <h3 class="text-sm font-semibold">Before you install — the honest part</h3>
      <ul class="mt-3 list-outside list-disc space-y-2 pl-5 text-sm leading-relaxed text-dim marker:text-rule">
        ${
          isNightly
            ? `<li><b class="font-semibold text-body">There is no stable release yet.</b> What is offered above is
                 the newest pre-release, <code class="font-mono text-body">${esc(channel.tag)}</code>. It is the
                 build being worked on, not one that has been through a release.</li>`
            : `<li><b class="font-semibold text-body">Polyform is young.</b> The feature matrix marks exactly what
                 is finished, partial and planned, and it is recounted every release.</li>`
        }
        <li><b class="font-semibold text-body">The installers are not code signed yet.</b> Windows SmartScreen and
          macOS Gatekeeper will warn you. Verify what you downloaded against the published
          <a class="link" href="${esc(checksums)}">SHA-256 checksums</a>, or against the Sigstore build provenance
          attestation with <code class="font-mono text-body">gh attestation verify &lt;file&gt; --repo
          AndreaDev3D/Polyform</code>.</li>
        <li><b class="font-semibold text-body">It will not update itself.</b> Polyform tells you when a new version
          exists and leaves the decision, and the download, to you.</li>
      </ul>
    </div>`
}

function downloadsHtml(rel: Release): string {
  const primary = rel.stable ?? rel.nightly
  if (!rel.ok || !primary) {
    return `
      <h2 class="sec-title">Get Polyform</h2>
      <p class="sec-lede"><a class="link" href="${RELEASES_URL}">Browse all downloads on GitHub →</a></p>`
  }

  const isNightly = !rel.stable
  const heading = `
    <h2 class="sec-title">Get Polyform <span class="gradient-text">${esc(primary.tag)}</span></h2>
    <p class="sec-lede">
      Free, and free software. Nothing to register, nothing that expires.${
        isNightly ? ' The build below is the current pre-release — see the note underneath.' : ''
      }
    </p>`

  // The nightly block is only worth showing when it is a DIFFERENT build from
  // the one already offered above. When there is no stable, the nightly is the
  // primary grid and repeating it would just be the same six links twice.
  const nightly = rel.stable && rel.nightly ? nightlyBlock(rel.nightly) : ''

  return heading + channelGrid(primary) + nightly + honestNotes(primary, isNightly)
}

/** The line under the hero buttons. Small, and only when it says something. */
function nightlyNote(rel: Release): string {
  if (!rel.ok) return ''
  if (rel.stable && rel.nightly) {
    return `<p class="mono">Or the nightly · <a class="link" href="#download">${esc(rel.nightly.tag)}</a></p>`
  }
  if (rel.nightly) {
    return `<p class="mono">Pre-release · <a class="link" href="#download">no stable build yet</a></p>`
  }
  return ''
}

/** Lets Google show the app as software rather than as an article. */
function jsonLd(rel: Release): string {
  const primary = rel.stable ?? rel.nightly
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Polyform',
    applicationCategory: 'DesignApplication',
    operatingSystem: 'Windows, macOS, Linux',
    softwareVersion: primary?.version ?? undefined,
    url: SITE_URL,
    downloadUrl: RELEASES_URL,
    license: 'https://opensource.org/licenses/MIT',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@type': 'Organization', name: 'Polyform Contributors', url: GITHUB_URL },
    description: SITE_DESCRIPTION,
  })
}

/**
 * Fills the %TOKENS% in index.html. Keeping the page's one source of dynamic
 * text here means index.html stays readable as HTML, and the path prefix and
 * release version are resolved once at build time instead of at runtime.
 */
function siteHtml(): Plugin {
  return {
    name: 'polyform-site-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const rel = readRelease()
        const primary = rel.stable ?? rel.nightly
        const tokens: Record<string, string> = {
          '%TITLE%': esc(SITE_TITLE),
          '%DESCRIPTION%': esc(SITE_DESCRIPTION),
          '%CANONICAL%': SITE_URL,
          '%OG_IMAGE%': abs('og.png'),
          '%BASE%': BASE,
          '%VERSION%': esc(primary?.tag ?? 'beta'),
          '%VERSION_KIND%': rel.stable ? 'Stable release' : 'Pre-release',
          '%RELEASE_URL%': esc(primary?.htmlUrl ?? RELEASES_URL),
          '%NIGHTLY_NOTE%': nightlyNote(rel),
          '%DOWNLOADS%': downloadsHtml(rel),
          '%JSONLD%': jsonLd(rel),
        }
        return html.replace(/%[A-Z_]+%/g, (m) => tokens[m] ?? m)
      },
    },
  }
}

/**
 * A sitemap, emitted rather than committed so its URL comes from site.config.
 *
 * Worth the eight lines even for a one-page site, because it is the only SEO
 * handle a *project* page has: crawlers read robots.txt from the domain root
 * (andreadev3d.github.io/robots.txt), which belongs to a user-pages repo that
 * does not exist and which nothing here can write. A sitemap can at least be
 * submitted to Search Console by hand.
 */
function sitemap(): Plugin {
  return {
    name: 'polyform-site-sitemap',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source:
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          `  <url><loc>${SITE_URL}</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
          '</urlset>\n',
      })
    },
  }
}

export default defineConfig({
  root: HERE,
  base: BASE,
  plugins: [tailwindcss(), siteHtml(), sitemap()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 4096,
  },
})
