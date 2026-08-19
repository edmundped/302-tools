/**
 * ui/deps.js — the UI's edge against modules owned by the other agents.
 *
 * Every external contract (ingest registry, csv emitters, numbers, tool
 * registry, scraper, zip) is resolved lazily here. If a module is not on disk
 * yet, a clearly-flagged development stub is used instead so this UI runs and
 * can be reviewed standalone. Nothing here implements engine logic; the stubs
 * exist only so the shell is demonstrable before the engines land.
 *
 * `resolved.stubbed === true` is surfaced in the UI as a banner — the analyst
 * is never shown demo numbers without being told.
 */

/* --------------------------------------------------------------- loader  */

const cache = new Map();

async function load(path, fallbackFactory) {
  if (cache.has(path)) return cache.get(path);
  const promise = import(/* @vite-ignore */ path)
    .then((mod) => ({ mod, stubbed: false }))
    .catch((error) => {
      console.info(`[deps] ${path} not available yet — using UI stub.`, error?.message || '');
      return { mod: fallbackFactory(), stubbed: true };
    });
  cache.set(path, promise);
  return promise;
}

/* ------------------------------------------------------------- numbers   */
/* Fallback only. core/numbers.js is the single source of truth once it lands. */

function stubNumbers() {
  const CURRENCY = /(GH¢|GHS|USD|GBP|EUR|₵|\$|£|€)/gi;
  const FOOTNOTE = /[*†‡¹²³⁴⁵⁶⁰ⁿ]+$/;

  function parseNumber(raw) {
    const original = raw === null || raw === undefined ? '' : String(raw);
    const base = {
      value: null, isNegative: false, isPercent: false, hadParens: false,
      raw: original, clean: ''
    };
    let s = original.trim();
    if (!s) return base;
    // en/em dash alone means "not applicable" — empty, never zero
    if (/^[–—-]$/.test(s)) return base;

    let hadParens = false;
    let isNegative = false;
    let isPercent = false;

    s = s.replace(CURRENCY, '').trim();
    if (/^\(.*\)$/.test(s)) {
      hadParens = true;
      isNegative = true;
      s = s.slice(1, -1).trim();
    }
    if (s.endsWith('%')) {
      isPercent = true;
      s = s.slice(0, -1).trim();
    }
    s = s.replace(FOOTNOTE, '').trim();
    if (s.startsWith('−') || s.startsWith('–')) { isNegative = true; s = s.slice(1).trim(); }
    if (s.startsWith('-')) { isNegative = true; s = s.slice(1).trim(); }
    if (s.endsWith('-')) { isNegative = true; s = s.slice(0, -1).trim(); }

    // European 1.234,56 only when unambiguous
    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/[,\s ]/g, '');

    if (!/^\d*\.?\d+$/.test(s)) return { ...base, hadParens, isPercent };

    let value = Number(s);
    if (Number.isNaN(value)) return { ...base, hadParens, isPercent };
    if (isPercent) value /= 100;
    if (isNegative) value = -value;
    return {
      value, isNegative, isPercent, hadParens, raw: original, clean: String(value)
    };
  }

  return { parseNumber, __stub: true };
}

export async function numbers() {
  const { mod, stubbed } = await load('../core/numbers.js', stubNumbers);
  return { parseNumber: mod.parseNumber || stubNumbers().parseNumber, stubbed };
}

/** Synchronous-ish accessor used inside render loops; primed by primeNumbers(). */
let parseNumberSync = stubNumbers().parseNumber;
export function parseNumberNow(raw) {
  return parseNumberSync(raw);
}
export async function primeNumbers() {
  const { parseNumber } = await numbers();
  parseNumberSync = parseNumber;
  return parseNumber;
}

/* ---------------------------------------------------------------- csv    */

function stubCsv() {
  const unparse = (rows) =>
    typeof Papa !== 'undefined'
      ? Papa.unparse(rows, { quotes: true })
      : rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');

  const headerOf = (t) => (t.headers[0] || t.rows[0] || []).map((c, i) => c || `column_${i}`);

  return {
    __stub: true,
    toMachineCsv(tables) {
      const rows = [[
        'source_file', 'page', 'table_id', 'table_title', 'note_ref', 'section',
        'row_label', 'column', 'value', 'unit'
      ]];
      for (const t of tables) {
        const cols = headerOf(t);
        for (const row of t.rows) {
          for (let c = 1; c < t.columnCount; c += 1) {
            rows.push([
              t.sourceFile, t.page, t.id, t.title || '', t.noteRef || '', t.section || '',
              row[0] || '', cols[c] || `column_${c}`,
              parseNumberSync(row[c]).clean || row[c] || '', t.units || ''
            ]);
          }
        }
      }
      return [{ name: 'stub_data.csv', text: unparse(rows) }];
    },
    toAnalystCsv(tables) {
      return tables.map((t) => ({
        name: `stub_p${t.page}_t0_review.csv`,
        text: unparse([
          ['source_file', 'page', ...headerOf(t)],
          ...t.rows.map((r) => [t.sourceFile, t.page, ...r])
        ])
      }));
    },
    toNotesCsv(tables) {
      const notes = tables.filter((t) => t.section === 'notes');
      return [{ name: 'stub_notes.csv', text: unparse(notes.flatMap((t) => t.rows)) }];
    },
    toWorkbook(tables) {
      if (typeof XLSX === 'undefined') return null;
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['table_id', 'title', 'note_ref', 'page', 'confidence', 'warnings'],
          ...tables.map((t) => [t.id, t.title || '', t.noteRef || '', t.page, t.confidence, t.warnings.join('; ')])
        ]),
        'INDEX'
      );
      tables.forEach((t, i) => {
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.aoa_to_sheet([...t.headers, ...t.rows]),
          `p${t.page}_t${i}`.slice(0, 31)
        );
      });
      return wb;
    }
  };
}

export async function csv() {
  const { mod, stubbed } = await load('../core/csv.js', stubCsv);
  const fallback = stubCsv();
  return {
    stubbed,
    toMachineCsv: mod.toMachineCsv || fallback.toMachineCsv,
    toAnalystCsv: mod.toAnalystCsv || fallback.toAnalystCsv,
    toNotesCsv: mod.toNotesCsv || fallback.toNotesCsv,
    toWorkbook: mod.toWorkbook || fallback.toWorkbook
  };
}

/* ---------------------------------------------------------------- zip    */

export async function zipper() {
  const { mod, stubbed } = await load('../core/zip.js', () => ({
    __stub: true,
    async bundle(files, name = '302-tools_export.zip') {
      if (typeof JSZip === 'undefined') throw new Error('JSZip is not loaded.');
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.name, f.text ?? f.blob));
      const blob = await zip.generateAsync({ type: 'blob' });
      if (typeof saveAs === 'function') saveAs(blob, name);
      return blob;
    }
  }));
  return { bundle: mod.bundle || mod.default, stubbed };
}

/* ---------------------------------------------------------- tool registry */

export async function toolRegistry() {
  const { mod, stubbed } = await load('../tools/index.js', () => ({ registry: [], __stub: true }));
  // The registry keeps its tools in a Map and exposes them through getTools(),
  // so read that first and only fall back to a bare array export.
  let registry = [];
  if (typeof mod.getTools === 'function') registry = mod.getTools();
  else if (Array.isArray(mod.registry)) registry = mod.registry;
  else if (Array.isArray(mod.default)) registry = mod.default;
  return { registry: Array.isArray(registry) ? registry : [], stubbed };
}

/* --------------------------------------------------------------- scraper */

export async function scraper() {
  const { mod, stubbed } = await load('../scraper/discover.js', () => ({
    __stub: true,
    async discover() {
      throw new Error(
        'The scraper engine is not connected yet. discover() will arrive in js/scraper/discover.js.'
      );
    }
  }));
  return { discover: mod.discover || mod.default, stubbed };
}

/* ---------------------------------------------------------------- ingest */

let builtinsReady = null;

export async function ingest() {
  const { mod, stubbed } = await load('../ingest/index.js', () => ({
    __stub: true,
    pickExtractor: (file) => (demoExtractor.accepts(file) ? demoExtractor : null)
  }));

  // Extractors register themselves only when asked, so importing a single one
  // in a test never drags in pdf.js. Do it once, here, before the first pick.
  if (!stubbed && typeof mod.registerBuiltins === 'function') {
    if (!builtinsReady) {
      builtinsReady = mod.registerBuiltins().catch((err) => {
        builtinsReady = null;
        throw err;
      });
    }
    await builtinsReady;
  }

  return { pickExtractor: mod.pickExtractor || mod.default, stubbed };
}

/* ============================================================ demo engine */
/* Development stand-in only. Produces a Doc shaped exactly to the contract in
   docs/ARCHITECTURE.md so the preview, foot-check, crop and batch flows are
   reviewable before ingest/ lands. Every Doc it makes is warned about in the UI. */

const DEMO_ROWS = [
  ['Property, plant and equipment', '128,441', '112,908'],
  ['Intangible assets', '4,120', '3,884'],
  ['Investment in associates', '–', '2,250'],
  ['Deferred tax asset', '9,318', '8,002'],
  ['Total non-current assets', '141,879', '127,044'],
  ['Inventories', '62,504', '55,110'],
  ['Trade and other receivables', '148,220', '131,776'],
  ['Cash and bank balances', '31,097', '44,913'],
  ['Total current assets', '241,821', '231,799'],
  ['Total assets', '383,700', '358,843']
];

const DEMO_NOTE_ROWS = [
  ['Salaries and wages', '18,442', '16,201'],
  ['Social security contributions', '2,214', '1,944'],
  ['Provident fund', '1,102', '0,970'],
  ['Other staff costs', '3,881', '3,220'],
  ['Total staff costs', '25,639', '22,335']
];

function drawDemoPage(title, rows, { width = 600, height = 848 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#9aa2ae';
  ctx.font = '11px monospace';
  ctx.fillText('302 Analytics · Downloaded: 2026-08-18 17:45:28 GMT', 40, 34);
  ctx.fillStyle = '#1d3756';
  ctx.font = 'bold 17px sans-serif';
  ctx.fillText(title, 40, 96);
  ctx.strokeStyle = '#d4b784';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(40, 108);
  ctx.lineTo(width - 40, 108);
  ctx.stroke();

  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#5a6270';
  ctx.fillText('GH¢000', width - 200, 138);
  ctx.fillStyle = '#192435';
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText('2011', width - 150, 160);
  ctx.fillText('2010', width - 80, 160);
  ctx.font = '12px sans-serif';

  let y = 186;
  for (const row of rows) {
    const isTotal = /^total/i.test(row[0]);
    ctx.font = isTotal ? 'bold 12px sans-serif' : '12px sans-serif';
    ctx.fillStyle = '#192435';
    ctx.fillText(row[0], 44, y);
    ctx.textAlign = 'right';
    ctx.fillText(row[1], width - 106, y);
    ctx.fillText(row[2], width - 36, y);
    ctx.textAlign = 'left';
    if (isTotal) {
      ctx.strokeStyle = '#c9c2b6';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(width - 210, y + 6);
      ctx.lineTo(width - 36, y + 6);
      ctx.stroke();
    }
    y += 26;
  }
  return { url: canvas.toDataURL('image/png'), width, height, tableBottom: y };
}

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

export const demoExtractor = {
  id: 'demo',
  label: 'Demo extractor (UI stub)',
  accepts: () => true,
  async extract(file, opts = {}, onProgress = () => {}) {
    const signal = opts.signal;
    const docId = `demo-${Math.random().toString(36).slice(2, 8)}`;
    const pageCount = 6;

    const statement = drawDemoPage('Statement of Financial Position', DEMO_ROWS);
    const note = drawDemoPage('Note 8 — Staff costs', DEMO_NOTE_ROWS);

    const pages = [];
    for (let n = 1; n <= pageCount; n += 1) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      onProgress({
        phase: 'read',
        current: n,
        total: pageCount,
        message: `Reading page ${n} of ${pageCount}`
      });
      await wait(120, signal);
      const scanned = n === 3 || n === 5;
      pages.push({
        number: n,
        textChars: scanned ? 109 : 1240,
        hasTextLayer: !scanned,
        needsOcr: scanned,
        ocrApplied: false,
        section: n <= 2 ? 'statements' : n >= 4 ? 'notes' : 'other',
        thumbnail: n === 1 ? statement.url : n === 4 ? note.url : null,
        width: statement.width,
        height: statement.height
      });
    }

    onProgress({ phase: 'tables', current: pageCount, total: pageCount, message: 'Assembling tables' });
    await wait(160, signal);

    const tables = [
      {
        id: `${docId}-p1-t0`,
        docId,
        sourceFile: file.name,
        page: 1,
        origin: 'pdf-text',
        title: 'Statement of Financial Position',
        noteRef: null,
        section: 'statements',
        units: 'GH¢000',
        headers: [['', '2011', '2010']],
        rows: DEMO_ROWS.map((r) => [...r]),
        columnCount: 3,
        confidence: 0.88,
        warnings: [],
        bbox: { x: 34, y: 120, w: statement.width - 68, h: statement.tableBottom - 108 },
        selected: true
      },
      {
        id: `${docId}-p4-t0`,
        docId,
        sourceFile: file.name,
        page: 4,
        origin: 'pdf-text',
        title: 'Staff costs',
        noteRef: '8',
        section: 'notes',
        units: 'GH¢000',
        headers: [['', '2011', '2010']],
        rows: DEMO_NOTE_ROWS.map((r) => [...r]),
        columnCount: 3,
        confidence: 0.74,
        warnings: ['One value carried a footnote marker; the marker was stripped.'],
        bbox: { x: 34, y: 120, w: note.width - 68, h: note.tableBottom - 108 },
        selected: true
      },
      {
        id: `${docId}-p6-t0`,
        docId,
        sourceFile: file.name,
        page: 6,
        origin: 'pdf-text',
        title: null,
        noteRef: null,
        section: 'other',
        units: null,
        headers: [],
        rows: [
          ['The directors present their report', 'together with the audited', ''],
          ['financial statements for the year', 'ended 31 December 2011.', '']
        ],
        columnCount: 3,
        confidence: 0.31,
        warnings: [
          'This looks like prose rather than a table — check before keeping it.',
          'No header row was detected.'
        ],
        bbox: null,
        selected: false
      }
    ];

    onProgress({ phase: 'done', current: pageCount, total: pageCount, message: 'Finished' });

    return {
      id: docId,
      fileName: file.name,
      fileType: 'pdf',
      pageCount,
      pages,
      tables,
      meta: {
        title: 'Annual Report 2011 (demo data)',
        company: 'Sample PLC',
        periodLabel: 'Year ended 31 December 2011',
        currency: 'GHS',
        unitsScale: 'thousands'
      },
      warnings: [
        'Demo data: the extraction engine is not connected yet, so these figures are illustrative.',
        '2 of 6 pages have no usable text layer and need OCR.'
      ],
      bboxOrigin: 'top-left'
    };
  }
};
