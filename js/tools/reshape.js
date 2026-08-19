/**
 * Wide <-> long reshape — group `convert`, order 20.
 *
 * Missing from v1 entirely, and it is the transform analysts reach for most:
 * a statement printed with 2011 / 2010 across the top has to become one row per
 * (line item, period, value) before it will go into anything. It is also the
 * exact shape of the machine CSV in core/csv.js, so this tool and that emitter
 * agree by construction.
 */
import { buildTool, parseCsvText, rectangularise, indexOfHeader, uniqueHeaders } from './_shared.js';

/** Pure: resolve a column spec (names or 1-based numbers, comma separated) to indexes. */
export function resolveCols(header, spec) {
  const raw = String(spec || '').trim();
  if (!raw) return [];
  const out = [];
  raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      // Name first: financial headers ARE years ("2011"), so a digits-only
      // spec must be matched against the header before it is read as an index.
      const named = indexOfHeader(header, part);
      if (named !== -1) {
        out.push(named);
        return;
      }
      if (/^\d+$/.test(part)) {
        const index = Number(part) - 1;
        if (index >= 0 && index < header.length) out.push(index);
        return;
      }
      const index = indexOfHeader(header, part);
      if (index !== -1) out.push(index);
    });
  return Array.from(new Set(out));
}

/**
 * Pure: wide -> long (melt).
 * @param options { idColumns:number[], valueColumns:number[]|null, variableName, valueName, dropEmpty }
 */
export function wideToLong(grid, options) {
  const opts = { variableName: 'variable', valueName: 'value', dropEmpty: true, ...(options || {}) };
  const source = rectangularise(grid);
  if (source.length < 2) return { rows: [], dropped: 0 };

  const header = source[0];
  const idColumns = opts.idColumns && opts.idColumns.length ? opts.idColumns : [0];
  const valueColumns =
    opts.valueColumns && opts.valueColumns.length
      ? opts.valueColumns
      : header.map((_, index) => index).filter((index) => !idColumns.includes(index));

  const rows = [[...idColumns.map((c) => header[c] || `column_${c + 1}`), opts.variableName, opts.valueName]];
  let dropped = 0;

  source.slice(1).forEach((row) => {
    valueColumns.forEach((c) => {
      const value = row[c] === undefined || row[c] === null ? '' : String(row[c]);
      if (opts.dropEmpty && value.trim() === '') {
        dropped += 1;
        return;
      }
      rows.push([...idColumns.map((i) => row[i] || ''), header[c] || `column_${c + 1}`, value]);
    });
  });

  return { rows: rectangularise(rows), dropped, idColumns, valueColumns };
}

/**
 * Pure: long -> wide (pivot).
 * @param options { idColumns:number[], variableColumn:number, valueColumn:number, aggregate:'first'|'last'|'concat' }
 * @returns { rows, collisions:[{key, variable, kept, discarded}] }
 */
export function longToWide(grid, options) {
  const opts = { aggregate: 'first', ...(options || {}) };
  const source = rectangularise(grid);
  if (source.length < 2) return { rows: [], collisions: [] };

  const header = source[0];
  const idColumns = opts.idColumns && opts.idColumns.length ? opts.idColumns : [0];
  const vc = opts.variableColumn;
  const valc = opts.valueColumn;
  if (vc === undefined || valc === undefined) throw new Error('Pick both a variable column and a value column.');

  const variables = [];
  const seenVars = new Set();
  const byKey = new Map(); // joined id -> { ids, values:Map }
  const order = [];
  const collisions = [];

  source.slice(1).forEach((row) => {
    const ids = idColumns.map((c) => (row[c] === undefined ? '' : String(row[c])));
    const key = ids.join('');
    const variable = String(row[vc] === undefined ? '' : row[vc]);
    const value = String(row[valc] === undefined ? '' : row[valc]);

    if (!seenVars.has(variable)) {
      seenVars.add(variable);
      variables.push(variable);
    }
    if (!byKey.has(key)) {
      byKey.set(key, { ids, values: new Map() });
      order.push(key);
    }
    const bucket = byKey.get(key);
    if (bucket.values.has(variable)) {
      const existing = bucket.values.get(variable);
      if (opts.aggregate === 'last') {
        collisions.push({ key: ids.join(' | '), variable, kept: value, discarded: existing });
        bucket.values.set(variable, value);
      } else if (opts.aggregate === 'concat') {
        bucket.values.set(variable, `${existing} | ${value}`);
        collisions.push({ key: ids.join(' | '), variable, kept: `${existing} | ${value}`, discarded: '' });
      } else {
        collisions.push({ key: ids.join(' | '), variable, kept: existing, discarded: value });
      }
    } else {
      bucket.values.set(variable, value);
    }
  });

  const rows = [
    uniqueHeaders([...idColumns.map((c) => header[c] || `column_${c + 1}`), ...variables])
  ];
  order.forEach((key) => {
    const bucket = byKey.get(key);
    rows.push([...bucket.ids, ...variables.map((variable) => bucket.values.get(variable) || '')]);
  });

  return { rows: rectangularise(rows), collisions, variables };
}

export const tool = {
  id: 'reshape',
  label: 'Wide <-> long',
  group: 'convert',
  order: 20,
  description:
    'Melt period columns down into one row per value, or pivot a tidy long table back out into a wide grid.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'reshape',
      description: tool.description,
      inputs: [
        { name: 'source', kind: 'csv', label: 'CSV (header row first)' },
        {
          name: 'direction',
          kind: 'select',
          label: 'Direction',
          value: 'wideToLong',
          options: [
            { value: 'wideToLong', label: 'Wide -> long (melt)' },
            { value: 'longToWide', label: 'Long -> wide (pivot)' }
          ]
        },
        {
          name: 'idSpec',
          kind: 'text',
          label: 'Id columns to keep as-is (names or 1-based numbers)',
          placeholder: 'row_label',
          value: '1'
        },
        {
          name: 'valueSpec',
          kind: 'text',
          label: 'Melt: columns to melt (blank = everything that is not an id column)',
          placeholder: '2011, 2010'
        },
        { name: 'variableName', kind: 'text', label: 'Melt: name for the variable column', value: 'variable' },
        { name: 'valueName', kind: 'text', label: 'Melt: name for the value column', value: 'value' },
        { name: 'dropEmpty', kind: 'checkbox', label: 'Melt: drop empty values', value: true },
        {
          name: 'variableSpec',
          kind: 'text',
          label: 'Pivot: the column holding the variable names',
          placeholder: 'variable'
        },
        { name: 'valueColSpec', kind: 'text', label: 'Pivot: the column holding the values', placeholder: 'value' },
        {
          name: 'aggregate',
          kind: 'select',
          label: 'Pivot: when a cell would be written twice',
          value: 'first',
          options: [
            { value: 'first', label: 'Keep the first, report the clash' },
            { value: 'last', label: 'Keep the last, report the clash' },
            { value: 'concat', label: 'Join both with " | "' }
          ]
        }
      ],

      run(values) {
        const grid = parseCsvText(values.source);
        if (grid.length < 2) return { summary: 'Paste a CSV with a header row and at least one data row.' };
        const header = grid[0];
        const idColumns = resolveCols(header, values.idSpec);
        if (!idColumns.length) {
          return { summary: `Name at least one id column. Headers: ${header.join(', ')}` };
        }

        if (values.direction === 'wideToLong') {
          const valueColumns = resolveCols(header, values.valueSpec);
          const result = wideToLong(grid, {
            idColumns,
            valueColumns: valueColumns.length ? valueColumns : null,
            variableName: values.variableName || 'variable',
            valueName: values.valueName || 'value',
            dropEmpty: values.dropEmpty
          });
          return {
            rows: result.rows,
            name: 'long',
            summary: [
              `${grid.length - 1} wide rows -> ${result.rows.length - 1} long rows`,
              `${result.valueColumns.length} column(s) melted`
            ],
            changes: [
              `id columns kept: ${idColumns.map((c) => header[c]).join(', ')}`,
              `melted: ${result.valueColumns.map((c) => header[c]).join(', ')}`,
              result.dropped ? `${result.dropped} empty value(s) dropped` : 'no empty values dropped'
            ],
            warnings: result.dropped
              ? [`${result.dropped} empty cell(s) produced no row. Untick "drop empty values" to keep them.`]
              : []
          };
        }

        const variableColumn = resolveCols(header, values.variableSpec)[0];
        const valueColumn = resolveCols(header, values.valueColSpec)[0];
        if (variableColumn === undefined || valueColumn === undefined) {
          return { summary: `Name the variable and value columns. Headers: ${header.join(', ')}` };
        }

        const result = longToWide(grid, {
          idColumns,
          variableColumn,
          valueColumn,
          aggregate: values.aggregate
        });

        return {
          rows: result.rows,
          name: 'wide',
          summary: [
            `${grid.length - 1} long rows -> ${result.rows.length - 1} wide rows`,
            `${result.variables.length} variable column(s)`
          ],
          changes: [
            `id columns: ${idColumns.map((c) => header[c]).join(', ')}`,
            `new columns: ${result.variables.slice(0, 12).join(', ')}${result.variables.length > 12 ? ` …+${result.variables.length - 12}` : ''}`
          ].concat(
            result.collisions
              .slice(0, 20)
              .map((clash) => `clash at ${clash.key} / ${clash.variable}: kept "${clash.kept}"${clash.discarded ? `, dropped "${clash.discarded}"` : ''}`)
          ),
          warnings: result.collisions.length
            ? [`${result.collisions.length} cell(s) had more than one value for the same id + variable. The full list is in the clash report.`]
            : [],
          extras: result.collisions.length
            ? [
                {
                  label: 'Download clash report',
                  name: 'pivot_clashes',
                  rows: [
                    ['id', 'variable', 'kept', 'discarded'],
                    ...result.collisions.map((c) => [c.key, c.variable, c.kept, c.discarded])
                  ]
                }
              ]
            : []
        };
      }
    });
  }
};
