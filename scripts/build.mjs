// Builds a static, JS-free snapshot of the public site for SEO fallback (GitHub Pages).
// Usage: BASE=https://www.swissplus.co OUT=dist node scripts/build.mjs
import { createHash } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const BASE = (process.env.BASE || 'https://www.swissplus.co').replace(/\/$/, '')
const OUT = process.env.OUT || 'dist'
const CONCURRENCY = Number(process.env.CONCURRENCY || 6)
const UA = 'swiss-plus-snapshot/1.0'

const stats = { pages: 0, assets: 0, bytes: 0, failures: [] }
const assetCache = new Map() // source url (absolute) -> published path

async function get(url, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
  throw new Error(`${url}: ${last.message}`)
}

async function save(path, data) {
  const file = join(OUT, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, data)
  stats.bytes += data.length
}

const EXT = { 'image/avif': 'avif', 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/gif': 'gif' }

// Downloads one asset and returns the path it is published at ('/...').
async function fetchAsset(rawPath) {
  const abs = new URL(rawPath.replace(/&amp;/g, '&'), BASE + '/').href
  if (assetCache.has(abs)) return assetCache.get(abs)
  const promise = (async () => {
    try {
      const res = await get(abs)
      const buf = Buffer.from(await res.arrayBuffer())
      const u = new URL(abs)
      let pub
      if (u.pathname.startsWith('/_next/image')) {
        const type = (res.headers.get('content-type') || '').split(';')[0]
        pub = `/_img/${createHash('sha1').update(abs).digest('hex').slice(0, 16)}.${EXT[type] || 'bin'}`
      } else {
        pub = decodeURIComponent(u.pathname)
      }
      let body = buf
      if (pub.endsWith('.css')) body = Buffer.from(await rewriteCss(buf.toString('utf8'), u))
      await save(pub, body)
      stats.assets++
      return pub
    } catch (e) {
      stats.failures.push(String(e.message))
      return null
    }
  })()
  assetCache.set(abs, promise)
  return promise
}

async function rewriteCss(css, cssUrl) {
  const refs = new Set()
  for (const m of css.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)) if (!m[2].startsWith('data:')) refs.add(m[2])
  for (const ref of refs) {
    const target = new URL(ref, cssUrl)
    if (target.origin !== new URL(BASE).origin) continue
    const pub = await fetchAsset(target.pathname + target.search)
    if (pub) css = css.split(ref).join(pub)
  }
  return css
}

const ASSET_RE = /\/(?:_next\/static\/[^"'\s,)<>]+|_next\/image\?[^"'\s,)<>]+|media\/[^"'\s,)<>]+|fonts\/[^"'\s,)<>]+)/g

async function snapshotPage(url) {
  const res = await get(url)
  let html = await res.text()
  // No JS in the snapshot: the HTML is complete (server rendered) and nothing can hydrate against missing RSC data.
  html = html
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*\bas="script"[^>]*>/g, '')
    .replace(/<link\b[^>]*\bas="script"[^>]*>/g, '')
  // `&quot;` is how an attribute value ends inside JSON-in-HTML; links without a file extension are pages, not assets.
  const refs = [...new Set((html.match(ASSET_RE) || []).map((r) => r.replace(/&quot;.*$/, '')))].filter(
    (r) => r.startsWith('/_next/image?') || /\.[a-z0-9]+(\?|$)/i.test(r.split('/').pop()),
  )
  // /_next/image has one URL per width and format. The snapshot keeps ONE file per source image
  // (webp, closest to 1080px wide) and points every variant at it: smaller, and all that SEO needs.
  const groups = new Map()
  const plain = []
  for (const ref of refs) {
    if (!ref.startsWith('/_next/image?')) { plain.push(ref); continue }
    const q = new URL(ref.replace(/&amp;/g, '&'), BASE + '/').searchParams
    const key = q.get('url')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ ref, w: Number(q.get('w') || 0), f: q.get('f') })
  }
  for (const variants of groups.values()) {
    const webp = variants.filter((v) => v.f === 'webp')
    const pool = webp.length ? webp : variants
    const fit = pool.filter((v) => v.w <= 1080).sort((a, b) => b.w - a.w)
    const chosen = fit[0] || pool.sort((a, b) => a.w - b.w)[0]
    const pub = await fetchAsset(chosen.ref)
    if (pub) for (const v of variants) html = html.split(v.ref).join(pub)
  }
  for (const ref of plain) {
    const pub = await fetchAsset(ref)
    if (pub) html = html.split(ref).join(pub)
  }
  const u = new URL(url)
  let p = decodeURIComponent(u.pathname).replace(/\/$/, '')
  await save(`${p}/index.html`.replace(/^\//, ''), Buffer.from(html))
  stats.pages++
}

async function pool(items, fn) {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const item = queue.shift()
        try {
          await fn(item)
        } catch (e) {
          stats.failures.push(String(e.message))
        }
      }
    }),
  )
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const sitemap = await (await get(`${BASE}/sitemap.xml`)).text()
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
if (urls.length < 50) throw new Error(`sitemap has only ${urls.length} urls; refusing to publish a broken snapshot`)
console.log(`${urls.length} urls in sitemap`)

await pool(urls, snapshotPage)

// Same-origin site files.
await save('sitemap.xml', Buffer.from(sitemap))
for (const f of ['robots.txt', 'favicon.ico']) {
  try {
    await save(f, Buffer.from(await (await get(`${BASE}/${f}`)).arrayBuffer()))
  } catch (e) {
    stats.failures.push(String(e.message))
  }
}
await save('.nojekyll', Buffer.from(''))
await save(
  '404.html',
  Buffer.from('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>404</title><p>این صفحه در نسخه‌ی آرشیوی سایت موجود نیست.</p>'),
)

const mb = (stats.bytes / 1024 / 1024).toFixed(1)
console.log(`pages=${stats.pages}/${urls.length} assets=${stats.assets} size=${mb}MB failures=${stats.failures.length}`)
for (const f of stats.failures.slice(0, 20)) console.log('  fail:', f)
// Too many failures means the origin was unhealthy: do not replace the last good snapshot.
if (stats.pages < urls.length * 0.95) {
  console.error('too many pages failed, aborting')
  process.exit(1)
}
