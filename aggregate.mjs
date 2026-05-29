#!/usr/bin/env node
// Aggregates taekwondo news/results from public RSS feeds into one
// JSON file at docs/news.json, served via GitHub Pages.
//
// Runs in GitHub Actions on cron. Zero dependencies — uses Node's
// built-in fetch and hand-rolled regex parsing for RSS/Atom.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Where the article-URL → og:image map is persisted across cron runs.
// Stored under docs/ so it ships with the site (no extra branches).
const CACHE_PATH = join(__dirname, "docs", "image-cache.json");
const FETCH_TIMEOUT_MS = 8000;
const IMAGE_FETCH_CONCURRENCY = 6;

// Sources are listed **most specific first** so when two queries return
// the same article, dedupe keeps the first occurrence — giving the more
// specific category (result/upcoming) priority over the generic "news".
// All queries use the exact phrase "taekwondo" to cut down on the
// noise that Google News returns when the term only appears in the body.
//
// Direct publisher feeds (MASTKD, Reddit) are listed first because
// their <link> fields point at the real article URL, so we can scrape
// a real og:image. Google News redirect URLs only expose Google News's
// own logo as og:image, so those items end up image-less and the iOS
// app renders a styled placeholder card for them.
const SOURCES = [
    // -- Direct publishers (real URLs, real images) ------------------
    {
        name: "MASTKD",
        url: "https://www.mastkd.com/feed/",
        category: "news",
    },
    // -- Results-shaped queries (specific events) ---------------------
    {
        name: "Google News — World Taekwondo Championships",
        url: 'https://news.google.com/rss/search?q=%22World+Taekwondo+Championships%22&hl=en-US&gl=US&ceid=US:en',
        category: "result",
    },
    {
        name: "Google News — Taekwondo Grand Prix",
        url: 'https://news.google.com/rss/search?q=%22Taekwondo%22+%22Grand+Prix%22&hl=en-US&gl=US&ceid=US:en',
        category: "result",
    },
    {
        name: "Google News — Asian Games taekwondo",
        url: 'https://news.google.com/rss/search?q=%22taekwondo%22+%22Asian+Games%22&hl=en-US&gl=US&ceid=US:en',
        category: "result",
    },
    {
        name: "Google News — Pan American Games taekwondo",
        url: 'https://news.google.com/rss/search?q=%22taekwondo%22+%22Pan+American%22&hl=en-US&gl=US&ceid=US:en',
        category: "result",
    },
    {
        name: "Google News — Olympic taekwondo",
        url: 'https://news.google.com/rss/search?q=%22taekwondo%22+%22Olympic%22&hl=en-US&gl=US&ceid=US:en',
        category: "result",
    },
    // -- Results-shaped queries (outcome words) -----------------------
    {
        name: "Google News — taekwondo gold medal",
        url: 'https://news.google.com/rss/search?q=%22taekwondo%22+%22gold+medal%22&hl=en-US&gl=US&ceid=US:en',
        category: "result",
    },
    {
        name: "Google News — taekwondo champion",
        url: 'https://news.google.com/rss/search?q=%22taekwondo%22+(%22champion%22+OR+%22wins+title%22)&hl=en-US&gl=US&ceid=US:en',
        category: "result",
    },
    // -- Upcoming events ---------------------------------------------
    {
        name: "Google News — taekwondo preview / upcoming",
        url: 'https://news.google.com/rss/search?q=%22taekwondo%22+(%22upcoming%22+OR+%22preview%22+OR+%22ahead+of%22+OR+%22qualifier%22)&hl=en-US&gl=US&ceid=US:en',
        category: "upcoming",
    },
    {
        name: "Google News — taekwondo schedule / qualify",
        url: 'https://news.google.com/rss/search?q=%22taekwondo%22+(%22schedule%22+OR+%22qualify%22+OR+%22will+host%22)&hl=en-US&gl=US&ceid=US:en',
        category: "upcoming",
    },
    // -- Federations / discipline-specific ---------------------------
    {
        name: "Google News — World Taekwondo federation",
        url: 'https://news.google.com/rss/search?q=%22World+Taekwondo%22&hl=en-US&gl=US&ceid=US:en',
        category: "news",
    },
    {
        name: "Google News — USA Taekwondo",
        url: 'https://news.google.com/rss/search?q=%22USA+Taekwondo%22&hl=en-US&gl=US&ceid=US:en',
        category: "news",
    },
    {
        name: "Google News — kyorugi",
        url: 'https://news.google.com/rss/search?q=%22kyorugi%22+OR+%22kyeorugi%22&hl=en-US&gl=US&ceid=US:en',
        category: "news",
    },
    // -- Broadest catch-all (runs last so it doesn't override) -------
    {
        name: "Google News — taekwondo (general)",
        url: 'https://news.google.com/rss/search?q=%22taekwondo%22&hl=en-US&gl=US&ceid=US:en',
        category: "news",
    },
    // -- Reddit communities ------------------------------------------
    {
        name: "Reddit r/taekwondo",
        url: "https://www.reddit.com/r/taekwondo/.rss",
        category: "news",
    },
    {
        name: "Reddit r/martialarts — taekwondo",
        url: "https://www.reddit.com/r/martialarts/search.rss?q=taekwondo&restrict_sr=1&sort=new",
        category: "news",
    },
];

// Drop items whose title/summary doesn't mention any actual taekwondo
// keyword. Catches the case where Google News matches because the term
// appeared somewhere deep in the article body but the headline is junk.
const RELEVANCE_KEYWORDS = [
    "taekwondo",
    "tae kwon do",
    "kyorugi",
    "kyeorugi",
    "poomsae",
    "kukkiwon",
];

function isRelevant(item) {
    const haystack =
        (item.title + " " + (item.summary || "")).toLowerCase();
    return RELEVANCE_KEYWORDS.some((k) => haystack.includes(k));
}

// Minimal RSS / Atom parser. Good enough for the feeds we consume.
function parseFeed(xml) {
    const items = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
    const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
    for (const m of xml.matchAll(itemRegex)) {
        const parsed = parseElement(m[1], false);
        if (parsed) items.push(parsed);
    }
    for (const m of xml.matchAll(entryRegex)) {
        const parsed = parseElement(m[1], true);
        if (parsed) items.push(parsed);
    }
    return items;
}

function parseElement(body, isAtom) {
    const title = extractTag(body, "title");
    let link;
    if (isAtom) {
        const linkMatch = body.match(/<link[^>]*href="([^"]+)"/);
        link = linkMatch ? linkMatch[1] : null;
    } else {
        link = extractTag(body, "link");
    }
    const pubDate = isAtom
        ? extractTag(body, "updated") || extractTag(body, "published")
        : extractTag(body, "pubDate") || extractTag(body, "dc:date");
    const description =
        extractTag(body, "description") ||
        extractTag(body, "summary") ||
        extractTag(body, "content");
    if (!title || !link) return null;
    const cleanedSummary = description ? cleanText(description) : null;
    return {
        title: cleanText(title),
        url: link,
        summary: cleanedSummary ? cleanedSummary.slice(0, 280) : null,
        publishedAt: pubDate
            ? new Date(pubDate).toISOString()
            : new Date().toISOString(),
    };
}

function extractTag(body, tag) {
    const re = new RegExp(
        `<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`,
        "i"
    );
    const m = body.match(re);
    return m ? m[1].trim() : null;
}

function cleanText(s) {
    return s
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function stableId(url) {
    // Hash the URL so each item has a deterministic ID across runs.
    let h = 0;
    for (let i = 0; i < url.length; i++) {
        h = (h << 5) - h + url.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h).toString(36);
}

// ---- Open Graph hero-image extraction --------------------------------
// Every well-formed news article exposes its hero image via
// <meta property="og:image" content="..."> in the document head. We
// follow the article URL once, parse for that tag, and remember the
// result so subsequent cron runs only fetch images for *new* articles.

async function loadImageCache() {
    try {
        return JSON.parse(await readFile(CACHE_PATH, "utf8"));
    } catch {
        return {};
    }
}

async function saveImageCache(cache) {
    await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Extract og:image (preferred) or twitter:image (fallback) from HTML.
// Handles either attribute order for the meta tag.
function extractOGImage(html, baseURL) {
    const patterns = [
        /<meta\s+[^>]*property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
        /<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i,
        /<meta\s+[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
        /<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i,
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) {
            try {
                return upgradeImageURL(new URL(m[1], baseURL).toString());
            } catch {
                return null;
            }
        }
    }
    return null;
}

// Some CDNs let you request a specific size via a URL suffix.
// Google News thumbnails come back at 300px wide by default — bump to
// 900 so the card's hero image looks sharp on retina screens.
function upgradeImageURL(url) {
    if (url.includes("lh3.googleusercontent.com")) {
        return url.replace(/=[sw][0-9]+(?:-[sw][0-9]+)*$/i, "=s0-w900");
    }
    return url;
}

async function fetchOGImage(articleURL) {
    // Hosts where we already know we can't get a useful og:image:
    //  - Google News: redirect wrapper exposes only the GN site logo
    //  - Reddit: SPA hides meta tags client-side, .json blocks our IP,
    //    old.reddit returns a generic icon
    // Both bucket of items render as styled placeholder cards in iOS.
    if (/^https?:\/\/(?:news\.google\.com|(?:www\.|old\.)?reddit\.com)\//i.test(articleURL)) {
        return null;
    }
    try {
        const res = await fetch(articleURL, {
            redirect: "follow",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (compatible; taekwondp-feed/1.0; +https://github.com/gulflens/taekwondp-feed)",
                Accept: "text/html,application/xhtml+xml",
            },
        });
        if (!res.ok) return null;
        // 2 MB is enough to reach Google News's tail-positioned meta
        // tags and still protect against pathologically large pages.
        const html = await res.text();
        const scanned = html.slice(0, Math.min(html.length, 2_000_000));
        return extractOGImage(scanned, res.url);
    } catch {
        return null;
    }
}

// Process items concurrently in small batches so we don't open
// hundreds of sockets at once. Cache hits return instantly.
async function attachImages(items, cache) {
    let fetched = 0;
    let hit = 0;
    for (let i = 0; i < items.length; i += IMAGE_FETCH_CONCURRENCY) {
        const batch = items.slice(i, i + IMAGE_FETCH_CONCURRENCY);
        await Promise.all(
            batch.map(async (item) => {
                if (item.url in cache) {
                    item.imageURL = cache[item.url];
                    hit++;
                    return;
                }
                const img = await fetchOGImage(item.url);
                item.imageURL = img;
                cache[item.url] = img; // remember null too so we don't retry
                fetched++;
            })
        );
    }
    console.log(`Images: ${hit} cache hit, ${fetched} fetched`);
}

// ----------------------------------------------------------------------

async function fetchSource(source) {
    try {
        const res = await fetch(source.url, {
            headers: {
                "User-Agent":
                    "taekwondp-feed/1.0 (https://github.com/gulflens/taekwondp-feed)",
                Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
            },
        });
        if (!res.ok) {
            console.error(`! ${source.name}: HTTP ${res.status}`);
            return [];
        }
        const xml = await res.text();
        const items = parseFeed(xml).map((it) => ({
            id: stableId(it.url),
            title: it.title,
            summary: it.summary,
            source: source.name,
            publishedAt: it.publishedAt,
            url: it.url,
            imageURL: null,
            category: source.category,
        }));
        console.log(`✓ ${source.name}: ${items.length} items`);
        return items;
    } catch (err) {
        console.error(`! ${source.name}: ${err.message}`);
        return [];
    }
}

async function main() {
    const all = [];
    for (const source of SOURCES) {
        const items = await fetchSource(source);
        all.push(...items);
    }
    const beforeFilter = all.length;

    // Drop items whose title/summary doesn't mention a taekwondo term.
    // Google News matches on body content, so the headline can be junk.
    const relevant = all.filter(isRelevant);
    const droppedAsIrrelevant = beforeFilter - relevant.length;

    // Dedupe by URL **and** normalized title. SOURCES are ordered
    // most-specific-first, so the first occurrence wins — meaning a
    // story that matched both "gold medal" and the generic catch-all
    // keeps the more specific `result` category.
    const seenUrls = new Set();
    const seenTitles = new Set();
    const deduped = relevant.filter((item) => {
        if (seenUrls.has(item.url)) return false;
        const titleKey = item.title.toLowerCase().trim();
        if (seenTitles.has(titleKey)) return false;
        seenUrls.add(item.url);
        seenTitles.add(titleKey);
        return true;
    });

    // Newest first.
    deduped.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    // Cap so the file stays small for mobile fetches.
    const items = deduped.slice(0, 200);

    // Hydrate each item with its og:image (or twitter:image) so the
    // iOS app can render a hero photo per card. Uses a persistent
    // cache so most items resolve instantly across cron runs.
    const outDir = join(__dirname, "docs");
    await mkdir(outDir, { recursive: true });
    const cache = await loadImageCache();
    await attachImages(items, cache);
    await saveImageCache(cache);

    const itemsWithImages = items.filter((it) => it.imageURL).length;
    const feed = {
        updatedAt: new Date().toISOString(),
        items,
    };
    await writeFile(
        join(outDir, "news.json"),
        JSON.stringify(feed, null, 2)
    );
    console.log(
        `Wrote ${items.length} items to docs/news.json ` +
        `(${beforeFilter} raw → ${relevant.length} relevant ` +
        `→ ${deduped.length} unique, dropped ${droppedAsIrrelevant} as irrelevant, ` +
        `${itemsWithImages}/${items.length} have images)`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
