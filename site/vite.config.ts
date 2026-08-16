import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { BASE, SITE_URL, SITE_TITLE, SITE_DESCRIPTION, GITHUB_URL, RELEASES_URL, abs } from './site.config'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RELEASE_JSON = path.join(HERE, 'src', 'release.generated.json')

type Asset = { name: string; label: string; arch: string; primary: boolean; url: string; size: number }
type Release = {
  ok: boolean
  version: string | null
  tag: string | null
  publishedAt: string | null
  prerelease: boolean
  htmlUrl: string
  checksumsUrl: string | null
  downloads: { windows: Asset[]; macos: Asset[]; linux: Asset[] }
}

/**
 * Written by `node scripts/site-release.mjs`, which `npm run site:build` runs
 * first. Tolerate its absence anyway — someone will run `vite build` directly,
 * and a missing derived file should degrade the page, not break it.
 */
function readRelease(): Release {
  try {
    return JSON.parse(fs.readFileSync(RELEASE_JSON, 'utf8')) as Release
  } catch {
    return {
      ok: false,
      version: null,
      tag: null,
      publishedAt: null,
      prerelease: true,
      htmlUrl: RELEASES_URL,
      checksumsUrl: null,
      downloads: { windows: [], macos: [], linux: [] },
    }
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
function downloadsHtml(rel: Release): string {
  if (!rel.ok) {
    return `<p class="text-dim">
      <a class="link" href="${RELEASES_URL}">Browse all downloads on GitHub &rarr;</a>
    </p>`
  }

  const cards = PLATFORMS.map(({ key, name, note }) => {
    const assets = rel.downloads[key]
    if (!assets.length) return ''
    const rows = assets
      .map(
        (a) => `
        <li>
          <a class="dl-asset${a.primary ? ' dl-asset--primary' : ''}" href="${esc(a.url)}" data-asset>
            <span class="dl-asset__label">${esc(a.label)}</span>
            <span class="dl-asset__meta">${esc(a.arch)} &middot; ${mb(a.size)}</span>
          </a>
        </li>`,
      )
      .join('')
    return `
      <article class="dl-card" data-os="${key}">
        <h3 class="dl-card__name">${name}</h3>
        <p class="dl-card__note">${note}</p>
        <ul class="dl-card__assets">${rows}</ul>
      </article>`
  }).join('')

  return `<div class="dl-grid">${cards}</div>`
}

/** Lets Google show the app as software rather than as an article. */
function jsonLd(rel: Release): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Polyform',
    applicationCategory: 'DesignApplication',
    operatingSystem: 'Windows, macOS, Linux',
    softwareVersion: rel.version ?? undefined,
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
        const version = rel.version ? `v${rel.version}` : 'beta'
        const tokens: Record<string, string> = {
          '%TITLE%': esc(SITE_TITLE),
          '%DESCRIPTION%': esc(SITE_DESCRIPTION),
          '%CANONICAL%': SITE_URL,
          '%OG_IMAGE%': abs('og.png'),
          '%BASE%': BASE,
          '%VERSION%': esc(version),
          '%RELEASE_URL%': esc(rel.htmlUrl),
          '%CHECKSUMS_URL%': esc(rel.checksumsUrl ?? RELEASES_URL),
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
    // A landing page has no reason to code-split; one small file beats a
    // waterfall of two.
    assetsInlineLimit: 4096,
  },
})
