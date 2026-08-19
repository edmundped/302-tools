# 302 Data Tools — audit of the first build

Audited against the live site and the three sample files (2010 + 2011 GOIL annual reports, Fan Milk PLc.xlsx).
Codebase at audit time: 1,415 lines across 8 files.

---

## The headline finding: the app cannot extract the documents it exists to extract

Both GOIL annual reports were run through `pdftotext` to measure their text layers.

| Report | Pages | Real text | Verdict |
|---|---|---|---|
| 2011 GOIL | 44 | **109 characters on every single page** | Fully scanned. Zero extractable content. |
| 2010 GOIL | 80 | Prose notes have text; **every financial table is an image** | Hybrid. |

The 109 characters on each page of the 2011 report are not content. They are a download stamp:

```
302 Analytics
benjamin@302analytics.com
Downloaded: 2026-08-18 17:45:28 GMT
```

Searching both documents for numbers with thousands separators — the signature of a financial
table — returns **21 hits in the 2010 report and 0 in the 2011 report**. Page 32 of the 2010
report is headed "Statement of Financial Position"; the heading is text and the entire statement
beneath it is a raster image.

Two consequences:

1. **Run today, the extractor returns nothing usable from either report.** Not a poor table — no
   table. The numbers are pixels.
2. **The "looks scanned" check never fires.** `pdf-extract.js:24` flags a page as scanned when it
   has fewer than 8 text items. Every page here carries the download stamp and the running header,
   so every page clears the bar and is treated as a text page. The user is told nothing.

OCR is specified in the original brief as "optional, last". On this evidence it is the **primary
path** for Ghanaian annual reports, not an afterthought. This is what the request to try
"screenshots and text extraction" is correctly reaching for.

---

## Critical defects in the extraction core

### 1. Columns are clustered on the wrong edge — `pdf-extract.js:107`

`inferColumnAnchors` clusters text items by their **left** x-coordinate. Financial tables are
**right-aligned**. `1,234` and `12,442,697` in the same column begin at very different x positions
but end at the same one. Left-edge clustering therefore shatters one numeric column into several,
or merges neighbours.

The fix is to cluster numeric cells on their **right** edge (`x + width`) and label cells on their
left, or to cluster on the gaps between columns rather than the items themselves.

### 2. Every row is trimmed independently, destroying alignment — `pdf-extract.js:139`

`trimEmptyEdges` is applied per row. A row whose first cell is blank loses that cell and shifts one
column left. Rows in the same table no longer share a column index, so `row[0]` is a label on some
rows and a number on others. Everything downstream — headers, the tidy CSV, the row labels —
inherits the corruption. Trimming must be decided once for the table, not per row.

### 3. The anchor is the leftmost item, not the cluster centre — `pdf-extract.js:115`

Greedy first-wins assignment. The first x seen in a cluster becomes the anchor forever, so anchors
drift toward whichever row happened to be widest, and later items snap to the wrong column.

### 4. Header detection fails on the commonest financial layout — `pdf-extract.js:148`

`chooseHeaderRow` requires that **no** cell in the header starts with a digit. The standard header
of a financial statement is `2011  2010` — all digits. Header detection fails on exactly the case
that matters, and the years become a data row.

### 5. Prose is detected as tables — `pdf-extract.js:76`

`looksTabular` is true when a line has two or more text items. Ordinary sentences satisfy this.
Pages 37–39 of the 2010 report are continuous prose and will be emitted as multi-column "tables".
The app produces confident-looking garbage, which is worse than producing nothing.

### 6. Fixed tolerances

Row grouping at 3.5pt and column clustering at 18pt are hard-coded. Both should scale with the
median font size on the page.

---

## Critical defects in CSV output

### 7. CSV quoting is disabled — `csv.js:28`

```js
Papa.unparse(rows, { quotes: false })
```

The review CSV is specified to **preserve original formatting** — `12,442,697`, `(1,234)`. With
quoting off, every one of those commas becomes a column break. The review CSV is structurally
broken by design for precisely the values it exists to preserve. Any label containing a comma
breaks too.

### 8. `check_total` is a placeholder — `csv.js:92`

It emits the literal string `printed_total` when a row label matches `/total|subtotal|net/`. It
never computes or compares anything. The foot-check the brief asks for does not exist.

### 9. The review CSV is not a CSV

`tablesToCsvFiles` concatenates every table into one file separated by blank rows and
`table_id: 3` marker rows. That is not a rectangular CSV and will not load cleanly anywhere. Tables
belong in separate files, or in an Excel workbook with one sheet each.

### 10. Number normalisation gaps

No handling of: trailing-minus (`1234-`), en/em-dash negatives, unicode minus, footnote markers
glued to values (`1,234²`), or European decimal format.

---

## Scraper

Functional but thin. Finds `<a href>` ending in `.pdf` and nothing else.

- No content-type detection, so PDFs served from extensionless URLs are missed.
- Only PDFs. The user's own files include `.xlsx`; `.doc`/`.docx`/`.csv`/images are all ignored.
- No file sizes, despite the brief asking for them.
- No pagination or crawl depth — one page only.
- Downloaded files cannot be piped into the extractor; the brief asks for this.
- The responsible-use guidance the brief requires is not surfaced anywhere in the UI.
- Proxy URL is typed into a field and lost on refresh.

---

## Utility tools

The brief lists ten tools. **Four exist** in `tools.js` (merge, header map, provenance stamp,
schema validate). Four more are implemented inline in `app.js` rather than as modules (number
cleaner, foot check, unit normaliser, CSV→Excel). Missing entirely: transpose, dedupe, trim,
screenshot OCR.

Ordering is arbitrary — schema validation sits between provenance stamping and nothing in
particular. There is no grouping by task.

`validateSchema` reports `rows.length - 1` as "data rows checked" without checking any of them
against anything beyond header presence.

---

## Architecture

`app.js` is a single 300-line IIFE holding tab routing, drag-and-drop, rendering, table editing,
scraper wiring and eight tool handlers. Adding a tool means editing a shared file in four places
(HTML panel, event wiring, handler, and sometimes `tools.js`).

There is no module registry, no shared table model, and no separation between extraction, transform
and presentation. `js/tools.js` and the tool handlers in `app.js` disagree about where logic lives.

The three concerns that must be separable — **ingest** (what kind of file), **extract** (how to get
a grid out of it), and **emit** (what CSV shape to write) — are entangled.

---

## What is actually sound

Worth keeping rather than rewriting:

- The two-output concept (tidy machine CSV + faithful analyst CSV) is the right idea and is what
  makes this tool worth having. It just needs correct implementation.
- The static, no-backend, privacy-preserving constraint is correct and should be held.
- The brand styling in `css/styles.css` is clean and on-brand; it needs restructuring into
  components, not redesigning.
- The Cloudflare Worker proxy approach is the right call for the scraper.
- Human-in-the-loop preview before download is the right default and must survive the rewrite.

---

## Priorities

1. **OCR as a first-class path**, with honest per-page detection of what has a usable text layer.
2. **Fix the column geometry** — right-edge clustering, table-level trimming, adaptive tolerances.
3. **Fix CSV quoting** — this silently corrupts output today.
4. **Separate ingest / extract / emit** so formats and outputs can be added without touching a shared file.
5. **Notes-only extraction** for financial reports, as requested.
6. **Broaden ingest** to xlsx, docx, images.
7. **Scraper**: content-type detection, more file types, sizes, pipe-to-extractor.
8. **Tools**: consolidate into modules, drop the dead weight, order by task, add the missing ones.
