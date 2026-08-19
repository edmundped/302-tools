/**
 * Foot check — group `verify`, order 10.
 *
 * Sum a column and compare it to the total that is printed on the page. This is
 * the check core/csv.js's `check_total` column exists to support, and it is the
 * single most useful thing in the bench for a scanned annual report: if the
 * column does not foot, OCR misread a digit.
 *
 * Two ways to supply the expected figure: type it, or let the tool find the row
 * whose label reads like a total and use the printed value from that row.
 */
import { buildTool, requireNumbers, parseCsvText, rectangularise, indexOfHeader } from './_shared.js';

export const TOTAL_LABEL = /^\s*(total|sub-?total|net\b|grand\s+total)/i;

/** Pure: is this row label a printed total? */
export function isTotalLabel(label) {
  return TOTAL_LABEL.test(String(label || ''));
}

/**
 * Pure (given an injected parser): foot one list of raw values.
 * @returns { count, sum, skipped:[{index,raw}] }
 */
export function footColumn(rawValues, parseNumber) {
  let sum = 0;
  let count = 0;
  const skipped = [];
  rawValues.forEach((raw, index) => {
    const text = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!text) return;
    const parsed = parseNumber(text);
    if (parsed.value === null) {
      skipped.push({ index, raw: text });
      return;
    }
    sum += parsed.value;
    count += 1;
  });
  return { count, sum, skipped };
}

/** Pure: compare and classify. */
export function compareTotals(sum, expected, tolerance) {
  if (expected === null || expected === undefined || Number.isNaN(expected)) {
    return { difference: null, status: 'no expected total given' };
  }
  const difference = sum - expected;
  const tol = Number(tolerance) || 0;
  if (Math.abs(difference) <= tol) return { difference, status: 'FOOTS' };
  // A difference that is exactly a power of ten, or twice one entry, is a
  // recognisable OCR/transcription pattern — worth saying out loud.
  const hint =
    Math.abs(difference) && Math.abs(difference) % 9 === 0
      ? 'DOES NOT FOOT (difference divisible by 9 — often two transposed digits)'
      : 'DOES NOT FOOT';
  return { difference, status: hint };
}

function round(value) {
  return Number(Number(value).toPrecision(15));
}

export const tool = {
  id: 'foot-check',
  label: 'Foot check',
  group: 'verify',
  order: 10,
  description:
    'Sum a column and compare it against the printed total. Shows the difference, flags the mismatch, and names any cell it could not read.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'foot-check',
      description: tool.description,
      inputs: [
        {
          name: 'source',
          kind: 'csv',
          label: 'A numeric column (one value per line) or a CSV table',
          placeholder: '12,442,697\n(1,234)\n8 900\n–'
        },
        {
          name: 'mode',
          kind: 'select',
          label: 'Input is',
          value: 'lines',
          options: [
            { value: 'lines', label: 'One value per line' },
            { value: 'csv', label: 'A CSV table — foot each numeric column' }
          ]
        },
        {
          name: 'columns',
          kind: 'text',
          label: 'CSV mode: columns to foot (blank = every column that parses as numeric)',
          placeholder: '2011, 2010'
        },
        {
          name: 'expectedFrom',
          kind: 'select',
          label: 'Expected total comes from',
          value: 'typed',
          options: [
            { value: 'typed', label: 'The figure I type below' },
            { value: 'totalRow', label: 'The row labelled Total / Subtotal / Net (CSV mode)' }
          ]
        },
        { name: 'expected', kind: 'text', label: 'Expected total', placeholder: '12,442,697' },
        { name: 'tolerance', kind: 'text', label: 'Tolerance (absolute)', value: '0' }
      ],

      async run(values) {
        const parseNumber = await requireNumbers();
        const tolerance = parseNumber(values.tolerance || '0').value || 0;

        if (values.mode === 'lines') {
          const lines = String(values.source || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          if (!lines.length) return { summary: 'Paste the column you want to foot.' };

          const footed = footColumn(lines, parseNumber);
          const expectedParsed = parseNumber(values.expected || '');
          const verdict = compareTotals(footed.sum, expectedParsed.value, tolerance);

          const rows = [
            ['metric', 'value'],
            ['values counted', String(footed.count)],
            ['values skipped (not numeric)', String(footed.skipped.length)],
            ['computed sum', String(round(footed.sum))],
            ['expected total', expectedParsed.value === null ? '' : String(expectedParsed.value)],
            ['difference', verdict.difference === null ? '' : String(round(verdict.difference))],
            ['status', verdict.status]
          ];

          return {
            rows,
            name: 'foot_check',
            summary: [
              `sum ${round(footed.sum)}`,
              expectedParsed.value === null ? 'no expected total' : `expected ${expectedParsed.value}`,
              verdict.status
            ],
            changes: [
              `summed ${footed.count} of ${lines.length} pasted value(s)`,
              ...footed.skipped.slice(0, 15).map((s) => `line ${s.index + 1} skipped, not numeric: "${s.raw}"`)
            ],
            warnings:
              verdict.status.startsWith('DOES NOT FOOT')
                ? [`Difference of ${round(verdict.difference)}. Re-read the source figures before publishing.`]
                : footed.skipped.length
                ? [`${footed.skipped.length} value(s) were not numeric and were left out of the sum.`]
                : []
          };
        }

        const grid = parseCsvText(values.source);
        if (grid.length < 2) return { summary: 'Paste a CSV with a header row and at least one data row.' };
        const header = rectangularise(grid)[0];
        const body = rectangularise(grid).slice(1);

        const requested = String(values.columns || '')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => (/^\d+$/.test(part) ? Number(part) - 1 : indexOfHeader(header, part)))
          .filter((index) => index >= 0 && index < header.length);

        const totalRowIndex = body.findIndex((row) => isTotalLabel(row[0]));
        const dataRows = body.filter((_, index) => index !== totalRowIndex);

        const candidates = requested.length
          ? requested
          : header
              .map((_, index) => index)
              .filter((index) => {
                const numeric = dataRows.filter((row) => String(row[index] || '').trim() && parseNumber(row[index]).value !== null);
                return numeric.length >= Math.max(2, Math.ceil(dataRows.length * 0.5));
              });

        if (!candidates.length) {
          return { summary: `No numeric column found. Headers: ${header.join(', ')}` };
        }

        const typed = parseNumber(values.expected || '');
        const rows = [
          ['column', 'values_counted', 'computed_sum', 'expected', 'difference', 'status', 'expected_source']
        ];
        const changes = [];
        const warnings = [];

        candidates.forEach((index) => {
          const footed = footColumn(dataRows.map((row) => row[index]), parseNumber);
          let expected = null;
          let expectedSource = 'none';
          if (values.expectedFrom === 'totalRow' && totalRowIndex !== -1) {
            const printed = parseNumber(body[totalRowIndex][index]);
            expected = printed.value;
            expectedSource = `printed row "${body[totalRowIndex][0]}"`;
          } else if (typed.value !== null) {
            expected = typed.value;
            expectedSource = 'typed';
          }
          const verdict = compareTotals(footed.sum, expected, tolerance);
          rows.push([
            header[index] || `column_${index + 1}`,
            String(footed.count),
            String(round(footed.sum)),
            expected === null ? '' : String(expected),
            verdict.difference === null ? '' : String(round(verdict.difference)),
            verdict.status,
            expectedSource
          ]);
          if (verdict.status.startsWith('DOES NOT FOOT')) {
            warnings.push(`${header[index]}: computed ${round(footed.sum)} vs printed ${expected} — off by ${round(verdict.difference)}.`);
          }
          footed.skipped.slice(0, 5).forEach((skip) => {
            changes.push(`${header[index]} row ${skip.index + 1}: "${skip.raw}" is not numeric, left out of the sum`);
          });
        });

        if (values.expectedFrom === 'totalRow' && totalRowIndex === -1) {
          warnings.push('No row label matched total / subtotal / net, so there was nothing to compare against.');
        }

        return {
          rows,
          name: 'foot_check',
          summary: [
            `${candidates.length} column(s) footed`,
            `${dataRows.length} data row(s)`,
            totalRowIndex === -1 ? 'no printed total row found' : `printed total row: "${body[totalRowIndex][0]}"`
          ],
          changes: changes.length ? changes : ['every cell in the footed columns parsed as a number'],
          warnings
        };
      }
    });
  }
};
