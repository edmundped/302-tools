# 302 Data Tools

A browser-only extraction desk for analysts. Turns PDFs, scans, screenshots, spreadsheets and web
pages into two clean CSVs — one for machines, one for humans — without a single byte leaving the
laptop.

Static site. No build step, no backend, no accounts. Push it to GitHub Pages and it runs.

---

## Why v2 exists

The first build could not extract the documents it was written for. Every GOIL annual report in the
working corpus (2006, 2008, 2010, 2011) is **scanned**. The 2011 report carries 109 characters of
text on each page and all of them belong to a download stamp. The 2010 report has prose notes in
text but every financial table is a raster image.

v1 treated all of those pages as text pages, because a "looks scanned" check that counts fewer than
8 text items never fires when a download stamp is present. It then produced confident-looking
tables out of prose, and wrote its analyst CSV with quoting disabled — so `12,442,697` became two
columns.

`docs/AUDIT.md` has the full findings with line references. `docs/ARCHITECTURE.md` is the contract
this version is built to.

---

## What it does

**Extract** — drop in PDFs, screenshots, Excel workbooks or Word documents.

- Reads the PDF text layer where there is one, using right-edge column clustering so right-aligned
  financial figures land in the correct column.
- Detects genuinely scanned pages *after* stripping repeated headers, footers and download stamps,
  and offers OCR on the page or on a single region.
- Recognises statements and notes, parses note numbers, and can export **the note tables only** —
  the common ask when modelling from an annual report.
- Refuses to turn prose into a table, and tells you its confidence for everything it does emit.
- Every cell is editable before anything is downloaded.

**Scrape** — point at a public page, list the reports, spreadsheets and static tables on it with
type and size, and send any of them straight to the extraction desk. Needs the CORS proxy in
`worker/`.

**Tools** — twelve utilities grouped by task: clean, combine, convert, verify, annotate.

---

## Outputs

Three shapes, all quoted correctly.

| File | Shape | For |
|---|---|---|
| `{name}_data.csv` | tidy/long, one row per cell | pandas, a database, a model |
| `{name}_p{page}_t{n}_review.csv` | wide, original formatting kept | eyeballing against the page |
| `{name}_notes.csv` | note tables only, ordered by note number | financial statement work |

The review CSV carries a `check_total` column that **computes** the sum of each total row's
components and compares it to the printed figure — `2011: ok` or
`2011: calc 342118 vs printed 350000 (diff -7882)`. Excel export writes one sheet per table plus an
`INDEX` sheet of every table, its page, confidence and warnings.

---

## Running it

Nothing to install.

```bash
python3 -m http.server 8177
```

Then open `http://localhost:8177`. To deploy, push to a GitHub Pages branch.

The scraper needs a CORS proxy, because a browser cannot fetch another origin directly. Deploy the
worker in `worker/` and paste its URL into the app's settings — see `worker/README.md`.

---

## Tests

```bash
node test/run-tests.mjs      # 37 checks — extraction core
node test/tools-check.mjs    # 83 checks — tools, scraper helpers, zip
```

No framework, no dependencies. The extraction tests run against real word geometry captured from
actual documents (`test/fixtures/`), so they exercise the column maths rather than a mock. Every
check maps to a defect in `docs/AUDIT.md`: right-aligned columns, all-numeric headers, dash-vs-zero,
prose rejection, scanned-page detection, CSV quoting.

---

## Layout

```
index.html            shell
css/                  tokens, base, components, layout
js/
  core/               bus, store, model, numbers, csv, zip, config
  ingest/             pdf-text, pdf-ocr, xlsx, docx, image, html-table  (registry)
  extract/            geometry, tables, classify, financial, boilerplate
  ui/                 shell, dropzone, preview, progress, panels
  tools/              one file per tool  (registry)
  scraper/            discover, fetchers
worker/               Cloudflare Worker CORS proxy
docs/                 AUDIT.md, ARCHITECTURE.md
test/                 harnesses + fixtures
```

Adding a file format means adding one file to `js/ingest/` and registering it. Adding a tool means
adding one file to `js/tools/`. Neither requires editing a shared file.

---

## Known limits

Stated plainly, because silent failure is the thing this rebuild exists to remove.

- **OCR is slow and imperfect.** Digits are the hardest thing to read. Every OCR table is marked as
  such and should be footed against the page before use.
- **Nested subtotals can produce a false foot-check warning.** A grand total whose components
  include an intermediate subtotal is compared against the detail rows since the last total, so it
  can report a difference that is really the subtotal. Read the message, not just the flag.
- **Complex merged layouts** still need the human preview. Geometry gets most financial tables; it
  will not get all of them.
- **JavaScript-rendered sites** expose nothing to a static fetch. The scraper will correctly report
  finding nothing.
- **Legacy `.doc`** cannot be read in a browser. Save as `.docx`.
- **Word documents have no pagination** until rendered, so every table is recorded as page 1.
