# taekwondp-feed

Public news/results feed for the **taekwondp** iOS app.

A GitHub Actions cron aggregates RSS sources every 30 minutes, normalizes everything into one JSON file, and GitHub Pages serves it as a static URL. The iOS app fetches that JSON. **Zero cost.**

## Live feed URL

`https://gulflens.github.io/taekwondp-feed/news.json`

## How it works

1. `aggregate.mjs` fetches a handful of public RSS feeds (Google News queries, Reddit r/taekwondo)
2. Parses items, dedupes by URL, sorts newest-first, caps at 200 entries
3. Writes the result to `docs/news.json`
4. GitHub Actions (`.github/workflows/aggregate.yml`) commits the file back to `main` on every cron run
5. GitHub Pages serves `docs/` so the JSON is available at the URL above

## One-time setup (after pushing this repo to GitHub)

1. Create a new **public** repo on GitHub named `taekwondp-feed` (public = unlimited free Actions minutes)
2. Push these files: `git init && git add -A && git commit -m "init" && git remote add origin https://github.com/gulflens/taekwondp-feed.git && git push -u origin main`
3. **Settings → Pages**: source = `Deploy from a branch`, branch = `main`, folder = `/docs`. Save.
4. **Settings → Actions → General → Workflow permissions**: `Read and write permissions`. Save.
5. **Actions tab → "Aggregate taekwondo feed" → Run workflow** (or just push, which triggers it). After ~1 min, `docs/news.json` will be filled in.

After that, the cron takes over and refreshes the feed every 30 minutes automatically.

## Adding more sources

Edit the `SOURCES` array in `aggregate.mjs`. Each entry is `{ name, url, category }` where `category` is one of `news`, `result`, `upcoming`, `live`.

## Running locally to test

```bash
node aggregate.mjs
cat docs/news.json
```

## Cost

$0. Forever. (Public repo = unlimited Actions minutes; Pages is free for public repos.)
