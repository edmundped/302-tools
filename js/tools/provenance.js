/**
 * Provenance stamper — group `annotate`, order 10.
 *
 * Every table that leaves this app should be able to answer "where did this
 * come from and when". v1 stamped source / page / date_pulled and nothing else,
 * and it overwrote row 0 without checking whether those columns already existed
 * — stamp twice and you got two `source` columns.
 */
import { buildTool, parseCsvText, rectangularise, indexOfHeader } from './_shared.js';

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pure.
 * @param grid    string[][] with a header row
 * @param fields  [{ name, value }]
 * @param options { position:'prepend'|'append', overwrite:boolean }
 * @returns { rows, added:string[], overwritten:string[], skipped:string[], addedCols:Set<number> }
 */
export function stampGrid(grid, fields, options) {
  const opts = { position: 'prepend', overwrite: false, ...(options || {}) };
  const source = rectangularise(grid);
  if (!source.length) return { rows: [], added: [], overwritten: [], skipped: [], addedCols: new Set() };

  const header = source[0].slice();
  const body = source.slice(1).map((row) => row.slice());

  const added = [];
  const overwritten = [];
  const skipped = [];
  const newFields = [];

  fields
    .filter((field) => field.name && String(field.value).length)
    .forEach((field) => {
      const existing = indexOfHeader(header, field.name);
      if (existing !== -1) {
        if (opts.overwrite) {
          body.forEach((row) => {
            row[existing] = field.value;
          });
          overwritten.push(field.name);
        } else {
          skipped.push(field.name);
        }
        return;
      }
      newFields.push(field);
      added.push(field.name);
    });

  const addedCols = new Set();
  let rows;
  if (opts.position === 'append') {
    rows = [
      [...header, ...newFields.map((f) => f.name)],
      ...body.map((row) => [...row, ...newFields.map((f) => f.value)])
    ];
    newFields.forEach((_, i) => addedCols.add(header.length + i));
  } else {
    rows = [
      [...newFields.map((f) => f.name), ...header],
      ...body.map((row) => [...newFields.map((f) => f.value), ...row])
    ];
    newFields.forEach((_, i) => addedCols.add(i));
  }

  return { rows: rectangularise(rows), added, overwritten, skipped, addedCols };
}

export const tool = {
  id: 'provenance',
  label: 'Provenance stamper',
  group: 'annotate',
  order: 10,
  description:
    'Add source, page and date_pulled columns (plus a URL and a note if you want them) so the table can always be traced back.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'provenance',
      description: tool.description,
      inputs: [
        { name: 'source', kind: 'csv', label: 'CSV (header row first)' },
        { name: 'sourceName', kind: 'text', label: 'source', placeholder: 'GOIL 2011 Annual Report.pdf' },
        { name: 'page', kind: 'text', label: 'page', placeholder: '32' },
        { name: 'datePulled', kind: 'text', label: 'date_pulled', value: today() },
        { name: 'sourceUrl', kind: 'text', label: 'source_url (optional)', placeholder: 'https://…' },
        { name: 'note', kind: 'text', label: 'note (optional)', placeholder: 'OCR, page region 2' },
        {
          name: 'position',
          kind: 'select',
          label: 'Put the columns',
          value: 'prepend',
          options: [
            { value: 'prepend', label: 'at the front' },
            { value: 'append', label: 'at the end' }
          ]
        },
        {
          name: 'overwrite',
          kind: 'checkbox',
          label: 'Overwrite a provenance column that already exists',
          value: false
        }
      ],

      run(values) {
        const grid = parseCsvText(values.source);
        if (grid.length < 1) return { summary: 'Paste a CSV to stamp.' };

        const fields = [
          { name: 'source', value: values.sourceName },
          { name: 'page', value: values.page },
          { name: 'date_pulled', value: values.datePulled },
          { name: 'source_url', value: values.sourceUrl },
          { name: 'note', value: values.note }
        ];
        const filled = fields.filter((field) => String(field.value || '').trim());
        if (!filled.length) return { summary: 'Fill in at least one provenance field.', rows: grid };

        const result = stampGrid(grid, filled, values);
        const changes = [];
        if (result.added.length) changes.push(`added column(s): ${result.added.join(', ')}`);
        if (result.overwritten.length) changes.push(`overwrote existing column(s): ${result.overwritten.join(', ')}`);
        if (result.skipped.length) {
          changes.push(`left existing column(s) alone: ${result.skipped.join(', ')}`);
        }

        return {
          rows: result.rows,
          addedCols: result.addedCols,
          name: 'stamped',
          summary: [`${result.rows.length - 1} data rows`, `${result.added.length} column(s) added`],
          changes,
          warnings: result.skipped.length
            ? [`${result.skipped.join(', ')} already existed and were not touched. Tick "overwrite" if you meant to replace them.`]
            : []
        };
      }
    });
  }
};
