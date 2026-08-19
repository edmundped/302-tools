/**
 * Merge CSVs — group `combine`, order 10.
 *
 * v1's bug, verbatim from tools.js: when a file's header did not match the
 * first file's, it pushed a warning string and then appended the rows anyway.
 * The appended rows kept their own column order, so every value landed under
 * the wrong header. The grid was corrupted and the only signal was one line of
 * text the user had to read.
 *
 * This version takes the UNION of the headers. A column absent from a file is
 * filled with '' for that file's rows, and the per-file coverage report says
 * exactly which columns each file did and did not have.
 */
import { buildTool, parseCsvText, rectangularise, normaliseKey } from './_shared.js';

/**
 * Pure.
 * @param sources [{ name:string, grid:string[][] }]
 * @param options { matchBy:'normalised'|'exact', addSourceColumn:boolean, sourceColumnName:string }
 * @returns { rows, columns, report, changes, warnings }
 */
export function mergeGrids(sources, options) {
  const opts = {
    matchBy: 'normalised',
    addSourceColumn: true,
    sourceColumnName: 'source_file',
    ...(options || {})
  };

  const keyOf = (header) => (opts.matchBy === 'exact' ? String(header) : normaliseKey(header));

  const columns = []; // [{ key, label, seenAs:Set }]
  const byKey = new Map();
  const usable = sources.filter((source) => source && source.grid && source.grid.length);

  usable.forEach((source) => {
    const header = rectangularise(source.grid)[0];
    header.forEach((label, index) => {
      const key = keyOf(label) || `__blank_${index}`;
      if (!byKey.has(key)) {
        const column = { key, label: String(label), seenAs: new Set([String(label)]) };
        byKey.set(key, column);
        columns.push(column);
      } else {
        byKey.get(key).seenAs.add(String(label));
      }
    });
  });

  const headerRow = columns.map((column) => column.label);
  const rows = [opts.addSourceColumn ? [opts.sourceColumnName, ...headerRow] : headerRow];

  const report = [];
  const changes = [];
  const warnings = [];

  usable.forEach((source) => {
    const grid = rectangularise(source.grid);
    const header = grid[0];
    const positions = new Map();
    header.forEach((label, index) => {
      const key = keyOf(label) || `__blank_${index}`;
      if (!positions.has(key)) positions.set(key, index);
    });

    const missing = columns.filter((column) => !positions.has(column.key)).map((column) => column.label);
    const present = columns.filter((column) => positions.has(column.key)).map((column) => column.label);

    grid.slice(1).forEach((row) => {
      const mapped = columns.map((column) => {
        const index = positions.get(column.key);
        return index === undefined ? '' : row[index] === undefined ? '' : row[index];
      });
      rows.push(opts.addSourceColumn ? [source.name, ...mapped] : mapped);
    });

    report.push({ file: source.name, rows: grid.length - 1, present, missing });
    if (missing.length) {
      changes.push(`${source.name}: ${missing.length} column(s) filled with empty — ${missing.join(', ')}`);
    }
  });

  columns.forEach((column) => {
    if (column.seenAs.size > 1) {
      const variants = Array.from(column.seenAs);
      changes.push(`treated ${variants.map((v) => `"${v}"`).join(' and ')} as the same column, output as "${column.label}"`);
    }
  });

  if (opts.matchBy === 'normalised') {
    warnings.push('Headers are matched case- and punctuation-insensitively. Switch to exact matching if two similar headers really are different columns.');
  }
  if (usable.length < sources.length) {
    warnings.push(`${sources.length - usable.length} file(s) were empty and contributed nothing.`);
  }

  return {
    rows: rectangularise(rows),
    columns: headerRow,
    report,
    changes,
    warnings
  };
}

export const tool = {
  id: 'merge-csv',
  label: 'Merge CSVs',
  group: 'combine',
  order: 10,
  description:
    'Stack several CSVs into one. Headers are unioned, never dropped: a column missing from a file is filled with empty and reported.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'merge-csv',
      description: tool.description,
      inputs: [
        { name: 'files', kind: 'files', label: 'CSV files', accept: '.csv,.tsv,text/csv' },
        {
          name: 'pasted',
          kind: 'csv',
          label: 'Or paste one more CSV to include',
          placeholder: 'Optional — pasted CSV is merged alongside the chosen files'
        },
        {
          name: 'matchBy',
          kind: 'select',
          label: 'Match headers',
          value: 'normalised',
          options: [
            { value: 'normalised', label: 'Case- and punctuation-insensitive' },
            { value: 'exact', label: 'Exactly as written' }
          ]
        },
        { name: 'addSourceColumn', kind: 'checkbox', label: 'Add a source_file column', value: true }
      ],

      async run(values) {
        const sources = [];
        for (const file of values.files || []) {
          sources.push({ name: file.name, grid: parseCsvText(await file.text()) });
        }
        if (String(values.pasted || '').trim()) {
          sources.push({ name: 'pasted', grid: parseCsvText(values.pasted) });
        }
        if (!sources.length) return { summary: 'Choose two or more CSV files, or paste one.' };

        const result = mergeGrids(sources, values);
        const reportRows = [
          ['file', 'data_rows', 'columns_present', 'columns_missing'],
          ...result.report.map((entry) => [
            entry.file,
            String(entry.rows),
            String(entry.present.length),
            entry.missing.join('; ')
          ])
        ];

        return {
          rows: result.rows,
          name: 'merged',
          summary: [
            `${sources.length} file(s)`,
            `${result.rows.length - 1} data rows`,
            `${result.columns.length} union column(s)`
          ],
          changes: result.changes,
          warnings: result.warnings,
          extras: [{ label: 'Download coverage report', name: 'merge_coverage', rows: reportRows }]
        };
      }
    });
  }
};
