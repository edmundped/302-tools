/**
 * CSV <-> Excel — group `convert`, order 10.
 *
 * Both directions. v1 only had CSV -> XLSX, wired inline in app.js, and it
 * silently truncated sheet names to 31 characters without deduplicating them,
 * so two files with long similar names produced a SheetJS collision.
 */
import { buildTool, parseCsvText, rectangularise, toCsv, filenameBase, getXLSX, downloadText } from './_shared.js';

/** Pure: Excel sheet names are max 31 chars, cannot contain []:*?/\ and must be unique. */
export function safeSheetName(name, taken) {
  const used = taken || new Set();
  let base = String(name || 'sheet')
    .replace(/[[\]:*?/\\]/g, '_')
    .replace(/^'+|'+$/g, '')
    .slice(0, 31)
    .trim() || 'sheet';
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `_${n}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Pure: the INDEX sheet rows required by the architecture contract. */
export function buildIndexRows(entries) {
  return [
    ['sheet', 'source', 'rows', 'columns', 'notes'],
    ...entries.map((entry) => [
      entry.sheet,
      entry.source,
      String(entry.rows),
      String(entry.columns),
      entry.notes || ''
    ])
  ];
}

export const tool = {
  id: 'csv-excel',
  label: 'CSV <-> Excel',
  group: 'convert',
  order: 10,
  description:
    'Bundle CSVs into one .xlsx workbook (one sheet per file plus an INDEX sheet), or split a workbook back out into CSVs.',

  mount(container, ctx) {
    const notify = (ctx && ctx.notify) || (() => {});

    buildTool(container, ctx, {
      id: 'csv-excel',
      description: tool.description,
      inputs: [
        {
          name: 'direction',
          kind: 'select',
          label: 'Direction',
          value: 'toXlsx',
          options: [
            { value: 'toXlsx', label: 'CSV files -> one Excel workbook' },
            { value: 'toCsv', label: 'Excel workbook -> CSV per sheet' }
          ]
        },
        {
          name: 'files',
          kind: 'files',
          label: 'Files',
          accept: '.csv,.tsv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        },
        {
          name: 'pasted',
          kind: 'csv',
          label: 'CSV -> Excel: or paste a single CSV',
          placeholder: 'Optional'
        },
        { name: 'workbookName', kind: 'text', label: 'Workbook file name', value: '302-tools_workbook' },
        {
          name: 'sheetIndex',
          kind: 'number',
          label: 'Excel -> CSV: which sheet to preview (1-based)',
          value: 1,
          min: 1
        }
      ],

      async run(values) {
        const files = values.files || [];

        if (values.direction === 'toXlsx') {
          const entries = [];
          const taken = new Set();
          for (const file of files) {
            const grid = parseCsvText(await file.text());
            if (!grid.length) continue;
            entries.push({
              sheet: safeSheetName(filenameBase(file.name), taken),
              source: file.name,
              grid
            });
          }
          if (String(values.pasted || '').trim()) {
            const grid = parseCsvText(values.pasted);
            if (grid.length) entries.push({ sheet: safeSheetName('pasted', taken), source: 'pasted', grid });
          }
          if (!entries.length) return { summary: 'Choose one or more CSV files, or paste a CSV.' };

          const indexRows = buildIndexRows(
            entries.map((entry) => ({
              sheet: entry.sheet,
              source: entry.source,
              rows: entry.grid.length - 1,
              columns: entry.grid[0].length,
              notes: entry.sheet === filenameBase(entry.source) ? '' : 'sheet name adjusted for Excel'
            }))
          );

          return {
            rows: entries[0].grid,
            name: filenameBase(values.workbookName),
            summary: [`${entries.length} sheet(s)`, `previewing "${entries[0].sheet}"`],
            changes: entries.map(
              (entry) => `${entry.source} -> sheet "${entry.sheet}" (${entry.grid.length - 1} rows x ${entry.grid[0].length} cols)`
            ),
            extras: [
              {
                label: 'Download .xlsx workbook',
                download: () => {
                  const XLSX = getXLSX();
                  const workbook = XLSX.utils.book_new();
                  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(indexRows), 'INDEX');
                  entries.forEach((entry) => {
                    XLSX.utils.book_append_sheet(
                      workbook,
                      XLSX.utils.aoa_to_sheet(rectangularise(entry.grid)),
                      entry.sheet
                    );
                  });
                  XLSX.writeFile(workbook, `${filenameBase(values.workbookName)}.xlsx`);
                  notify('Workbook downloaded.');
                }
              },
              { label: 'Download INDEX as CSV', name: 'workbook_index', rows: indexRows }
            ]
          };
        }

        // Excel -> CSV
        const book = files.find((file) => /\.(xlsx|xlsm|xls)$/i.test(file.name));
        if (!book) return { summary: 'Choose an .xlsx or .xls file.' };

        const XLSX = getXLSX();
        const buffer = await book.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        const names = workbook.SheetNames || [];
        if (!names.length) return { summary: 'That workbook has no sheets.' };

        const sheets = names.map((name) => ({
          name,
          grid: rectangularise(
            XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '' })
          )
        }));

        const wanted = Math.min(Math.max(Number(values.sheetIndex) || 1, 1), sheets.length) - 1;
        const chosen = sheets[wanted];

        return {
          rows: chosen.grid,
          name: `${filenameBase(book.name)}_${filenameBase(chosen.name)}`,
          summary: [
            `${sheets.length} sheet(s)`,
            `previewing "${chosen.name}" (${chosen.grid.length ? chosen.grid.length - 1 : 0} rows)`
          ],
          changes: sheets.map(
            (sheet) => `sheet "${sheet.name}": ${Math.max(0, sheet.grid.length - 1)} rows x ${sheet.grid.length ? sheet.grid[0].length : 0} cols`
          ),
          warnings: sheets.some((sheet) => !sheet.grid.length)
            ? ['Some sheets are empty and will produce empty CSVs.']
            : [],
          extras: [
            {
              label: `Download all ${sheets.length} sheet(s) as a ZIP`,
              download: async () => {
                const { downloadBundle } = await import('../core/zip.js');
                await downloadBundle(
                  sheets.map((sheet) => ({
                    name: `${filenameBase(book.name)}_${filenameBase(sheet.name)}.csv`,
                    content: toCsv(sheet.grid),
                    kind: 'csv',
                    source: `${book.name} :: ${sheet.name}`
                  })),
                  { name: `${filenameBase(book.name)}_sheets.zip`, title: `Sheets from ${book.name}` }
                );
                notify('ZIP downloaded.');
              }
            },
            {
              label: 'Download this sheet only',
              download: () =>
                downloadText(`${filenameBase(book.name)}_${filenameBase(chosen.name)}.csv`, toCsv(chosen.grid))
            }
          ]
        };
      }
    });
  }
};
