/**
 * ui/panel-extract.js — the extraction workspace.
 *
 * Flow, in the client's own words: "one, then many". The first file is
 * extracted immediately and put in front of the analyst. The rest wait in a
 * band at the top of the workspace until the analyst is happy, then the same
 * settings are applied to all of them in one cancellable batch.
 */

import { h, clear, registerPanel, notify, badge, emptyState } from './shell.js';
import { bus, EVENTS } from '../core/bus.js';
import { store } from '../core/store.js';
import { createDropzone, createFileList } from './dropzone.js';
import { createPreview } from './preview.js';
import { runTask, runBatch } from './progress.js';
import { ingest, csv, zipper, demoExtractor } from './deps.js';

/* --------------------------------------------------------------- helpers */

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadText(name, text) {
  downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8;' }), name);
}

/** Accept whatever shape an emitter returns and normalise to [{name,text}]. */
function asFiles(result, fallbackName) {
  if (!result) return [];
  if (typeof result === 'string') return [{ name: fallbackName, text: result }];
  if (Array.isArray(result)) return result.flatMap((r) => asFiles(r, fallbackName));
  if (result.text || result.content || result.csv) {
    return [{ name: result.name || result.filename || fallbackName, text: result.text || result.content || result.csv }];
  }
  return [];
}

const baseName = (fileName) => String(fileName || 'export').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');

/* ============================================================ panel mount */

function mount(container, ctx) {
  const rail = h('aside', { class: 'rail' });
  const main = h('div', { class: 'main-col' });
  const workspace = h('div', { class: 'workspace' }, rail, main);
  container.append(workspace);

  const progressHost = h('div', { class: 'stack stack-sm' });
  const statusLine = h('p', { class: 'status-line', role: 'status', 'aria-live': 'polite' });

  /* ------------------------------------------------------------- intake */

  const dropzone = createDropzone({
    onFiles: (files) => intake(files),
    title: 'Drop files here'
  });

  const fileList = createFileList({
    onRemove: (id) => {
      store.removeFile(id);
      renderRail();
    },
    onSelect: (entry) => {
      const block = main.querySelector(`[data-doc-id="${entry.docId}"]`);
      block?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  /* ------------------------------------------------------- rail controls */

  const ocrSelect = h(
    'select',
    {
      class: 'select',
      id: 'x-ocr-mode',
      onchange: (e) => store.setExtractOpts({ ocrMode: e.target.value })
    },
    h('option', { value: 'auto' }, 'Auto — OCR only pages with no text layer'),
    h('option', { value: 'always' }, 'Always — OCR every page (slow)'),
    h('option', { value: 'off' }, 'Off — text layer only')
  );

  const langInput = h('input', {
    class: 'input',
    id: 'x-ocr-lang',
    value: store.settings.extract.ocrLang,
    onchange: (e) => store.setExtractOpts({ ocrLang: e.target.value.trim() || 'eng' })
  });

  const dpiInput = h('input', {
    class: 'input',
    id: 'x-ocr-dpi',
    type: 'number',
    min: '96',
    max: '400',
    step: '10',
    value: String(store.settings.extract.ocrDpi),
    onchange: (e) => store.setExtractOpts({ ocrDpi: Number(e.target.value) || 200 })
  });

  const columnsInput = h('input', {
    class: 'input',
    id: 'x-columns',
    placeholder: 'line_item, 2011, 2010',
    value: (store.settings.extract.expectedColumns || []).join(', '),
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.target.blur();
      }
    },
    onchange: (e) => {
      const names = e.target.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      store.setExtractOpts({ expectedColumns: names });
      renderColumnChips();
      notify(
        names.length
          ? `${names.length} column${names.length === 1 ? '' : 's'} declared. Map them on each table.`
          : 'Declared columns cleared.',
        'info'
      );
    }
  });

  const columnChips = h('div', { class: 'row row-tight' });

  function renderColumnChips() {
    clear(columnChips);
    const names = store.settings.extract.expectedColumns || [];
    if (!names.length) {
      columnChips.append(h('span', { class: 'field-hint' }, 'None declared — detected headers are used as-is.'));
      return;
    }
    names.forEach((name) => columnChips.append(badge(name, 'gold')));
  }

  function outputCheck(key, label, hint) {
    const input = h('input', {
      type: 'checkbox',
      checked: store.settings.outputs[key],
      onchange: (e) => store.setSettings({ outputs: { [key]: e.target.checked } })
    });
    return h(
      'label',
      { class: 'check', title: hint },
      input,
      h('span', null, label)
    );
  }

  function previewPref(key, label) {
    const input = h('input', {
      type: 'checkbox',
      checked: store.settings.preview[key],
      onchange: (e) => {
        store.setSettings({ preview: { [key]: e.target.checked } });
        bus.emit('preview:prefs', store.settings.preview);
      }
    });
    return h('label', { class: 'check' }, input, h('span', null, label));
  }

  /* ------------------------------------------------------------ the rail */

  function renderRail() {
    clear(rail);

    rail.append(
      h(
        'section',
        { class: 'rail-section' },
        h('h2', { class: 'rail-title' }, 'Files'),
        dropzone.el,
        h(
          'p',
          { class: 'field-hint' },
          'PDF, PNG/JPG, XLSX/XLS/CSV and DOCX. Files are read in this browser and never uploaded.'
        ),
        fileList.render(store.state.files, store.state.ui.activeDocId),
        progressHost,
        statusLine,
        store.state.files.length
          ? h(
              'div',
              { class: 'row row-tight' },
              h(
                'button',
                {
                  class: 'btn btn--ghost btn--sm',
                  type: 'button',
                  onclick: () => {
                    store.clearFiles();
                    dropzone.reset();
                    renderRail();
                    notify('Session cleared.', 'info');
                  }
                },
                'Clear session'
              )
            )
          : null
      )
    );

    rail.append(
      h(
        'section',
        { class: 'rail-section' },
        h('h2', { class: 'rail-title' }, 'Say the columns'),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field-label', for: 'x-columns' }, 'Expected columns'),
          columnsInput,
          h(
            'p',
            { class: 'field-hint' },
            'Declare what the table should contain and map onto it, instead of accepting whatever was detected.'
          ),
          columnChips
        )
      )
    );

    rail.append(
      h(
        'section',
        { class: 'rail-section' },
        h('h2', { class: 'rail-title' }, 'Extraction'),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field-label', for: 'x-ocr-mode' }, 'Scanned pages'),
          ocrSelect,
          h('p', { class: 'field-hint' }, 'OCR is slow. Auto only reads pages with no usable text layer.')
        ),
        h(
          'div',
          { class: 'row', style: { alignItems: 'flex-end' } },
          h(
            'div',
            { class: 'field', style: { flex: '1 1 120px' } },
            h('label', { class: 'field-label', for: 'x-ocr-lang' }, 'OCR language'),
            langInput
          ),
          h(
            'div',
            { class: 'field', style: { flex: '0 0 96px' } },
            h('label', { class: 'field-label', for: 'x-ocr-dpi' }, 'Raster DPI'),
            dpiInput
          )
        )
      )
    );

    rail.append(
      h(
        'section',
        { class: 'rail-section' },
        h('h2', { class: 'rail-title' }, 'Preview'),
        previewPref('showCrop', 'Show the source page crop'),
        previewPref('showFootCheck', 'Show foot checks')
      )
    );

    rail.append(
      h(
        'section',
        { class: 'rail-section' },
        h('h2', { class: 'rail-title' }, 'Outputs'),
        outputCheck('machine', 'Machine CSV (tidy, one row per cell)', 'Long format for databases and pivot tables'),
        outputCheck('analyst', 'Review CSV (wide, faithful)', 'Original formatting preserved, with a computed check_total'),
        outputCheck('notes', 'Notes only', 'Just the tables that sit under a note number'),
        outputCheck('workbook', 'Excel workbook', 'One sheet per table plus an INDEX sheet'),
        h(
          'button',
          {
            class: 'btn btn--primary btn--block',
            type: 'button',
            onclick: exportSelected
          },
          'Export selected tables'
        ),
        h('p', { class: 'field-hint' }, 'Nothing is written until you press this. Everything is generated locally.')
      )
    );

    ocrSelect.value = store.settings.extract.ocrMode;
    renderColumnChips();
  }

  /* -------------------------------------------------------- batch band  */

  const batchBand = h('div', { class: 'batch-band', hidden: true });

  function renderBatchBand() {
    const queued = store.pendingFiles();
    const done = store.state.docs.length;
    batchBand.hidden = !(queued.length && done);
    if (batchBand.hidden) {
      clear(batchBand);
      return;
    }
    clear(batchBand);
    batchBand.append(
      h(
        'div',
        { class: 'batch-copy' },
        h('strong', null, `One is done. ${queued.length} more file${queued.length === 1 ? '' : 's'} waiting.`),
        h(
          'p',
          null,
          'Tune the settings and the first document until it is right, then apply exactly the same treatment to the rest.'
        )
      ),
      h(
        'div',
        { class: 'batch-actions' },
        h(
          'button',
          { class: 'btn btn--secondary', type: 'button', onclick: () => extractOne(queued[0]) },
          'Extract just the next one'
        ),
        h(
          'button',
          { class: 'btn btn--gold', type: 'button', onclick: () => extractBatch(queued) },
          `Apply to all ${queued.length}`
        )
      )
    );
  }

  /* ---------------------------------------------------------- extraction */

  let engineWarned = false;

  async function getExtractor(entry) {
    const { pickExtractor, stubbed } = await ingest();
    if (stubbed && !engineWarned) {
      engineWarned = true;
      main.prepend(
        h(
          'div',
          { class: 'notice notice--warn' },
          h(
            'div',
            null,
            h('strong', null, 'Extraction engine not connected.'),
            h(
              'p',
              null,
              'js/ingest/ has not landed yet, so this session shows demonstration tables so the review surface can be exercised. The figures below are not from your file.'
            )
          )
        )
      );
    }
    return pickExtractor?.(entry.file) || (stubbed ? demoExtractor : null);
  }

  async function extractOne(entry, opts = {}) {
    if (!entry) return;
    const extractor = await getExtractor(entry);
    if (!extractor) {
      store.updateFile(entry.id, { status: 'error', error: 'No extractor accepts this file type.' });
      renderRail();
      return;
    }

    store.updateFile(entry.id, { status: 'reading', error: null });
    dropzone.setState('loading');
    renderRail();

    const result = await runTask(progressHost, {
      label: entry.name,
      run: (onProgress, signal) =>
        extractor.extract(entry.file, { ...store.extractorOpts(opts), signal }, onProgress)
    });

    dropzone.setState(store.state.docs.length ? 'done' : 'idle');

    if (result.cancelled) {
      store.updateFile(entry.id, { status: 'queued' });
      statusLine.textContent = 'Cancelled. Nothing was extracted.';
      renderRail();
      renderBatchBand();
      return;
    }
    if (!result.ok) {
      store.updateFile(entry.id, { status: 'error', error: result.error?.message || 'Extraction failed.' });
      renderRail();
      return;
    }

    const doc = store.addDoc(result.value);
    store.updateFile(entry.id, { status: 'done', docId: doc.id, pageCount: doc.pageCount });
    statusLine.textContent = `${doc.fileName}: ${doc.tables.length} table${doc.tables.length === 1 ? '' : 's'} across ${doc.pageCount} pages.`;
    renderRail();
    renderBatchBand();
    return doc;
  }

  async function extractBatch(entries) {
    const list = entries.length ? entries : store.pendingFiles();
    if (!list.length) return;
    dropzone.setState('loading');
    const { results, cancelled } = await runBatch(progressHost, {
      label: `Applying the same treatment to ${list.length} files`,
      items: list,
      describe: (entry) => entry.name,
      each: async (entry, onProgress, signal) => {
        const extractor = await getExtractor(entry);
        if (!extractor) throw new Error('No extractor accepts this file type.');
        store.updateFile(entry.id, { status: 'reading' });
        const doc = await extractor.extract(entry.file, { ...store.extractorOpts(), signal }, onProgress);
        const added = store.addDoc(doc);
        store.updateFile(entry.id, { status: 'done', docId: added.id, pageCount: added.pageCount });
        return added;
      }
    });

    dropzone.setState('done');
    const failed = results.filter((r) => !r.ok);
    failed.forEach((r) => store.updateFile(r.item.id, { status: 'error', error: r.error?.message }));
    renderRail();
    renderBatchBand();
    statusLine.textContent = cancelled
      ? `Batch cancelled. ${results.filter((r) => r.ok).length} of ${list.length} finished.`
      : `Batch finished. ${results.length - failed.length} of ${list.length} extracted.`;
    notify(statusLine.textContent, failed.length ? 'warn' : 'ok');
  }

  async function intake(files) {
    const added = store.addFiles(files);
    renderRail();
    const unsupported = added.filter((entry) => !entry.supported);
    if (unsupported.length) {
      notify(`${unsupported.length} file${unsupported.length === 1 ? '' : 's'} skipped — unsupported type.`, 'warn');
    }
    const supported = added.filter((entry) => entry.supported);
    if (!supported.length) {
      dropzone.setState('error');
      return;
    }
    // "One, then many" — do the first, hold the rest.
    const first = store.state.docs.length ? null : supported[0];
    if (first) await extractOne(first);
    renderBatchBand();
    if (!first) {
      statusLine.textContent = `${supported.length} file${supported.length === 1 ? '' : 's'} queued.`;
    }
  }

  /* --------------------------------------------------------------- OCR   */

  async function runOcr(doc, pages) {
    const entry = store.state.files.find((f) => f.docId === doc.id);
    if (!entry) {
      notify('The original file is no longer in this session, so it cannot be re-read.', 'warn');
      return;
    }
    const extractor = await getExtractor(entry);
    if (!extractor) return;
    const result = await runTask(progressHost, {
      label: `OCR — ${doc.fileName}`,
      run: (onProgress, signal) =>
        extractor.extract(
          entry.file,
          { ...store.extractorOpts({ ocrMode: 'always', ocrPages: pages.map((p) => p.number) }), signal },
          onProgress
        )
    });
    if (result.cancelled) {
      notify('OCR cancelled. The document is unchanged.', 'warn');
      return;
    }
    if (!result.ok) return;
    store.removeDoc(doc.id);
    const fresh = store.addDoc(result.value);
    store.updateFile(entry.id, { docId: fresh.id, status: 'done' });
    renderRail();
    notify('OCR finished.', 'ok');
  }

  /* ------------------------------------------------------------- export  */

  async function exportSelected() {
    const tables = store.selectedTables();
    if (!tables.length) {
      notify('Select at least one table first.', 'warn');
      return;
    }
    const outputs = store.settings.outputs;
    if (!Object.values(outputs).some(Boolean)) {
      notify('Choose at least one output format.', 'warn');
      return;
    }

    const emitters = await csv();
    const base = baseName(tables[0].sourceFile);
    const files = [];

    try {
      if (outputs.machine) files.push(...asFiles(emitters.toMachineCsv(tables), `${base}_data.csv`));
      if (outputs.analyst) files.push(...asFiles(emitters.toAnalystCsv(tables), `${base}_review.csv`));
      if (outputs.notes) {
        const notesTables = tables.filter((t) => t.section === 'notes');
        if (!notesTables.length) notify('No notes tables are selected, so no notes file was written.', 'warn');
        else files.push(...asFiles(emitters.toNotesCsv(notesTables), `${base}_notes.csv`));
      }
    } catch (error) {
      console.error(error);
      notify(`The CSV emitter failed: ${error.message}`, 'error');
      return;
    }

    if (outputs.workbook) {
      try {
        const workbook = emitters.toWorkbook(tables);
        if (workbook && typeof XLSX !== 'undefined') XLSX.writeFile(workbook, `${base}_tables.xlsx`);
      } catch (error) {
        notify(`Workbook export failed: ${error.message}`, 'error');
      }
    }

    if (!files.length) {
      notify('Nothing was written.', 'warn');
      return;
    }
    if (files.length === 1) {
      downloadText(files[0].name, files[0].text);
    } else {
      const { bundle } = await zipper();
      await bundle(files, `${base}_302-tools.zip`);
    }
    notify(
      `${files.length} file${files.length === 1 ? '' : 's'} written from ${tables.length} table${tables.length === 1 ? '' : 's'}.`,
      'ok'
    );
  }

  async function downloadOne(table, kind) {
    const emitters = await csv();
    const base = `${baseName(table.sourceFile)}_p${table.page}`;
    const files =
      kind === 'machine'
        ? asFiles(emitters.toMachineCsv([table]), `${base}_data.csv`)
        : asFiles(emitters.toAnalystCsv([table]), `${base}_review.csv`);
    if (!files.length) {
      notify('The emitter returned nothing for this table.', 'warn');
      return;
    }
    files.forEach((f) => downloadText(f.name, f.text));
  }

  /* -------------------------------------------------------------- mount  */

  const preview = createPreview({
    store,
    onDownload: downloadOne,
    onOcr: runOcr,
    onTemplate: (table, doc) => {
      store.state.tunedDocId = doc.id;
      const queued = store.pendingFiles();
      notify(
        queued.length
          ? `Template set from "${table.title || table.id}". Apply it to the remaining ${queued.length} file${queued.length === 1 ? '' : 's'} above.`
          : `Template set from "${table.title || table.id}". Add more files to apply it.`,
        'ok'
      );
      renderBatchBand();
      batchBand.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  main.append(batchBand, preview.el);

  if (ctx.head?.actions) {
    ctx.head.actions.append(
      h(
        'button',
        { class: 'btn btn--secondary', type: 'button', onclick: () => extractBatch(store.pendingFiles()) },
        'Extract all queued'
      ),
      h('button', { class: 'btn btn--primary', type: 'button', onclick: exportSelected }, 'Export selected')
    );
  }

  bus.on(EVENTS.FILES_CHANGED, renderBatchBand);
  bus.on(EVENTS.DOCS_CHANGED, () => {
    const stats = store.stats();
    ctx.setTabCount?.('extract', stats.tables || null);
    renderBatchBand();
  });

  renderRail();
  renderBatchBand();
}

registerPanel({
  id: 'extract',
  label: 'Extract',
  order: 10,
  eyebrow: 'documents in, tables out',
  title: 'Extraction desk',
  blurb:
    'Read PDFs, scans, spreadsheets and images into checkable tables. Get one file right, then apply the same treatment to the batch. Nothing leaves this browser.',
  mount
});

export { mount };
