#!/usr/bin/env node
// Aggregates taekwondo news/results from public RSS feeds into one
// JSON file at docs/news.json, served via GitHub Pages.
//
// Runs in GitHub Actions on cron. Zero dependencies — uses Node's
// built-in fetch and hand-rolled regex parsing for RSS/Atom.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Sources are listed **most specific first** so when two queries return
// the same article, dedupe keeps the first occurrence — giving the more
// specific category (result/upcoming) priority over the generic "news".
// All queries use the exact phrase "taekwondo" to cut down on the
// noise that Google News returns when the term only appears in the body.
const SOURCES = [
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

    const feed = {
        updatedAt: new Date().toISOString(),
        items,
    };
    const outDir = join(__dirname, "docs");
    await mkdir(outDir, { recursive: true });
    await writeFile(
        join(outDir, "news.json"),
        JSON.stringify(feed, null, 2)
    );
    console.log(
        `Wrote ${items.length} items to docs/news.json ` +
        `(${beforeFilter} raw → ${relevant.length} relevant ` +
        `→ ${deduped.length} unique, dropped ${droppedAsIrrelevant} as irrelevant)`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
