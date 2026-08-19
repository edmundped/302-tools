/**
 * js/tools/_shared.js
 *
 * Shared plumbing for the tool modules. This is NOT a tool and is not registered.
 * It exists so that every tool gets the same contract for free:
 *
 *   - paste-in OR file-in (and, when the session has them, a table already in the store)
 *   - live preview that re-runs as inputs change
 *   - copy-to-clipboard and download for every result
 *   - an explicit "what changed" report; no tool ever mutates input silently
 *
 * Pure grid helpers are exported separately so `test/tools-check.mjs` can exercise
 * them under Node without a DOM.
 */

export const MAX_PREVIEW_ROWS = 80;
export const MAX_PREVIEW_COLS = 40;

/* ------------------------------------------------------------------ *
 * Number engine bridge
 *
 * `core/numbers.js` is owned by the extraction agent. It is imported lazily
 * (rather than statically) for two reasons: tool modules stay importable under
 * Node for the pure-logic tests, and a build where the engine has not landed
 * yet fails with a readable message instead of a blank panel.
 *
 * There is exactly ONE reference to the number parser in this whole layer.
 * ------------------------------------------------------------------ */
let numbersPromise = null;
export function requireNumbers() {
  if (!numbersPromise) {
    numbersPromise = import('../core/numbers.js')
      .then((mod) => {
        if (typeof mod.parseNumber !== 'function') {
          throw new Error('js/core/numbers.js does not export parseNumber().');
        }
        return mod.parseNumber;
      })
      .catch((err) => {
        numbersPromise = null; // allow a retry once the module lands
        throw new Error(
          `Number engine unavailable: ${err.message}. Numeric tools need js/core/numbers.js.`
        );
      });
  }
  return numbersPromise;
}

/* ------------------------------------------------------------------ *
 * CDN library access (globals, loaded by index.html)
 * ------------------------------------------------------------------ */
function globalScope() {
  return typeof globalThis !== 'undefined' ? globalThis : {};
}

export function getPapa() {
  const Papa = globalScope().Papa;
  if (!Papa) throw new Error('PapaParse is not loaded.');
  return Papa;
}

export function getXLSX() {
  const XLSX = globalScope().XLSX;
  if (!XLSX) throw new Error('SheetJS (XLSX) is not loaded.');
  return XLSX;
}

/* ------------------------------------------------------------------ *
 * Pure grid helpers  (grid === string[][], row 0 is the header row)
 * ------------------------------------------------------------------ */

/** Pad every row to the widest row. The model's rectangularity invariant. */
export function rectangularise(rows) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows.map((row) => {
    const out = row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)));
    while (out.length < width) out.push('');
    return out;
  });
}

export function gridDims(rows) {
  return { rows: rows.length, cols: rows.reduce((m, r) => Math.max(m, r.length), 0) };
}

/** Comparison key for header matching: case/space/punctuation insensitive. */
export function normaliseKey(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/[  -​]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Make header labels unique so a join or a merge cannot silently collapse columns. */
export function uniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((header, index) => {
    let name = String(header === null || header === undefined ? '' : header).trim();
    if (!name) name = `column_${index + 1}`;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, 1);
      return name;
    }
    const next = seen.get(key) + 1;
    seen.set(key, next);
    return `${name}_${next}`;
  });
}

export function indexOfHeader(headers, wanted) {
  const target = normaliseKey(wanted);
  if (!target) return -1;
  const exact = headers.findIndex((h) => String(h).trim() === String(wanted).trim());
  if (exact !== -1) return exact;
  return headers.findIndex((h) => normaliseKey(h) === target);
}

/* ------------------------------------------------------------------ *
 * CSV in / out
 * ------------------------------------------------------------------ */

export function parseCsvText(text) {
  if (!String(text || '').trim()) return [];
  const parsed = getPapa().parse(String(text), { skipEmptyLines: 'greedy' });
  return rectangularise(parsed.data || []);
}

/**
 * Contract: quoting is NEVER disabled. v1 wrote `quotes: false`, which turned
 * every `12,442,697` into a column break.
 */
export function toCsv(rows) {
  return getPapa().unparse(rectangularise(rows), { quotes: true, newline: '\r\n' });
}

export function filenameBase(name) {
  return (
    String(name || 'export')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9_-]+/gi, '_')
      .replace(/^_+|_+$/g, '') || 'export'
  );
}

/* ------------------------------------------------------------------ *
 * Small DOM helpers
 * ------------------------------------------------------------------ */

export function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch])
  );
}

export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((key) => {
      const value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value === true ? '' : String(value));
    });
  }
  (Array.isArray(children) ? children : children ? [children] : []).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return node;
}

export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
  const saveAs = globalScope().saveAs;
  if (saveAs) {
    saveAs(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: filename });
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const area = el('textarea', { style: 'position:fixed;opacity:0' });
  area.value = text;
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

/* ------------------------------------------------------------------ *
 * Grid preview
 * ------------------------------------------------------------------ */

/**
 * @param rows      string[][] including the header row
 * @param options   { changed: Set<'r,c'>, addedCols: Set<number>, removedRows: number }
 */
export function renderGrid(rows, options) {
  const opts = options || {};
  const changed = opts.changed || new Set();
  const addedCols = opts.addedCols || new Set();
  const wrap = el('div', { class: 'tool-grid-preview table-scroll' });

  if (!rows || !rows.length) {
    wrap.appendChild(el('p', { class: 'muted', text: 'Nothing to preview yet.' }));
    return wrap;
  }

  const grid = rectangularise(rows);
  const cols = Math.min(grid[0].length, MAX_PREVIEW_COLS);
  const bodyLimit = Math.min(grid.length - 1, MAX_PREVIEW_ROWS);
  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');

  for (let c = 0; c < cols; c += 1) {
    const th = el('th', { text: grid[0][c] });
    if (addedCols.has(c)) th.classList.add('is-added');
    headRow.appendChild(th);
  }
  if (grid[0].length > cols) headRow.appendChild(el('th', { text: `+${grid[0].length - cols} more` }));
  thead.appendChild(headRow);

  const tbody = el('tbody');
  for (let r = 1; r <= bodyLimit; r += 1) {
    const tr = el('tr');
    for (let c = 0; c < cols; c += 1) {
      const td = el('td', { text: grid[r][c] });
      if (changed.has(`${r},${c}`)) td.classList.add('is-changed');
      if (addedCols.has(c)) td.classList.add('is-added');
      tr.appendChild(td);
    }
    if (grid[0].length > cols) tr.appendChild(el('td', { text: '…' }));
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  wrap.appendChild(table);
  if (grid.length - 1 > bodyLimit) {
    wrap.appendChild(
      el('p', {
        class: 'muted',
        text: `Preview shows ${bodyLimit} of ${grid.length - 1} data rows. The download contains all of them.`
      })
    );
  }
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Session tables (optional)
 *
 * `core/store.js` belongs to the UI agent, so this probes a few plausible
 * shapes and simply hides the control when nothing is found.
 * ------------------------------------------------------------------ */
export function sessionTables(store) {
  if (!store) return [];
  let tables = null;
  try {
    if (typeof store.getState === 'function') tables = store.getState().tables;
    if (!tables && typeof store.get === 'function') tables = store.get('tables');
    if (!tables && Array.isArray(store.tables)) tables = store.tables;
    if (!tables && typeof store.getTables === 'function') tables = store.getTables();
  } catch {
    return [];
  }
  if (!Array.isArray(tables)) return [];
  return tables.filter((t) => t && Array.isArray(t.rows));
}

/** Table (model shape) -> flat grid with a single header row. */
export function tableToGrid(table) {
  const headerRows = Array.isArray(table.headers) ? table.headers : [];
  const header = headerRows.length
    ? headerRows[headerRows.length - 1].map((cell, index) => {
        const stack = headerRows
          .map((hr) => String(hr[index] || '').trim())
          .filter(Boolean);
        return stack.length ? Array.from(new Set(stack)).join(' ') : `column_${index + 1}`;
      })
    : (table.rows[0] || []).map((_, i) => (i === 0 ? 'row_label' : `column_${i}`));
  return rectangularise([header, ...table.rows]);
}

/* ------------------------------------------------------------------ *
 * The tool shell
 * ------------------------------------------------------------------ *
 *
 * spec = {
 *   description: string,
 *   inputs: Input[],
 *   run(values, helpers) -> Result | Promise<Result>
 * }
 *
 * Input kinds: 'csv' (textarea + file picker + session table),
 *              'files' (multi file), 'text', 'number', 'select', 'checkbox', 'textarea'
 *
 * Result = {
 *   rows?: string[][],          // primary tabular result
 *   text?: string,              // primary text result when not tabular
 *   name?: string,              // suggested download basename
 *   summary?: string | string[],
 *   changes?: string[],         // human-readable "what changed" lines
 *   warnings?: string[],
 *   changed?: Set<'r,c'>,       // cells to highlight in the preview
 *   addedCols?: Set<number>,
 *   extras?: [{ label, name, rows?, text?, mime? }]  // secondary downloads
 * }
 */
export function buildTool(container, ctx, spec) {
  const notify = (ctx && ctx.notify) || (() => {});
  const root = el('div', { class: 'tool-body' });
  const form = el('div', { class: 'tool-inputs' });
  const statusLine = el('div', { class: 'tool-status', role: 'status' });
  const changesBox = el('div', { class: 'tool-changes' });
  const warnBox = el('div', { class: 'tool-warnings' });
  const previewBox = el('div', { class: 'tool-preview' });
  const actions = el('div', { class: 'action-row tool-actions' });

  const values = {};
  const controls = [];
  let lastResult = null;
  let runToken = 0;

  spec.inputs.forEach((input) => {
    const control = buildInput(input, ctx, (value) => {
      values[input.name] = value;
      schedule();
    });
    values[input.name] = control.initial;
    controls.push(control);
    form.appendChild(control.node);
  });

  const copyButton = el('button', {
    class: 'secondary-button small',
    type: 'button',
    text: 'Copy',
    onclick: async () => {
      if (!lastResult) return;
      const text = lastResult.text !== undefined ? lastResult.text : toCsv(lastResult.rows || []);
      try {
        await copyToClipboard(text);
        notify('Copied to clipboard.');
        statusLine.textContent = 'Copied to clipboard.';
      } catch (err) {
        notify(`Copy failed: ${err.message}`, 'error');
      }
    }
  });

  const downloadButton = el('button', {
    class: 'primary-button small',
    type: 'button',
    text: 'Download CSV',
    onclick: () => {
      if (!lastResult) return;
      const base = filenameBase(lastResult.name || spec.id || 'result');
      if (lastResult.text !== undefined && !lastResult.rows) {
        downloadText(`${base}.txt`, lastResult.text, 'text/plain;charset=utf-8');
      } else {
        downloadText(`${base}.csv`, toCsv(lastResult.rows || []));
      }
    }
  });

  const extrasBox = el('span', { class: 'tool-extras' });
  actions.append(copyButton, downloadButton, extrasBox);
  setEnabled(false);

  root.append(
    spec.description ? el('p', { class: 'tool-description muted', text: spec.description }) : el('span'),
    form,
    actions,
    statusLine,
    warnBox,
    changesBox,
    previewBox
  );
  container.appendChild(root);

  function setEnabled(on) {
    copyButton.disabled = !on;
    downloadButton.disabled = !on;
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  }

  async function run() {
    const token = ++runToken;
    statusLine.textContent = 'Working…';
    try {
      const result = await spec.run(values, { notify, ctx });
      if (token !== runToken) return;
      lastResult = result && (result.rows || result.text !== undefined) ? result : null;
      render(result || {});
    } catch (err) {
      if (token !== runToken) return;
      lastResult = null;
      setEnabled(false);
      previewBox.innerHTML = '';
      changesBox.innerHTML = '';
      warnBox.innerHTML = '';
      statusLine.textContent = '';
      warnBox.appendChild(el('p', { class: 'danger', text: err.message }));
    }
  }

  function render(result) {
    previewBox.innerHTML = '';
    changesBox.innerHTML = '';
    warnBox.innerHTML = '';
    extrasBox.innerHTML = '';

    const summary = result.summary
      ? Array.isArray(result.summary)
        ? result.summary.join(' · ')
        : result.summary
      : '';
    statusLine.textContent = summary;

    (result.warnings || []).forEach((warning) =>
      warnBox.appendChild(el('p', { class: 'warning', text: warning }))
    );

    if (result.changes && result.changes.length) {
      const list = el('ul', { class: 'tool-change-list' });
      result.changes.slice(0, 25).forEach((line) => list.appendChild(el('li', { text: line })));
      if (result.changes.length > 25) {
        list.appendChild(el('li', { class: 'muted', text: `…and ${result.changes.length - 25} more` }));
      }
      changesBox.append(el('h4', { text: 'What changed' }), list);
    } else if (result.rows || result.text !== undefined) {
      changesBox.appendChild(el('p', { class: 'muted', text: 'No changes made to your input.' }));
    }

    if (result.rows) {
      previewBox.appendChild(
        renderGrid(result.rows, { changed: result.changed, addedCols: result.addedCols })
      );
    } else if (result.text !== undefined) {
      previewBox.appendChild(el('pre', { class: 'tool-output', text: result.text }));
    }

    (result.extras || []).forEach((extra) => {
      extrasBox.appendChild(
        el('button', {
          class: 'secondary-button small',
          type: 'button',
          text: extra.label,
          onclick: () => {
            if (typeof extra.download === 'function') return extra.download();
            const base = filenameBase(extra.name || 'extra');
            if (extra.rows) downloadText(`${base}.csv`, toCsv(extra.rows));
            else downloadText(`${base}.txt`, extra.text || '', extra.mime || 'text/plain;charset=utf-8');
          }
        })
      );
    });

    setEnabled(Boolean(lastResult));
  }

  schedule();
  return { rerun: schedule, values };
}

function buildInput(input, ctx, onChange) {
  const wrap = el('label', { class: `tool-input tool-input-${input.kind || 'text'}` });
  if (input.label) wrap.appendChild(el('span', { class: 'tool-input-label', text: input.label }));

  if (input.kind === 'csv') {
    const area = el('textarea', {
      placeholder: input.placeholder || 'Paste CSV (with a header row) or choose a file',
      rows: input.rows || 6
    });
    const file = el('input', { type: 'file', accept: input.accept || '.csv,.tsv,text/csv,text/plain' });
    const hint = el('span', { class: 'muted tool-input-hint' });

    const emit = () => onChange(area.value);
    area.addEventListener('input', emit);
    file.addEventListener('change', async () => {
      const chosen = file.files && file.files[0];
      if (!chosen) return;
      area.value = await chosen.text();
      hint.textContent = `Loaded ${chosen.name}`;
      emit();
    });

    const row = el('div', { class: 'compact-row' }, [file]);

    const tables = sessionTables(ctx && ctx.store);
    if (tables.length) {
      const picker = el('select');
      picker.appendChild(el('option', { value: '', text: '…or a table from this session' }));
      tables.forEach((table, index) => {
        picker.appendChild(
          el('option', {
            value: String(index),
            text: `${table.sourceFile || 'table'} p${table.page || '?'} ${table.title || ''}`.trim()
          })
        );
      });
      picker.addEventListener('change', () => {
        const table = tables[Number(picker.value)];
        if (!table) return;
        area.value = toCsv(tableToGrid(table));
        hint.textContent = `Loaded table ${table.id || ''}`;
        emit();
      });
      row.appendChild(picker);
    }

    wrap.append(area, row, hint);
    return { node: wrap, initial: input.value || '' };
  }

  if (input.kind === 'files') {
    const file = el('input', {
      type: 'file',
      accept: input.accept || '.csv,text/csv',
      multiple: true
    });
    const hint = el('span', { class: 'muted tool-input-hint' });
    file.addEventListener('change', () => {
      const list = Array.from(file.files || []);
      hint.textContent = list.length ? `${list.length} file(s): ${list.map((f) => f.name).join(', ')}` : '';
      onChange(list);
    });
    wrap.append(file, hint);
    return { node: wrap, initial: [] };
  }

  if (input.kind === 'select') {
    const select = el('select');
    (input.options || []).forEach((option) =>
      select.appendChild(el('option', { value: option.value, text: option.label }))
    );
    if (input.value !== undefined) select.value = input.value;
    select.addEventListener('change', () => onChange(select.value));
    wrap.appendChild(select);
    return { node: wrap, initial: select.value };
  }

  if (input.kind === 'checkbox') {
    const box = el('input', { type: 'checkbox' });
    box.checked = Boolean(input.value);
    box.addEventListener('change', () => onChange(box.checked));
    wrap.classList.add('check-label');
    wrap.prepend(box);
    return { node: wrap, initial: box.checked };
  }

  if (input.kind === 'textarea') {
    const area = el('textarea', { placeholder: input.placeholder || '', rows: input.rows || 4 });
    if (input.value) area.value = input.value;
    area.addEventListener('input', () => onChange(area.value));
    wrap.appendChild(area);
    return { node: wrap, initial: area.value };
  }

  const field = el('input', {
    type: input.kind === 'number' ? 'number' : 'text',
    placeholder: input.placeholder || '',
    min: input.min,
    max: input.max,
    step: input.step
  });
  if (input.value !== undefined) field.value = input.value;
  field.addEventListener('input', () => onChange(field.value));
  wrap.appendChild(field);
  return { node: wrap, initial: field.value };
}

/** Read a grid out of a `csv` input, throwing the standard "nothing yet" signal. */
export function gridFromCsvInput(text) {
  const grid = parseCsvText(text);
  if (grid.length < 1) return null;
  return grid;
}
