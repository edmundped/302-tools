/**
 * js/scraper/discover.js — find documents and tables on a page.
 *
 * v1 found `<a href>` ending in `.pdf` on one page and stopped. This finds
 * PDFs, spreadsheets, CSVs, Word documents and images; confirms what they
 * really are by HEADing them through the proxy and reading Content-Type;
 * reports Content-Length; converts every `<table>` (colspan and rowspan
 * expanded) into the shared Table model; and can optionally follow one level of
 * same-origin report-index links under a concurrency cap and a polite delay.
 *
 * Nothing here calls the extractor. A document is handed on as a File via
 * `bus.emit('ingest:files', [file])`, which is the ingest layer's contract.
 */
import {
  ScrapeError,
  ERROR_HELP,
  fetchHtml,
  fetchRobots,
  fetchAsFile,
  headInfo,
  isAllowed,
  sniffKind,
  isDocumentKind,
  formatBytes,
  filenameFromUrl,
  absoluteUrl,
  createLimiter,
  getProxyUrl
} from './fetchers.js';

export const USER_AGENT_TOKEN = '302-tools';

/* ------------------------------------------------------------------ *
 * Responsible use — surfaced in the UI, before the first fetch.
 *
 * This is enforced here rather than left to the panel: discover() refuses to
 * run until the notice has been acknowledged, so there is no code path that
 * fetches a third-party site without the user having seen it.
 * ------------------------------------------------------------------ */
export const RESPONSIBLE_USE = {
  title: 'Before you fetch anything',
  lines: [
    'Check the site\'s terms of use and its robots.txt. This tool reads robots.txt and will tell you if the page is disallowed.',
    'Only fetch public pages. Do not use this to get past a login, a paywall, or a rate limit.',
    'Requests are throttled and run at most two at a time. Leave it that way.',
    'One level of crawling is available and is off by default. Turn it on only for a report index you have a reason to read.',
    'The files you pull stay in this browser. Whether you may keep or republish them is between you and the site owner.'
  ],
  ack: 'I have checked the terms and robots.txt for this site.'
};

const ACK_KEY = 'scraperAcknowledgedAt';

export async function hasAcknowledged() {
  try {
    const mod = await import('../core/config.js').catch(() => null);
    if (mod && typeof mod.getConfig === 'function') return Boolean((mod.getConfig() || {})[ACK_KEY]);
  } catch {
    /* fall through */
  }
  try {
    return Boolean(JSON.parse(localStorage.getItem('302tools.config') || '{}')[ACK_KEY]);
  } catch {
    return false;
  }
}

export async function acknowledge() {
  const stamp = new Date().toISOString();
  try {
    const mod = await import('../core/config.js').catch(() => null);
    if (mod && typeof mod.setConfig === 'function') {
      mod.setConfig({ [ACK_KEY]: stamp });
      return stamp;
    }
  } catch {
    /* fall through */
  }
  try {
    const current = JSON.parse(localStorage.getItem('302tools.config') || '{}');
    localStorage.setItem('302tools.config', JSON.stringify({ ...current, [ACK_KEY]: stamp }));
  } catch {
    /* private mode */
  }
  return stamp;
}

/** Build the notice as DOM so any panel can drop it in above the URL field. */
export function renderResponsibleUse(container, onAcknowledge) {
  const wrap = document.createElement('div');
  wrap.className = 'notice scraper-responsible-use';
  const heading = document.createElement('strong');
  heading.textContent = RESPONSIBLE_USE.title;
  const list = document.createElement('ul');
  RESPONSIBLE_USE.lines.forEach((line) => {
    const item = document.createElement('li');
    item.textContent = line;
    list.appendChild(item);
  });
  const label = document.createElement('label');
  label.className = 'check-label';
  const box = document.createElement('input');
  box.type = 'checkbox';
  const text = document.createElement('span');
  text.textContent = RESPONSIBLE_USE.ack;
  label.append(box, text);
  box.addEventListener('change', async () => {
    if (!box.checked) return;
    const stamp = await acknowledge();
    if (typeof onAcknowledge === 'function') onAcknowledge(stamp);
  });
  hasAcknowledged().then((done) => {
    box.checked = done;
  });
  wrap.append(heading, list, label);
  container.appendChild(wrap);
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Link discovery  (pure, given plain objects)
 * ------------------------------------------------------------------ */

/**
 * Pure: turn anchor descriptors into candidate links.
 * @param anchors [{ href, text, title }]
 */
export function collectCandidates(anchors, baseUrl) {
  const seen = new Set();
  const out = [];
  anchors.forEach((anchor) => {
    const href = String(anchor.href || '').trim();
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;
    const url = absoluteUrl(href, baseUrl);
    if (!url) return;
    if (!/^https?:/i.test(url)) return;
    const key = url.split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    const sniffed = sniffKind(url, '');
    const label = String(anchor.text || '').replace(/\s+/g, ' ').trim() || filenameFromUrl(url, 'link');
    out.push({
      url: key,
      label,
      title: String(anchor.title || '').trim(),
      filename: filenameFromUrl(key, 'download'),
      kind: sniffed.kind,
      basis: sniffed.basis,
      mime: '',
      bytes: null,
      sizeLabel: '',
      status: null,
      confirmed: false
    });
  });
  return out;
}

const INDEX_WORDS =
  /(report|investor|financ|annual|interim|quarter|result|download|publication|media|disclosure|filing|archive|statement|document|presentation|circular)/i;

/** Pure: is this worth following when one-level crawl is on? */
export function looksLikeIndexLink(url, label, originUrl) {
  let target;
  let origin;
  try {
    target = new URL(url);
    origin = new URL(originUrl);
  } catch {
    return false;
  }
  if (target.origin !== origin.origin) return false;
  if (target.href.split('#')[0] === origin.href.split('#')[0]) return false;
  if (sniffKind(url, '').kind !== 'unknown' && sniffKind(url, '').kind !== 'html') return false;
  return INDEX_WORDS.test(target.pathname) || INDEX_WORDS.test(String(label || ''));
}

/**
 * Pure: candidates worth spending a HEAD request on. Extensionless links get
 * sniffed too — that is the whole point — but obvious navigation chrome does not.
 */
export function worthSniffing(candidate, pageUrl) {
  if (isDocumentKind(candidate.kind)) return true;
  if (candidate.kind === 'html') return false;
  if (candidate.kind !== 'unknown') return false;
  try {
    const url = new URL(candidate.url);
    if (/\/$/.test(url.pathname)) return false; // directory index, almost never a file
    if (url.pathname.split('/').filter(Boolean).length === 0) return false;
  } catch {
    return false;
  }
  return INDEX_WORDS.test(candidate.url) || INDEX_WORDS.test(candidate.label) || /download|file|attachment|asset|document/i.test(candidate.url);
}

/* ------------------------------------------------------------------ *
 * HTML tables -> the shared Table model
 * ------------------------------------------------------------------ */

/**
 * Pure: expand a cell matrix that carries colspan/rowspan into a rectangular
 * grid. The model's rectangularity invariant is hard, so spanned values are
 * repeated across every slot they cover rather than left as holes.
 *
 * @param cellRows [[{ text, colspan, rowspan, isHeader }]]
 * @returns { grid:string[][], spannedCells:number, headerRowCount:number }
 */
export function expandGrid(cellRows) {
  const filled = [];
  const taken = [];
  let spannedCells = 0;

  const ensureRow = (r) => {
    while (filled.length <= r) {
      filled.push([]);
      taken.push([]);
    }
  };

  cellRows.forEach((cells, r) => {
    ensureRow(r);
    let c = 0;
    cells.forEach((cell) => {
      while (taken[r][c]) c += 1;
      const colspan = Math.max(1, Number(cell.colspan) || 1);
      const rowspan = Math.max(1, Number(cell.rowspan) || 1);
      if (colspan > 1 || rowspan > 1) spannedCells += 1;
      const text = cell.text === undefined || cell.text === null ? '' : String(cell.text);
      for (let dr = 0; dr < rowspan; dr += 1) {
        ensureRow(r + dr);
        for (let dc = 0; dc < colspan; dc += 1) {
          taken[r + dr][c + dc] = true;
          filled[r + dr][c + dc] = text;
        }
      }
      c += colspan;
    });
  });

  const width = filled.reduce((max, row) => Math.max(max, row.length), 0);
  const grid = filled.map((row) => {
    const out = [];
    for (let c = 0; c < width; c += 1) out.push(row[c] === undefined ? '' : row[c]);
    return out;
  });

  let headerRowCount = 0;
  for (let r = 0; r < cellRows.length; r += 1) {
    if (cellRows[r].length && cellRows[r].every((cell) => cell.isHeader)) headerRowCount += 1;
    else break;
  }

  return { grid, spannedCells, headerRowCount };
}

/** DOM -> the cell matrix expandGrid() wants. */
export function readTableCells(tableEl) {
  const rows = Array.from(tableEl.rows || []);
  return rows.map((row) =>
    Array.from(row.cells || []).map((cell) => ({
      text: (cell.textContent || '').replace(/\s+/g, ' ').trim(),
      colspan: cell.colSpan || 1,
      rowspan: cell.rowSpan || 1,
      isHeader: cell.tagName === 'TH'
    }))
  );
}

function tableTitle(tableEl) {
  const caption = tableEl.querySelector('caption');
  if (caption && caption.textContent.trim()) return caption.textContent.replace(/\s+/g, ' ').trim();
  let node = tableEl.previousElementSibling;
  let hops = 0;
  while (node && hops < 4) {
    if (/^H[1-6]$/.test(node.tagName) || node.tagName === 'CAPTION') {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 160);
    }
    if (node.tagName === 'P' && node.querySelector('strong, b')) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text && text.length < 160) return text;
    }
    node = node.previousElementSibling;
    hops += 1;
  }
  return null;
}

/**
 * Convert one DOM table into a Table (core/model.js shape). Layout tables are
 * still returned, but with a low confidence and a warning, so the user decides.
 */
export function htmlTableToTable(tableEl, meta) {
  const info = meta || {};
  const cells = readTableCells(tableEl);
  const { grid, spannedCells, headerRowCount } = expandGrid(cells);

  const warnings = [];
  if (spannedCells) {
    warnings.push(`${spannedCells} merged cell(s) were expanded across the grid; the repeated values are deliberate.`);
  }
  if (tableEl.querySelector('table')) {
    warnings.push('This table contains another table. It is probably page layout, not data.');
  }
  if (tableEl.getAttribute('role') === 'presentation') {
    warnings.push('Marked role="presentation" — the site says this is layout, not data.');
  }

  const headerRows = headerRowCount ? grid.slice(0, headerRowCount) : [];
  const rows = headerRowCount ? grid.slice(headerRowCount) : grid;
  const columnCount = grid.length ? grid[0].length : 0;

  let confidence = 0.5;
  if (headerRowCount) confidence += 0.25;
  if (rows.length >= 2) confidence += 0.15;
  if (columnCount >= 2) confidence += 0.1;
  if (columnCount <= 1) confidence = 0.15;
  if (tableEl.querySelector('table') || tableEl.getAttribute('role') === 'presentation') confidence = 0.1;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    id: `${info.docId || 'html'}-p1-t${info.index || 1}`,
    docId: info.docId || 'html',
    sourceFile: info.sourceFile || info.pageUrl || 'page',
    page: 1,
    origin: 'html',
    title: tableTitle(tableEl),
    noteRef: null,
    section: null,
    units: null,
    headers: headerRows,
    rows,
    columnCount,
    confidence,
    warnings,
    bbox: null,
    selected: confidence >= 0.6,
    sourceUrl: info.pageUrl || null
  };
}

/** Validate through core/model.js when it is available; never fail because it is not. */
async function validateTables(tables) {
  try {
    const model = await import('../core/model.js');
    if (typeof model.validateTable === 'function') {
      tables.forEach((table) => {
        try {
          model.validateTable(table);
        } catch (err) {
          table.warnings.push(`Model validation: ${err.message}`);
        }
      });
    }
  } catch {
    /* model.js not present in this build */
  }
  return tables;
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

export const KIND_LABELS = {
  pdf: 'PDF',
  spreadsheet: 'Spreadsheet',
  csv: 'CSV / TSV',
  document: 'Word document',
  image: 'Image',
  archive: 'Archive',
  html: 'Web page',
  text: 'Plain text',
  unknown: 'Unidentified'
};

/** Pure: bucket the flat candidate list into display groups. */
export function groupByKind(candidates) {
  const order = ['pdf', 'spreadsheet', 'csv', 'document', 'image', 'archive', 'text', 'unknown'];
  const groups = new Map();
  candidates.forEach((candidate) => {
    if (!groups.has(candidate.kind)) groups.set(candidate.kind, []);
    groups.get(candidate.kind).push(candidate);
  });
  return order
    .filter((kind) => groups.has(kind))
    .map((kind) => ({ kind, label: KIND_LABELS[kind] || kind, items: groups.get(kind) }));
}

async function readPage(pageUrl, options, out, onProgress) {
  onProgress({ phase: 'fetch', message: `Fetching ${pageUrl}` });
  const { doc } = await fetchHtml(pageUrl, { signal: options.signal, timeoutMs: options.timeoutMs });

  const anchors = Array.from(doc.querySelectorAll('a[href]')).map((a) => ({
    href: a.getAttribute('href'),
    text: a.textContent,
    title: a.getAttribute('title')
  }));
  const candidates = collectCandidates(anchors, pageUrl).map((candidate) => ({ ...candidate, fromPage: pageUrl }));

  const tableEls = Array.from(doc.querySelectorAll('table'));
  const tables = tableEls.map((tableEl, index) =>
    htmlTableToTable(tableEl, {
      docId: `html-${out.pages.length + 1}`,
      index: index + 1,
      pageUrl,
      sourceFile: pageUrl
    })
  );

  out.pages.push({ url: pageUrl, ok: true, links: candidates.length, tables: tables.length });
  out.candidates.push(...candidates);
  out.tables.push(...tables);
  return { doc, candidates };
}

/**
 * Discover documents and tables.
 *
 * @param targetUrl string
 * @param options {
 *   signal, sniff = true, crawl = false, maxPages = 6, concurrency = 2,
 *   delayMs = 800, checkRobots = true, overrideRobots = false,
 *   acknowledged = false, timeoutMs
 * }
 * @param onProgress ({ phase, current, total, message }) => void
 */
export async function discover(targetUrl, options, onProgress) {
  const opts = {
    sniff: true,
    crawl: false,
    maxPages: 6,
    concurrency: 2,
    delayMs: 800,
    checkRobots: true,
    overrideRobots: false,
    acknowledged: false,
    ...(options || {})
  };
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  if (!absoluteUrl(targetUrl)) throw new ScrapeError('BAD_URL', ERROR_HELP.BAD_URL, targetUrl);

  const proxy = await getProxyUrl();
  if (!proxy) throw new ScrapeError('NO_PROXY', ERROR_HELP.NO_PROXY);

  if (!opts.acknowledged && !(await hasAcknowledged())) {
    throw new ScrapeError(
      'NEEDS_ACKNOWLEDGEMENT',
      'Read the responsible-use notice and tick the box before the first fetch.',
      RESPONSIBLE_USE
    );
  }

  const out = {
    pageUrl: targetUrl,
    pages: [],
    candidates: [],
    tables: [],
    warnings: [],
    robots: null,
    crawled: []
  };

  /* ---- robots.txt ------------------------------------------------ */
  if (opts.checkRobots) {
    progress({ phase: 'robots', message: 'Reading robots.txt' });
    const robots = await fetchRobots(targetUrl, { signal: opts.signal });
    out.robots = robots;
    if (robots.available && robots.groups) {
      const path = new URL(targetUrl).pathname;
      const verdict = isAllowed(robots.groups, path, USER_AGENT_TOKEN);
      out.robots.verdict = verdict;
      if (verdict.crawlDelay && verdict.crawlDelay * 1000 > opts.delayMs) {
        opts.delayMs = verdict.crawlDelay * 1000;
        out.warnings.push(`robots.txt asks for a ${verdict.crawlDelay}s crawl delay. Honouring it.`);
      }
      if (!verdict.allowed && !opts.overrideRobots) {
        throw new ScrapeError(
          'ROBOTS_DISALLOWED',
          `robots.txt disallows this path (${verdict.rule}). Stop here unless you have permission from the site owner.`,
          verdict
        );
      }
      if (!verdict.allowed) {
        out.warnings.push(`robots.txt disallows this path (${verdict.rule}) and you chose to continue anyway.`);
      }
    } else {
      out.warnings.push('robots.txt could not be read. Check the site terms yourself before going further.');
    }
  }

  /* ---- the page itself ------------------------------------------- */
  const first = await readPage(targetUrl, opts, out, progress);

  /* ---- optional one-level crawl ---------------------------------- */
  if (opts.crawl) {
    const followable = first.candidates
      .filter((candidate) => looksLikeIndexLink(candidate.url, candidate.label, targetUrl))
      .slice(0, Math.max(0, opts.maxPages - 1));

    if (!followable.length) out.warnings.push('Crawl was on, but no same-origin report-index links were found to follow.');

    const limit = createLimiter(opts.concurrency, opts.delayMs);
    let done = 0;
    await Promise.all(
      followable.map((candidate) =>
        limit(async () => {
          if (opts.signal && opts.signal.aborted) return;
          try {
            await readPage(candidate.url, opts, out, () => {});
            out.crawled.push({ url: candidate.url, ok: true });
          } catch (err) {
            out.pages.push({ url: candidate.url, ok: false, error: err.message });
            out.crawled.push({ url: candidate.url, ok: false, error: err.code || 'ERROR' });
          } finally {
            done += 1;
            progress({ phase: 'crawl', current: done, total: followable.length, message: `Followed ${done} of ${followable.length} index page(s)` });
          }
        })
      )
    );

    // Re-dedupe: two index pages usually link the same report.
    const seen = new Set();
    out.candidates = out.candidates.filter((candidate) => {
      if (seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    });
  }

  /* ---- content-type sniffing ------------------------------------- */
  if (opts.sniff) {
    const toSniff = out.candidates.filter((candidate) => worthSniffing(candidate, targetUrl));
    const limit = createLimiter(opts.concurrency, Math.max(200, Math.round(opts.delayMs / 2)));
    let done = 0;
    progress({ phase: 'sniff', current: 0, total: toSniff.length, message: `Checking ${toSniff.length} candidate link(s)` });

    await Promise.all(
      toSniff.map((candidate) =>
        limit(async () => {
          if (opts.signal && opts.signal.aborted) return;
          try {
            const info = await headInfo(candidate.url, { signal: opts.signal });
            candidate.status = info.status;
            candidate.mime = info.contentType;
            candidate.bytes = info.contentLength;
            candidate.sizeLabel = info.contentLength === null ? '' : formatBytes(info.contentLength);
            candidate.headMethod = info.method;
            if (info.method !== 'none') {
              candidate.kind = info.kind;
              candidate.basis = info.basis;
              candidate.confirmed = info.basis === 'content-type';
            } else if (info.error) {
              candidate.error = info.error.message;
            }
          } catch (err) {
            candidate.error = err.message;
          } finally {
            done += 1;
            progress({ phase: 'sniff', current: done, total: toSniff.length, message: `Checked ${done} of ${toSniff.length}` });
          }
        })
      )
    );

    const unsized = out.candidates.filter((c) => isDocumentKind(c.kind) && c.bytes === null).length;
    if (unsized) {
      out.warnings.push(`${unsized} document(s) did not report a Content-Length, so no size is shown for them.`);
    }
  }

  const documents = out.candidates.filter((candidate) => isDocumentKind(candidate.kind));
  await validateTables(out.tables);

  progress({ phase: 'done', message: `${documents.length} document(s), ${out.tables.length} table(s)` });

  return {
    pageUrl: out.pageUrl,
    pages: out.pages,
    crawled: out.crawled,
    robots: out.robots,
    documents,
    otherLinks: out.candidates.filter((candidate) => !isDocumentKind(candidate.kind)),
    groups: groupByKind(documents),
    tables: out.tables,
    warnings: out.warnings
  };
}

/* ------------------------------------------------------------------ *
 * Handing a discovered document to the ingest layer
 * ------------------------------------------------------------------ */

/**
 * Pull one discovered document through the proxy and hand it to ingest.
 * The extractor is never called from here; the bus event is the contract.
 */
export async function sendToExtractor(bus, candidate, options) {
  const file = await fetchAsFile(candidate.url, { fileName: candidate.filename, ...(options || {}) });
  if (!bus || typeof bus.emit !== 'function') {
    throw new ScrapeError('NO_BUS', 'No event bus was supplied, so the file cannot reach the extract panel.');
  }
  bus.emit('ingest:files', [file]);
  return file;
}

/** Same, for several at once, still throttled. */
export async function sendManyToExtractor(bus, candidates, options) {
  const opts = { concurrency: 2, delayMs: 600, ...(options || {}) };
  const limit = createLimiter(opts.concurrency, opts.delayMs);
  const files = [];
  const failures = [];
  await Promise.all(
    candidates.map((candidate) =>
      limit(async () => {
        try {
          files.push(await fetchAsFile(candidate.url, { fileName: candidate.filename, signal: opts.signal }));
        } catch (err) {
          failures.push({ url: candidate.url, message: err.message, code: err.code });
        }
      })
    )
  );
  if (files.length && bus && typeof bus.emit === 'function') bus.emit('ingest:files', files);
  return { files, failures };
}
