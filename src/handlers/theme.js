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
    if (!res.ok) {
      if (hit) return { ok: true, commits: hit.commits, cached: true }
      return { ok: false, status: 502, error: 'themeCommitsProxyFailed' }
    }
    const data = await res.json()
    if (!Array.isArray(data)) return { ok: false, status: 502, error: 'themeCommitsProxyFailed' }
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
    if (hit) return { ok: true, commits: hit.commits, cached: true }
    return { ok: false, status: 502, error: 'themeCommitsProxyFailed' }
  }
}
