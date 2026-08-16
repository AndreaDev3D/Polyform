// Every URL the site emits derives from HERE.
//
// The site is served as a GitHub *project* page, so it lives under a path
// prefix (`/Polyform/`) rather than at a domain root. That prefix is the one
// thing that reliably breaks this class of site: an `<a href="/download">` or
// an `og:image` written as `/og.png` works in dev and 404s in production,
// because production is not the root. So no file outside this one writes a
// leading-slash path or a hostname — they call `url()` and `abs()` below.
//
// Moving to a real domain later (polyform.app, say) is TWO edits here:
// set ORIGIN to the new host, set BASE to '/', and drop a `CNAME` file with
// the bare hostname into site/public/. Nothing else in the site knows the
// difference.

export const OWNER = 'AndreaDev3D'
export const REPO = 'Polyform'

/** Scheme + host, no trailing slash. */
export const ORIGIN = `https://${OWNER.toLowerCase()}.github.io`

/** Path prefix, leading AND trailing slash. '/' when served from a root. */
export const BASE = `/${REPO}/`

/** The canonical site URL, with its trailing slash. */
export const SITE_URL = `${ORIGIN}${BASE}`

/** A site-relative asset path → a path the browser can actually resolve. */
export function url(pathFromSiteRoot: string): string {
  return BASE + pathFromSiteRoot.replace(/^\/+/, '')
}

/** A site-relative asset path → an absolute https:// URL, for og: and canonical. */
export function abs(pathFromSiteRoot: string): string {
  return ORIGIN + url(pathFromSiteRoot)
}

export const GITHUB_URL = `https://github.com/${OWNER}/${REPO}`
export const RELEASES_URL = `${GITHUB_URL}/releases`
export const ISSUES_URL = `${GITHUB_URL}/issues`

/** A file in the repo, on the default branch. */
export function repoFile(pathInRepo: string): string {
  return `${GITHUB_URL}/blob/production/${pathInRepo.replace(/^\/+/, '')}`
}

export const SITE_TITLE = 'Polyform — a local-first vector design tool'
export const SITE_DESCRIPTION =
  'A free, open-source vector design editor for Windows, macOS and Linux. ' +
  'No cloud, no account, no server — every project is a plain folder on your disk.'
