# swiss-plus-snapshot

Daily static, JS-free copy of the public site (sitemap pages, CSS, fonts, one webp per image),
published on GitHub Pages as an SEO fallback. Built by `scripts/build.mjs` in `.github/workflows/snapshot.yml`.
If the origin is unhealthy the build fails and the previous deployment stays live.
