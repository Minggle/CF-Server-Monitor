import {
  THEME_STORE_CACHE_TTL_SECONDS,
  THEME_STORE_URL
} from '../utils/config.js'

let cachedThemeStore = null
let cacheTime = 0

const createEmptyThemeStore = () => ({ schema: 1, themes: [] })

const normalizeThemeStore = (data) => {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      ...data,
      schema: data.schema || 1,
      themes: Array.isArray(data.themes) ? data.themes : []
    }
  }

  return createEmptyThemeStore()
}

export async function handleTheme() {
  const now = Math.floor(Date.now() / 1000)
  if (cachedThemeStore && (now - cacheTime) < THEME_STORE_CACHE_TTL_SECONDS) {
    return { ok: true, themeStore: cachedThemeStore, cached: true }
  }

  try {
    const res = await fetch(THEME_STORE_URL, {
      headers: { 'User-Agent': 'CFSM-Theme-Store' }
    })

    if (!res.ok) {
      return { ok: false, status: res.status, error: 'themeStoreProxyFailed' }
    }

    const data = await res.json()
    const themeStore = normalizeThemeStore(data)

    cachedThemeStore = themeStore
    cacheTime = now
    return { ok: true, themeStore, cached: false }
  } catch (e) {
    return { ok: false, status: 0, error: 'themeStoreProxyFailed' }
  }
}

// Proxy GitHub commit list for theme versions, so browsers that cannot reach
// api.github.com directly (e.g. mainland China) can still load theme versions.
const SAFE_GITHUB_PART = /^[A-Za-z0-9._-]{1,100}$/
const SAFE_GITHUB_REF = /^[A-Za-z0-9._\/-]{1,200}$/
const COMMITS_CACHE_TTL_SECONDS = 600
const commitsCache = new Map()


const decodeXml = (v) => String(v || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .trim()

// Fallback when api.github.com rate-limits Cloudflare egress IPs: parse the public Atom feed.
async function fetchCommitsFromAtom(owner, repo, sha, perPage) {
  const ref = sha || 'HEAD'
  const res = await fetch(`https://github.com/${owner}/${repo}/commits/${ref.split('/').map(encodeURIComponent).join('/')}.atom`, {
    headers: { 'User-Agent': 'CFSM-Theme-Store', 'Accept': 'application/atom+xml' }
  })
  if (!res.ok) return null
  const xml = await res.text()
  const commits = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = m[1]
    const id = (body.match(/<id>[^<]*Commit\/([a-f0-9]{40})<\/id>/i) || [])[1]
    if (!id) continue
    const date = decodeXml((body.match(/<updated>([^<]*)<\/updated>/) || [])[1])
    const title = decodeXml((body.match(/<title>([\s\S]*?)<\/title>/) || [])[1])
    commits.push({ sha: id, commit: { message: title, author: { date }, committer: { date } } })
    if (commits.length >= perPage) break
  }
  return commits.length ? commits : null
}

export async function handleThemeCommits(url) {
  const owner = url.searchParams.get('owner') || ''
  const repo = url.searchParams.get('repo') || ''
  const sha = url.searchParams.get('sha') || ''
  const perPage = Math.min(Math.max(parseInt(url.searchParams.get('per_page') || '10', 10) || 10, 1), 30)

  if (!SAFE_GITHUB_PART.test(owner) || !SAFE_GITHUB_PART.test(repo) || (sha && !SAFE_GITHUB_REF.test(sha)) || sha.includes('..')) {
    return { ok: false, status: 400, error: 'invalidParams' }
  }

  const key = `${owner}/${repo}@${sha}#${perPage}`
  const now = Math.floor(Date.now() / 1000)
  const hit = commitsCache.get(key)
  if (hit && (now - hit.time) < COMMITS_CACHE_TTL_SECONDS) {
    return { ok: true, commits: hit.commits, cached: true }
  }

  try {
    const apiUrl = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`)
    if (sha) apiUrl.searchParams.set('sha', sha)
    apiUrl.searchParams.set('per_page', String(perPage))
    const res = await fetch(apiUrl.href, {
      headers: { 'User-Agent': 'CFSM-Theme-Store', 'Accept': 'application/vnd.github+json' }
    })
    const data = res.ok ? await res.json().catch(() => null) : null
    if (!Array.isArray(data)) {
      const atom = await fetchCommitsFromAtom(owner, repo, sha, perPage).catch(() => null)
      if (atom) {
        commitsCache.set(key, { commits: atom, time: now })
        return { ok: true, commits: atom, cached: false }
      }
      if (hit) return { ok: true, commits: hit.commits, cached: true }
      return { ok: false, status: 502, error: 'themeCommitsProxyFailed' }
    }
    // keep only the fields the frontend uses
    const commits = data.map(c => ({
      sha: c?.sha,
      commit: {
        message: c?.commit?.message,
        author: { date: c?.commit?.author?.date },
        committer: { date: c?.commit?.committer?.date }
      }
    }))
    commitsCache.set(key, { commits, time: now })
    if (commitsCache.size > 200) commitsCache.delete(commitsCache.keys().next().value)
    return { ok: true, commits, cached: false }
  } catch (e) {
    const atom = await fetchCommitsFromAtom(owner, repo, sha, perPage).catch(() => null)
    if (atom) return { ok: true, commits: atom, cached: false }
    if (hit) return { ok: true, commits: hit.commits, cached: true }
    return { ok: false, status: 502, error: 'themeCommitsProxyFailed' }
  }
}
