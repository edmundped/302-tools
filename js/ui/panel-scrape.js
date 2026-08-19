/**
 * ui/panel-scrape.js — find documents and tables on a public page.
 *
 * The scraping engine lives in js/scraper/ (owned elsewhere). This panel
 * consumes it as:
 *
 *   discover(url, { proxyUrl, depth, signal }, onProgress) -> {
 *     files:  [{ url, label, filename, kind, size, contentType }],
 *     tables: Table[],           // shaped as docs/ARCHITECTURE.md § Table
 *     pagesVisited?: number
 *   }
 *   fetchFile?(url, { proxyUrl, signal }) -> Blob      // optional
 *
 * Anything it finds is handed to the same store the extraction desk reads, so
 * there is one preview surface and one set of edits, not two.
 */

import { h, clear, registerPanel, notify, badge, formatBytes, emptyState, activate } from './shell.js';
import { store } from '../core/store.js';
import { runTask } from './progress.js';
import { scraper } from './deps.js';

const KIND_TONE = { pdf: 'danger', xlsx: 'ok', docx: 'navy', csv: 'ok', image: 'warn' };

function guessKind(entry) {
  const source = `${entry.kind || ''} ${entry.contentType || ''} ${entry.filename || entry.url || ''}`.toLowerCase();
  if (source.includes('pdf')) return 'pdf';
  if (/xlsx|xls|sheet|excel/.test(source)) return 'xlsx';
  if (/docx?|word/.test(source)) return 'docx';
  if (/csv/.test(source)) return 'csv';
  if (/png|jpe?g|image/.test(source)) return 'image';
  return 'file';
}

function mount(container, ctx) {
  const statusLine = h('p', { class: 'status-line', role: 'status', 'aria-live': 'polite' });
  const progressHost = h('div');
  const resultsHost = h('div', { class: 'stack stack-lg' });

  const urlInput = h('input', {
    class: 'input',
    id: 's-url',
    type: 'url',
    placeholder: 'https://example.com/investor-relations',
    value: store.state.scrape.url || '',
    oninput: (e) => store.setScrape({ url: e.target.value })
  });

  const proxyInput = h('input', {
    class: 'input',
    id: 's-proxy',
    type: 'url',
    placeholder: 'https://your-worker.workers.dev/',
    value: store.settings.proxyUrl || '',
    onchange: (e) => {
      store.setSettings({ proxyUrl: e.target.value.trim() });
      notify('Proxy URL saved to this browser.', 'ok');
    }
  });

  const depthSelect = h(
    'select',
    { class: 'select', id: 's-depth' },
    h('option', { value: '0' }, 'This page only'),
    h('option', { value: '1' }, 'This page + one level'),
    h('option', { value: '2' }, 'Two levels (slow)')
  );

  const discoverBtn = h(
    'button',
    { class: 'btn btn--primary', type: 'button', onclick: () => discover() },
    'Discover'
  );

  const form = h(
    'div',
    { class: 'scrape-form' },
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field-label', for: 's-url' }, 'Target page'),
      urlInput
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field-label', for: 's-proxy' }, 'CORS proxy (your own Worker)'),
      proxyInput
    ),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 's-depth' }, 'Crawl depth'), depthSelect)
  );

  container.append(
    h(
      'div',
      { class: 'stack stack-lg' },
      h(
        'div',
        { class: 'notice notice--warn' },
        h(
          'div',
          null,
          h('strong', null, 'Use this on sources you are permitted to read.'),
          h(
            'p',
            null,
            "Check the site's terms and robots.txt first. Do not use this to bypass logins, paywalls or rate limits, and keep crawl depth low so you do not hammer someone else's server. Your browser cannot reach another origin directly, so the request goes through the CORS proxy you configure and control."
          )
        )
      ),
      form,
      h('div', { class: 'row' }, discoverBtn, statusLine),
      progressHost,
      resultsHost
    )
  );

  renderEmpty();

  function renderEmpty() {
    clear(resultsHost).append(
      emptyState({
        mark: '⌕',
        title: 'Nothing discovered yet',
        body:
          'Point this at a public reports page. Anything it finds — PDFs, spreadsheets, Word files, images and static HTML tables — is listed here and can be sent straight to the extraction desk.'
      })
    );
  }

  async function discover() {
    const url = urlInput.value.trim();
    const proxyUrl = proxyInput.value.trim();
    if (!url) {
      notify('Add a target URL first.', 'warn');
      urlInput.focus();
      return;
    }
    if (!proxyUrl) {
      notify('Add your CORS proxy URL — the browser cannot fetch another origin without one.', 'warn');
      proxyInput.focus();
      return;
    }

    const { discover: run, stubbed } = await scraper();
    if (stubbed) {
      clear(resultsHost).append(
        h(
          'div',
          { class: 'notice notice--warn' },
          h(
            'div',
            null,
            h('strong', null, 'The scraper engine is not connected yet.'),
            h('p', null, 'js/scraper/discover.js has not landed. The form is wired and will work the moment it does.')
          )
        )
      );
      return;
    }

    discoverBtn.disabled = true;
    statusLine.textContent = 'Fetching through your proxy…';

    const result = await runTask(progressHost, {
      label: `Discovering ${url}`,
      run: (onProgress, signal) =>
        run(url, { proxyUrl, depth: Number(depthSelect.value), signal }, onProgress)
    });

    discoverBtn.disabled = false;

    if (result.cancelled) {
      statusLine.textContent = 'Discovery cancelled.';
      return;
    }
    if (!result.ok) {
      statusLine.textContent = result.error?.message || 'Discovery failed.';
      return;
    }
    store.setScrape({ results: result.value, status: 'done' });
    renderResults(result.value, proxyUrl);
  }

  function renderResults(data, proxyUrl) {
    const files = data.files || [];
    const tables = data.tables || [];
    statusLine.textContent = `${files.length} file${files.length === 1 ? '' : 's'} and ${tables.length} HTML table${tables.length === 1 ? '' : 's'} found.`;

    clear(resultsHost);

    const list = h('div', { class: 'scrape-list' });
    if (!files.length) {
      list.append(h('p', { class: 'field-hint' }, 'No downloadable files were linked from this page.'));
    }
    for (const entry of files) {
      const kind = guessKind(entry);
      list.append(
        h(
          'div',
          { class: 'file-row' },
          h('span', { class: 'file-kind', 'aria-hidden': 'true' }, kind.toUpperCase().slice(0, 4)),
          h(
            'div',
            { style: { minWidth: '0' } },
            h('div', { class: 'file-name', title: entry.url }, entry.label || entry.filename || entry.url),
            h(
              'div',
              { class: 'file-meta' },
              badge(kind, KIND_TONE[kind] || 'outline'),
              h('span', null, entry.size ? formatBytes(entry.size) : 'size unknown'),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, entry.contentType || '')
            )
          ),
          h(
            'button',
            {
              class: 'btn btn--secondary btn--sm',
              type: 'button',
              onclick: () => sendToExtract(entry, proxyUrl)
            },
            'Send to extract'
          )
        )
      );
    }

    const right = h('div', { class: 'stack' });
    if (tables.length) {
      right.append(
        h(
          'div',
          { class: 'notice notice--info' },
          h(
            'div',
            { style: { flex: '1 1 auto' } },
            h('strong', null, `${tables.length} HTML table${tables.length === 1 ? '' : 's'} found.`),
            h('p', null, 'They are reviewed and edited on the extraction desk, alongside everything else in this session.')
          ),
          h(
            'button',
            {
              class: 'btn btn--gold btn--sm',
              type: 'button',
              onclick: () => {
                store.addDoc({
                  fileName: data.sourceUrl || urlInput.value.trim(),
                  fileType: 'html',
                  pageCount: 1,
                  pages: [{ number: 1, textChars: 9999, hasTextLayer: true }],
                  tables,
                  meta: { title: data.title || null },
                  warnings: ['Scraped from a live page — check it against the source before relying on it.']
                });
                notify(`${tables.length} tables added to the extraction desk.`, 'ok');
                activate('extract');
              }
            },
            'Review on the extraction desk'
          )
        )
      );
    } else {
      right.append(
        emptyState({
          mark: '∅',
          title: 'No static HTML tables',
          body: 'Pages that build their tables with JavaScript will not expose them to a plain fetch. Download the underlying file instead.'
        })
      );
    }

    resultsHost.append(h('div', { class: 'scrape-results' }, list, right));
  }

  async function sendToExtract(entry, proxyUrl) {
    const { discover: _run } = await scraper();
    const mod = await import('../scraper/discover.js').catch(() => null);
    const result = await runTask(progressHost, {
      label: `Fetching ${entry.filename || entry.url}`,
      run: async (onProgress, signal) => {
        onProgress({ phase: 'fetch', message: 'Requesting through your proxy' });
        if (mod?.fetchFile) return mod.fetchFile(entry.url, { proxyUrl, signal });
        const response = await fetch(`${proxyUrl}${encodeURIComponent(entry.url)}`, { signal });
        if (!response.ok) throw new Error(`Proxy returned ${response.status}`);
        return response.blob();
      }
    });
    if (!result.ok) return;
    const name = entry.filename || entry.url.split('/').pop() || 'download';
    const file = new File([result.value], name, { type: result.value.type || 'application/octet-stream' });
    store.addFiles([file]);
    notify(`${name} added to the extraction queue.`, 'ok');
    activate('extract');
  }
}

registerPanel({
  id: 'scrape',
  label: 'Scrape',
  order: 20,
  eyebrow: 'find the source documents',
  title: 'Site discovery',
  blurb:
    'Point at a public page and list every report, spreadsheet and static table on it, with type and size. Send any of them straight to the extraction desk.',
  mount
});

export { mount };
