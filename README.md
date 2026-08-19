# 302 Data Tools

Static, client-side tools for analyst table extraction and CSV cleanup.

## What is included

- PDF table extractor using browser-side `pdf.js` text coordinates.
- Two CSV outputs per source: tidy machine-readable data and wide analyst review.
- Site scraper shell for discovering PDF links and static HTML tables through a CORS proxy.
- Utility panels for number cleaning, foot checks, unit conversion, CSV merging, CSV to Excel, header mapping, provenance stamping, and schema validation.

## Run locally

Open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## GitHub Pages

This repo has no build step. Push these files to a GitHub repo and enable GitHub Pages for the repository root.

## Cloudflare Worker proxy for scraping

Browsers cannot fetch arbitrary third-party pages because of CORS. Deploy this Worker and paste the Worker URL into the Scrape tab.

```js
export default {
  async fetch(request) {
    const url = new URL(request.url).searchParams.get("url");
    if (!url) return new Response("missing ?url", { status: 400 });
    const r = await fetch(url, { headers: { "User-Agent": "302-tools" } });
    const body = await r.arrayBuffer();
    return new Response(body, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": r.headers.get("Content-Type") || "text/plain",
      },
    });
  },
};
```

## Known limits

- PDF table detection uses text-position clustering. Complex merged headers, rotated text, and border-heavy layouts may need manual cleanup.
- Scanned PDFs are flagged when little text is available. OCR is not wired into this first version.
- JavaScript-rendered websites may not expose tables or PDF links to a simple HTML fetch.
- No accounts, database, or storage are used. Work happens per browser session.
