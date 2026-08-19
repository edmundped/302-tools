# 302 Data Tools — architecture contract (v2)

Binding for all modules. Ingest, extract and emit are separated so a new file format or a new
output shape never requires editing a shared file.

Still static: plain HTML + ES modules + CDN libraries. No build step. Deployable to GitHub Pages.

---

## Directory layout

```
index.html
css/
  tokens.css          brand tokens only (colours, type scale, spacing)
  base.css            reset + element defaults
  components.css      buttons, cards, tables, drop zones, chips, progress
  layout.css          shell, tabs, panels, grid
js/
  core/
    bus.js            tiny pub/sub event bus
    store.js          session state (files, tables, settings)
    model.js          Table/Doc factory + validators
    numbers.js        number parsing/normalisation (single source of truth)
    csv.js            CSV/XLSX emitters (machine + analyst + notes)
    zip.js            bundle downloads
    config.js         PROXY_URL, CDN versions, persisted settings
  ingest/
    index.js          registry: pick extractor(s) for a File
    pdf-text.js       pdf.js text-layer extraction
    pdf-ocr.js        rasterise + Tesseract, page or region
    xlsx.js           SheetJS -> tables
    docx.js           mammoth -> HTML -> tables
    image.js          PNG/JPG -> Tesseract
    html-table.js     DOM <table> -> tables (shared with scraper)
  extract/
    geometry.js       row grouping + column inference from positioned text
    tables.js         grid assembly, header detection, table-level trim
    classify.js       is this a table or prose? confidence scoring
    financial.js      statement/note detection, note numbering, units
    boilerplate.js    repeated header/footer/watermark detection + removal
  ui/
    shell.js          tab routing, panel mounting
    dropzone.js       file intake
    preview.js        table preview + inline edit + select
    progress.js       long-task progress + cancel
    panel-extract.js
    panel-scrape.js
    panel-tools.js
  tools/
    index.js          tool registry (id, group, order, mount)
    <one file per tool>
  scraper/
    discover.js       fetch via proxy, find files + tables
    fetchers.js       proxy plumbing, content-type sniffing
docs/
```

---

## The data model — `core/model.js`

Everything the app produces is a `Doc` containing `Table`s. Nothing else crosses module
boundaries.

```js
Doc = {
  id: string,               // uuid
  fileName: string,
  fileType: 'pdf' | 'xlsx' | 'docx' | 'image' | 'html',
  pageCount: number,
  pages: Page[],
  tables: Table[],
  meta: {                   // best-effort, may be null
    title, company, periodLabel, currency, unitsScale
  },
  warnings: string[]
}

Page = {
  number: number,
  textChars: number,        // real text after boilerplate removal
  hasTextLayer: boolean,    // textChars >= TEXT_LAYER_MIN (see below)
  needsOcr: boolean,
  ocrApplied: boolean,
  section: 'statements' | 'notes' | 'front' | 'other' | null,
  thumbnail: string | null  // dataURL, lazy
}

Table = {
  id: string,               // `${docId}-p${page}-t${index}`
  docId, sourceFile, page,
  origin: 'pdf-text' | 'pdf-ocr' | 'xlsx' | 'docx' | 'image' | 'html',
  title: string | null,     // caption found above the table
  noteRef: string | null,   // '12' when the table sits under Note 12
  section: 'statements' | 'notes' | 'other' | null,
  units: string | null,     // 'GH¢000' etc, from the caption
  headers: string[][],      // one array per header row; [] if none found
  rows: string[][],         // RECTANGULAR. every row === column count
  columnCount: number,
  confidence: number,       // 0..1, from classify.js
  warnings: string[],
  bbox: {x,y,w,h} | null,   // PDF user-space, for the crop preview
  selected: boolean
}
```

**Rectangularity is a hard invariant.** `model.validateTable(t)` throws if any row length differs
from `columnCount`. Pad with `''`. Never trim a single row on its own.

---

## Numbers — `core/numbers.js`

One implementation. No module may parse numbers itself.

```js
parseNumber(raw) -> {
  value: number | null,   // null when not numeric
  isNegative, isPercent, hadParens,
  raw: string,            // untouched original
  clean: string           // canonical numeric string, '' when not numeric
}
```

Must handle: thousands separators (`,` and space); parentheses negatives `(1,234)`; trailing minus
`1234-`; unicode minus `−`; en/em dash as nil (`–` → empty, not zero); currency symbols and codes
(`GH¢ ₵ $ £ € GHS USD`); percentages (`12.3%` → `0.123`); footnote markers glued to values
(`1,234²`, `1,234*`) — strip the marker, keep it in `warnings`; European format `1.234,56` only
when unambiguous.

`–` (dash) means **not applicable** and must emit empty, never `0`. This distinction is meaningful
in financial statements.

---

## Outputs — `core/csv.js`

Three emitters. All take `Table[]`.

**1. Machine (tidy/long)** — `{base}_data.csv`, one row per cell:

```
source_file,page,table_id,table_title,note_ref,section,row_label,column,value,unit
```

`value` is `parseNumber().clean`. Non-numeric cells are emitted with their text in `value`.

**2. Analyst (wide, faithful)** — one file per table, `{base}_p{page}_t{n}_review.csv`:

Original formatting preserved exactly. Leading `source_file`, `page` columns. A trailing
`check_total` column carrying the **computed** sum of the numeric cells in that row's column group
where the row label matches a total pattern, so the analyst can foot it against the printed figure.
Never the literal string `printed_total`.

**3. Notes-only** — `{base}_notes.csv` / `.xlsx`:

Tables where `section === 'notes'`, ordered by `noteRef` then page, each carrying its `noteRef`
and `title`. This is the financial-reports feature: pull the note tables and nothing else.

CSV writing **must** use `Papa.unparse(rows, { quotes: true })`. Quoting is never disabled.

XLSX export via SheetJS: one sheet per table, sheet name `p{page}_t{n}`, plus an `INDEX` sheet
listing every table with its title, note ref, page, confidence and warnings.

---

## Ingest registry — `ingest/index.js`

```js
register({
  id, label,
  accepts(file) -> boolean,          // by MIME and extension
  async extract(file, opts, onProgress) -> Doc
})

pickExtractor(file) -> extractor | null
```

`onProgress({ phase, current, total, message })` drives the UI. Every long task must be
cancellable via an `AbortSignal` passed in `opts.signal`.

---

## Scanned-page detection (get this right — the first build did not)

Boilerplate must be removed **before** measuring. `extract/boilerplate.js` finds text that repeats
at the same position across ≥40% of pages (running headers, footers, page numbers, download
stamps) and strips it.

```
TEXT_LAYER_MIN = 180   // chars of non-boilerplate body text
```

A page with fewer than that is `needsOcr: true`. On the 2011 GOIL report — where every page carries
a 109-character download stamp and nothing else — this must flag **all 44 pages**. Test against it.

A page may also be *partly* scanned (text prose, image table), as in the 2010 GOIL report. Where a
page has a text layer but a large image region with no text over it, offer region OCR on that
region.

---

## Tool registry — `tools/index.js`

```js
register({
  id, label, group, order,
  description,                       // one line, shown in the UI
  mount(container, ctx) -> void      // ctx: { store, bus, notify }
})
```

Groups, in display order: `clean` → `combine` → `convert` → `verify` → `annotate`.

Adding a tool means adding one file and registering it. No edits to shared files.

---

## Non-negotiables

- Files never leave the browser. Say so in the UI.
- Human preview and edit before any download.
- No build step. ES modules loaded directly; CDN libs pinned to exact versions.
- Every long operation shows progress and can be cancelled.
- Never emit a table without telling the user its confidence and warnings.
- Rectangularity invariant holds at every boundary.
