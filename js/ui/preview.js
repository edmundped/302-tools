/**
 * ui/preview.js — the verification surface.
 *
 * This is where the analyst decides whether a table is true. It holds the five
 * house rules:
 *
 *   "Say the columns"  — declared columns appear as a mapping row over the grid
 *   "Always check"     — foot-checks are computed live under every table
 *   "Note the source"  — provenance sits on every card and travels to export
 *   "Don't retype"     — every cell and header is editable in place
 *   "One, then many"   — the card the analyst tunes becomes the batch template
 *
 * Nothing here parses numbers itself: parsing comes from core/numbers.js
 * through ui/deps.js.
 */

import { h, clear, badge, emptyState, esc } from './shell.js';
import { bus, EVENTS } from '../core/bus.js';
import { LIMITS, BBOX_ORIGIN } from '../core/config.js';
import { parseNumberNow } from './deps.js';

const TOTAL_RE = /^\s*(total|sub-?total|net\s|gross\s|balance\s+(at|as)\b|closing\b|profit\s+for\b)/i;
const NIL_RE = /^\s*[–—-]\s*$/;

const ORIGIN_LABEL = {
  'pdf-text': ['Text layer', 'ok'],
  'pdf-ocr': ['OCR', 'warn'],
  xlsx: ['Spreadsheet', 'navy'],
  docx: ['Word', 'navy'],
  image: ['OCR (image)', 'warn'],
  html: ['HTML table', 'navy']
};

const isTotalRow = (row) => TOTAL_RE.test(row?.[0] || '');

/* ------------------------------------------------------------ foot-check  */

/**
 * Compute a foot-check per total row per numeric column.
 * Blocks of ordinary rows sum into the next total row; where a total row
 * directly follows another total row (a grand total), the pending subtotals
 * are summed instead. Returns [] when there is nothing checkable.
 */
export function footCheck(table) {
  const checks = [];
  const numericCols = [];
  for (let c = 1; c < table.columnCount; c += 1) {
    const numeric = table.rows.filter((r) => parseNumberNow(r[c]).value !== null).length;
    if (numeric >= 2) numericCols.push(c);
  }
  if (!numericCols.length) return checks;

  for (const col of numericCols) {
    let block = [];
    let pending = [];
    for (let r = 0; r < table.rows.length; r += 1) {
      const row = table.rows[r];
      const parsed = parseNumberNow(row[col]);
      if (!isTotalRow(row)) {
        if (parsed.value !== null) block.push(parsed.value);
        continue;
      }
      if (parsed.value === null) continue;
      let computed = null;
      if (block.length) {
        computed = block.reduce((a, b) => a + b, 0);
        pending.push(parsed.value);
      } else if (pending.length) {
        computed = pending.reduce((a, b) => a + b, 0);
        pending = [parsed.value];
      }
      block = [];
      if (computed === null) continue;
      const delta = Math.round((parsed.value - computed) * 1000) / 1000;
      checks.push({
        rowIndex: r,
        column: col,
        label: row[0] || `Row ${r + 1}`,
        columnLabel: (table.headers[0]?.[col] || `column_${col}`).trim() || `column_${col}`,
        printed: parsed.value,
        computed: Math.round(computed * 1000) / 1000,
        delta,
        ok: Math.abs(delta) <= LIMITS.FOOT_TOLERANCE
      });
    }
  }
  return checks;
}

const fmt = (n) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '—'
    : Number(n).toLocaleString('en-GB', { maximumFractionDigits: 3 });

/* --------------------------------------------------------------- crop     */

function renderCrop(container, doc, table) {
  clear(container);
  const page = doc.pages.find((p) => p.number === table.page);
  const thumb = page?.thumbnail;

  if (!thumb || !table.bbox) {
    container.append(
      h(
        'p',
        { class: 'crop-missing' },
        !thumb
          ? `No page image for page ${table.page}. The crop appears once the page has been rasterised.`
          : `This table has no bounding box, so it cannot be located on page ${table.page}.`
      )
    );
    return;
  }

  const canvas = h('canvas', { role: 'img', 'aria-label': `Source crop, page ${table.page}` });
  container.append(canvas);

  const image = new Image();
  image.onload = () => {
    const pw = page.width || image.naturalWidth;
    const ph = page.height || image.naturalHeight;
    const origin = doc.bboxOrigin || BBOX_ORIGIN;
    let { x, y, w, h: bh } = table.bbox;

    // normalised bbox (0..1) support
    if (w <= 1 && bh <= 1 && x <= 1 && y <= 1) {
      x *= pw; y *= ph; w *= pw; bh *= ph;
    }
    if (origin === 'bottom-left') y = ph - y - bh;

    const scaleX = image.naturalWidth / pw;
    const scaleY = image.naturalHeight / ph;
    const sx = Math.max(0, x * scaleX);
    const sy = Math.max(0, y * scaleY);
    const sw = Math.min(image.naturalWidth - sx, Math.max(8, w * scaleX));
    const sh = Math.min(image.naturalHeight - sy, Math.max(8, bh * scaleY));

    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  };
  image.onerror = () => {
    clear(container);
    container.append(h('p', { class: 'crop-missing' }, 'The page image could not be drawn.'));
  };
  image.src = thumb;
}

/* ------------------------------------------------------------ the grid    */

function buildGrid(store, doc, table, onStructural) {
  const declared = store.settings.extract.expectedColumns || [];
  const density = store.settings.preview.density;
  const grid = h('table', { class: 'grid', dataset: { density } });
  const thead = h('thead');
  const tbody = h('tbody');

  const cellRefs = [];

  function editable(text, { onCommit, className, ariaLabel }) {
    const span = h('span', {
      class: `cell-edit${className ? ` ${className}` : ''}`,
      contentEditable: 'true',
      spellcheck: 'false',
      role: 'textbox',
      'aria-label': ariaLabel,
      tabindex: '0'
    });
    span.textContent = text ?? '';
    let original = span.textContent;

    span.addEventListener('focus', () => {
      original = span.textContent;
    });
    span.addEventListener('blur', () => {
      const next = span.textContent.replace(/\s+$/g, '');
      if (next !== original) {
        span.classList.add('is-dirty');
        onCommit(next);
      }
    });
    span.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        span.blur();
        moveFocus(span, 1, 0);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        span.textContent = original;
        span.blur();
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.altKey) {
        event.preventDefault();
        span.blur();
        moveFocus(span, event.key === 'ArrowDown' ? 1 : -1, 0);
      }
    });
    return span;
  }

  function moveFocus(from, dRow, dCol) {
    const r = Number(from.dataset.r);
    const c = Number(from.dataset.c);
    if (Number.isNaN(r) || Number.isNaN(c)) return;
    const target = cellRefs[r + dRow]?.[c + dCol];
    if (target) {
      target.focus();
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /* ---- header rows */
  const headerRows = table.headers.length ? table.headers : [];
  if (headerRows.length) {
    headerRows.forEach((headerRow, hIndex) => {
      const tr = h('tr');
      tr.append(
        h(
          'th',
          { class: 'gutter', scope: 'col', style: hIndex ? { position: 'static' } : null },
          hIndex === 0 ? 'hdr' : ''
        )
      );
      for (let c = 0; c < table.columnCount; c += 1) {
        const cellText = headerRow[c] ?? '';
        const th = h('th', {
          scope: 'col',
          style: hIndex ? { position: 'static' } : null
        });
        const wrap = h('div', { class: 'colhead' });
        wrap.append(
          editable(cellText, {
            ariaLabel: `Header ${c + 1}`,
            onCommit: (value) => store.setHeaderCell(table.id, hIndex, c, value)
          })
        );
        if (hIndex === 0) {
          wrap.append(
            h(
              'button',
              {
                class: 'col-kill',
                type: 'button',
                title: `Delete column ${c + 1}`,
                'aria-label': `Delete column ${c + 1}`,
                onclick: () => {
                  store.deleteColumn(table.id, c);
                  onStructural();
                }
              },
              '✕'
            )
          );
        }
        th.append(wrap);
        tr.append(th);
      }
      thead.append(tr);
    });
  } else {
    const tr = h('tr');
    tr.append(h('th', { class: 'gutter', scope: 'col' }, 'hdr'));
    for (let c = 0; c < table.columnCount; c += 1) {
      tr.append(
        h(
          'th',
          { scope: 'col' },
          h(
            'div',
            { class: 'colhead' },
            h('span', { style: { opacity: '0.7', fontStyle: 'italic' } }, `column_${c}`),
            h(
              'button',
              {
                class: 'col-kill',
                type: 'button',
                'aria-label': `Delete column ${c + 1}`,
                onclick: () => {
                  store.deleteColumn(table.id, c);
                  onStructural();
                }
              },
              '✕'
            )
          )
        )
      );
    }
    thead.append(tr);
  }

  /* ---- declared-column mapping row ("say the columns") */
  if (declared.length) {
    const tr = h('tr', { class: 'maprow' });
    tr.append(h('th', { class: 'gutter', scope: 'col' }, 'map'));
    const map = Array.isArray(table.columnMap) ? table.columnMap : new Array(table.columnCount).fill(null);
    for (let c = 0; c < table.columnCount; c += 1) {
      const select = h(
        'select',
        {
          class: 'select select--sm',
          'aria-label': `Map column ${c + 1} to a declared column`,
          onchange: (event) => {
            const next = Array.isArray(table.columnMap)
              ? [...table.columnMap]
              : new Array(table.columnCount).fill(null);
            next[c] = event.target.value || null;
            store.setColumnMap(table.id, next);
          }
        },
        h('option', { value: '' }, '— unmapped —'),
        ...declared.map((name) =>
          h('option', { value: name, selected: map[c] === name }, name)
        )
      );
      tr.append(h('th', { scope: 'col' }, select));
    }
    thead.append(tr);
  }

  /* ---- body */
  const limit = Math.min(table.rows.length, LIMITS.PREVIEW_MAX_ROWS);
  for (let r = 0; r < limit; r += 1) {
    const row = table.rows[r];
    const tr = h('tr', { class: isTotalRow(row) ? 'row-total' : null });
    cellRefs[r] = [];

    tr.append(
      h(
        'td',
        { class: 'gutter' },
        h('span', null, String(r + 1)),
        ' ',
        h(
          'button',
          {
            class: 'row-kill',
            type: 'button',
            title: 'Use this row as the header',
            'aria-label': `Use row ${r + 1} as the header row`,
            onclick: () => {
              store.promoteRowToHeader(table.id, r);
              onStructural();
            }
          },
          '⇧'
        ),
        h(
          'button',
          {
            class: 'row-kill',
            type: 'button',
            title: 'Delete this row',
            'aria-label': `Delete row ${r + 1}`,
            onclick: () => {
              store.deleteRow(table.id, r);
              onStructural();
            }
          },
          '✕'
        )
      )
    );

    for (let c = 0; c < table.columnCount; c += 1) {
      const raw = row[c] ?? '';
      const parsed = parseNumberNow(raw);
      const classes = [];
      if (parsed.value !== null) classes.push('cell-num');
      if (NIL_RE.test(raw)) classes.push('cell-nil');
      const span = editable(raw, {
        className: classes.join(' '),
        ariaLabel: `Row ${r + 1}, column ${c + 1}`,
        onCommit: (value) => {
          store.setCell(table.id, r, c, value);
          const next = parseNumberNow(value);
          span.classList.toggle('cell-num', next.value !== null);
          span.classList.toggle('cell-nil', NIL_RE.test(value));
        }
      });
      span.dataset.r = String(r);
      span.dataset.c = String(c);
      cellRefs[r][c] = span;
      tr.append(h('td', { class: classes.includes('cell-num') ? 'cell-num' : null }, span));
    }
    tbody.append(tr);
  }

  grid.append(thead, tbody);

  const scroll = h('div', { class: 'grid-scroll', tabindex: '0', role: 'region', 'aria-label': `Table on page ${table.page}` }, grid);

  const wrap = h('div', { class: 'stack stack-sm' }, scroll);
  if (table.rows.length > limit) {
    wrap.append(
      h(
        'p',
        { class: 'field-hint' },
        `Showing the first ${limit} of ${table.rows.length} rows. All rows are exported.`
      )
    );
  }
  return wrap;
}

/* ---------------------------------------------------------- foot-check UI */

function buildFootCheck(table) {
  const checks = footCheck(table);
  const failing = checks.filter((c) => !c.ok).length;

  const box = h('section', { class: 'footcheck' });
  box.append(
    h(
      'div',
      { class: 'footcheck-head' },
      h('span', null, 'Foot check'),
      checks.length
        ? badge(
            failing ? `${failing} of ${checks.length} off` : `${checks.length} checked`,
            failing ? 'danger' : 'ok'
          )
        : badge('nothing to check', 'outline'),
      h('span', { class: 'push' }),
      h('span', { class: 'field-hint' }, 'printed vs computed, from the cells above')
    )
  );

  if (!checks.length) {
    box.append(
      h(
        'p',
        { class: 'crop-missing' },
        'No total rows were recognised in this table, so nothing could be footed. Rename a row label to start with "Total" to check it.'
      )
    );
    return box;
  }

  const list = h('dl', { class: 'footcheck-list' });
  for (const check of checks) {
    list.append(
      h(
        'div',
        { class: 'footcheck-item', dataset: { result: check.ok ? 'ok' : 'off' } },
        h('dt', { title: `${check.label} · ${check.columnLabel}` }, `${check.label} · ${check.columnLabel}`),
        h('dd', { title: 'printed on the page' }, fmt(check.printed)),
        h('dd', { title: 'computed from the rows above' }, fmt(check.computed)),
        h('dd', { class: 'delta', title: 'printed − computed' }, check.delta === 0 ? '0' : fmt(check.delta)),
        badge(check.ok ? 'foots' : 'off', check.ok ? 'ok' : 'danger')
      )
    );
  }
  box.append(list);
  return box;
}

/* --------------------------------------------------------- the table card */

function buildTableCard(ctx, doc, table, rebuild) {
  const { store } = ctx;
  const [originLabel, originTone] = ORIGIN_LABEL[table.origin] || [table.origin, 'outline'];
  const level = table.confidence >= 0.75 ? 'high' : table.confidence >= LIMITS.LOW_CONFIDENCE ? 'mid' : 'low';

  const card = h('article', {
    class: 'table-card',
    dataset: { selected: String(table.selected), tableId: table.id }
  });

  /* -- head */
  const checkbox = h('input', {
    type: 'checkbox',
    checked: table.selected,
    'aria-label': `Include this table in exports`,
    onchange: (event) => {
      store.toggleTable(table.id, event.target.checked);
      card.dataset.selected = String(event.target.checked);
    }
  });

  const title = h('div', {
    class: 'table-title',
    contentEditable: 'true',
    spellcheck: 'false',
    role: 'textbox',
    'aria-label': 'Table title',
    'data-placeholder': 'Untitled table — name it',
    dataset: { empty: String(!table.title) },
    onblur: (event) => {
      const value = event.target.textContent.trim();
      store.setTableMeta(table.id, { title: value || null });
      event.target.dataset.empty = String(!value);
    },
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.target.blur();
      }
    }
  });
  title.textContent = table.title || '';

  const meter = h(
    'span',
    { class: 'meter', dataset: { level }, title: 'Extraction confidence' },
    h('span', { class: 'meter-track' }, h('span', {
      class: 'meter-fill',
      style: { width: `${Math.round(table.confidence * 100)}%` }
    })),
    `${Math.round(table.confidence * 100)}%`
  );

  const tools = h(
    'div',
    { class: 'table-card-tools' },
    table.headers.length
      ? h(
          'button',
          {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            title: 'Push the header row back into the table body',
            onclick: () => {
              store.demoteHeader(table.id);
              rebuild();
            }
          },
          'Header → row'
        )
      : h('span', { class: 'badge badge--warn' }, 'no header row'),
    h(
      'button',
      {
        class: 'btn btn--secondary btn--sm',
        type: 'button',
        onclick: () => ctx.onDownload?.(table, 'analyst')
      },
      'Review CSV'
    ),
    h(
      'button',
      {
        class: 'btn btn--secondary btn--sm',
        type: 'button',
        onclick: () => ctx.onDownload?.(table, 'machine')
      },
      'Data CSV'
    ),
    ctx.onTemplate
      ? h(
          'button',
          {
            class: 'btn btn--gold btn--sm',
            type: 'button',
            title: 'Use this table\'s treatment as the template for the rest of the batch',
            onclick: () => ctx.onTemplate(table, doc)
          },
          'Use as template'
        )
      : null
  );

  card.append(
    h(
      'header',
      { class: 'table-card-head' },
      h('label', { class: 'check', style: { paddingTop: '2px' } }, checkbox, h('span', { class: 'visually-hidden' }, 'Include')),
      h(
        'div',
        { class: 'table-ident' },
        title,
        h(
          'div',
          { class: 'table-tags' },
          badge(`page ${table.page}`, 'navy'),
          badge(originLabel, originTone),
          table.noteRef ? badge(`note ${table.noteRef}`, 'gold') : null,
          table.section ? badge(table.section, 'outline') : null,
          table.units ? badge(table.units, 'outline') : null,
          badge(`${table.rows.length}×${table.columnCount}`, 'outline'),
          meter
        )
      ),
      tools
    )
  );

  /* -- warnings */
  if (table.warnings.length || table.confidence < LIMITS.LOW_CONFIDENCE) {
    const box = h('div', { class: 'table-warnings' });
    if (table.confidence < LIMITS.LOW_CONFIDENCE) {
      box.append(
        h('p', null, `Low confidence (${Math.round(table.confidence * 100)}%). This may be prose rather than a table — read it before keeping it.`)
      );
    }
    table.warnings.forEach((w) => box.append(h('p', null, w)));
    card.append(box);
  }

  /* -- body: grid + crop */
  const showCrop = store.settings.preview.showCrop;
  const body = h('div', { class: 'table-body', dataset: { crop: showCrop ? 'on' : 'off' } });
  const gridCol = h('div', { class: 'table-grid-col' });
  gridCol.append(buildGrid(store, doc, table, rebuild));

  const footHost = h('div');
  if (store.settings.preview.showFootCheck) footHost.append(buildFootCheck(table));
  gridCol.append(footHost);
  body.append(gridCol);

  if (showCrop) {
    const frame = h('div', { class: 'crop-frame' });
    const crop = h(
      'aside',
      { class: 'crop' },
      h('p', { class: 'eyebrow' }, 'source page'),
      frame,
      h(
        'p',
        { class: 'crop-caption' },
        `${table.sourceFile} · page ${table.page}`
      )
    );
    renderCrop(frame, doc, table);
    body.append(crop);
  }
  card.append(body);

  /* -- provenance ("note the source") */
  card.append(
    h(
      'footer',
      { class: 'provenance' },
      h('span', null, h('b', null, 'file '), table.sourceFile),
      h('span', null, h('b', null, 'page '), String(table.page)),
      h('span', null, h('b', null, 'method '), originLabel),
      h('span', null, h('b', null, 'confidence '), `${Math.round(table.confidence * 100)}%`),
      h('span', null, h('b', null, 'pulled '), new Date(table.extractedAt).toLocaleString('en-GB')),
      h('span', null, h('b', null, 'id '), table.id)
    )
  );

  card.refreshChecks = () => {
    if (!store.settings.preview.showFootCheck) return;
    clear(footHost).append(buildFootCheck(table));
  };

  return card;
}

/* ---------------------------------------------------------- doc block     */

function buildDocBlock(ctx, doc, cards) {
  const { store } = ctx;
  const scanned = doc.pages.filter((p) => p.needsOcr && !p.ocrApplied);
  const ocrDone = doc.pages.filter((p) => p.ocrApplied);

  const block = h('section', { class: 'doc-block', dataset: { docId: doc.id } });

  block.append(
    h(
      'div',
      { class: 'doc-head' },
      h('h2', { title: doc.fileName }, doc.fileName),
      h(
        'div',
        { class: 'doc-stats' },
        badge(`${doc.pageCount} pages`, 'outline'),
        badge(`${doc.tables.length} tables`, doc.tables.length ? 'navy' : 'outline'),
        ocrDone.length ? badge(`${ocrDone.length} OCR'd`, 'warn') : null,
        scanned.length ? badge(`${scanned.length} need OCR`, 'danger') : badge('text layer', 'ok'),
        doc.meta?.currency ? badge(doc.meta.currency, 'outline') : null
      ),
      h(
        'div',
        { class: 'row row-tight push' },
        h(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: () => store.setDocSelection(doc.id, true)
          },
          'Select all'
        ),
        h(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: () => store.setDocSelection(doc.id, false)
          },
          'Select none'
        ),
        h(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            'aria-label': `Remove ${doc.fileName}`,
            onclick: () => store.removeDoc(doc.id)
          },
          'Remove'
        )
      )
    )
  );

  if (doc.warnings.length) {
    block.append(
      h(
        'div',
        { class: 'notice notice--warn' },
        h('div', null, ...doc.warnings.map((w) => h('p', null, w)))
      )
    );
  }

  if (scanned.length) {
    block.append(
      h(
        'div',
        { class: 'notice notice--gold' },
        h(
          'div',
          { style: { flex: '1 1 auto' } },
          h('strong', null, `${scanned.length} page${scanned.length === 1 ? '' : 's'} in this file are scanned.`),
          h(
            'p',
            null,
            `Page${scanned.length === 1 ? '' : 's'} ${scanned.slice(0, 12).map((p) => p.number).join(', ')}${scanned.length > 12 ? '…' : ''} carry no usable text layer, so the numbers on them are pixels. Nothing was extracted from them.`
          )
        ),
        ctx.onOcr
          ? h(
              'button',
              {
                class: 'btn btn--gold btn--sm',
                type: 'button',
                onclick: () => ctx.onOcr(doc, scanned)
              },
              `Run OCR on ${scanned.length} page${scanned.length === 1 ? '' : 's'}`
            )
          : null
      )
    );
  }

  if (!doc.tables.length) {
    block.append(
      emptyState({
        mark: '∅',
        title: 'No tables found in this file',
        body: scanned.length
          ? 'Every page that might hold a table is scanned. Run OCR above to read them.'
          : 'The text layer was readable but nothing in it looked like a table. Check the file, or try OCR if the tables are images.'
      })
    );
    return block;
  }

  const list = h('div', { class: 'stack' });
  for (const table of doc.tables) {
    const rebuild = () => {
      const fresh = buildTableCard(ctx, doc, table, rebuild);
      fresh.refreshChecks = fresh.refreshChecks;
      cards.get(table.id)?.replaceWith(fresh);
      cards.set(table.id, fresh);
    };
    const card = buildTableCard(ctx, doc, table, rebuild);
    cards.set(table.id, card);
    list.append(card);
  }
  block.append(list);
  return block;
}

/* ================================================================= public */

/**
 * @param {{store:object, onDownload?:Function, onTemplate?:Function, onOcr?:Function}} ctx
 */
export function createPreview(ctx) {
  const { store } = ctx;
  const el = h('div', { class: 'stack stack-lg' });
  /** @type {Map<string, HTMLElement>} */
  const cards = new Map();

  function render() {
    clear(el);
    cards.clear();
    const docs = store.state.docs;
    if (!docs.length) {
      el.append(
        emptyState({
          mark: '⌷',
          title: 'Nothing to review yet',
          body:
            'Add a file on the left. Detected tables appear here with the page they came from, so you can check every figure against the source before anything leaves the browser.'
        })
      );
      return;
    }
    for (const doc of docs) el.append(buildDocBlock(ctx, doc, cards));
  }

  const structural = new Set([
    'delete-row', 'delete-column', 'promote-header', 'demote-header', 'insert-row', 'column-map'
  ]);

  const offDocs = bus.on(EVENTS.DOCS_CHANGED, render);
  const offTable = bus.on(EVENTS.TABLE_CHANGED, ({ table, reason }) => {
    const card = cards.get(table.id);
    if (!card) return;
    if (reason === 'selection') {
      card.dataset.selected = String(table.selected);
      return;
    }
    if (structural.has(reason)) return; // the caller rebuilt the card already
    card.refreshChecks?.();
  });
  // Only the settings that change what the preview *shows* force a re-render;
  // toggling an output format must not throw away the analyst's scroll position.
  const offOpts = bus.on(EVENTS.EXTRACT_OPTS, render);
  const offPrefs = bus.on('preview:prefs', render);

  render();

  return {
    el,
    render,
    destroy() {
      offDocs();
      offTable();
      offOpts();
      offPrefs();
    }
  };
}

export { esc };
