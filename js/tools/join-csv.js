/**
 * Join two CSVs on a key — group `combine`, order 20.
 *
 * The failure everyone hits is a silent many-to-many fan-out: 40 left rows
 * joined to a right side with duplicate keys quietly becomes 300 rows and the
 * totals stop footing. This reports the fan-out explicitly and lets you export
 * the unmatched keys from either side.
 */
import { buildTool, parseCsvText, rectangularise, normaliseKey, indexOfHeader } from './_shared.js';

function keyValue(value, options) {
  const opts = options || {};
  let cell = value === undefined || value === null ? '' : String(value);
  if (opts.loose) return normaliseKey(cell);
  if (opts.ignoreWhitespace !== false) cell = cell.replace(/\s+/g, ' ').trim();
  if (opts.ignoreCase !== false) cell = cell.toLowerCase();
  return cell;
}

/**
 * Pure.
 * @param left    { name, grid }
 * @param right   { name, grid }
 * @param options { leftKey, rightKey, type:'inner'|'left'|'full', suffix, ignoreCase, ignoreWhitespace, loose }
 */
export function joinGrids(left, right, options) {
  const opts = { type: 'left', suffix: '_right', ignoreCase: true, ignoreWhitespace: true, ...(options || {}) };
  const leftGrid = rectangularise(left.grid);
  const rightGrid = rectangularise(right.grid);
  if (leftGrid.length < 1 || rightGrid.length < 1) throw new Error('Both sides need a header row.');

  const leftHeader = leftGrid[0];
  const rightHeader = rightGrid[0];
  const li = typeof opts.leftKey === 'number' ? opts.leftKey : indexOfHeader(leftHeader, opts.leftKey);
  const ri = typeof opts.rightKey === 'number' ? opts.rightKey : indexOfHeader(rightHeader, opts.rightKey);
  if (li === -1) throw new Error(`Left key column "${opts.leftKey}" is not in the left header.`);
  if (ri === -1) throw new Error(`Right key column "${opts.rightKey}" is not in the right header.`);

  // Right-hand columns other than the key, renamed on collision.
  const leftNames = new Set(leftHeader.map((h) => String(h).trim().toLowerCase()));
  const rightCols = [];
  const renamed = [];
  rightHeader.forEach((label, index) => {
    if (index === ri) return;
    let name = String(label);
    if (leftNames.has(name.trim().toLowerCase())) {
      const next = `${name}${opts.suffix}`;
      renamed.push(`${name} -> ${next}`);
      name = next;
    }
    rightCols.push({ index, name });
  });

  const rightBuckets = new Map();
  rightGrid.slice(1).forEach((row) => {
    const key = keyValue(row[ri], opts);
    if (!rightBuckets.has(key)) rightBuckets.set(key, []);
    rightBuckets.get(key).push(row);
  });

  const blankRight = rightCols.map(() => '');
  const rows = [[...leftHeader, ...rightCols.map((c) => c.name)]];

  let matched = 0;
  let leftOnly = 0;
  let fanout = 0;
  const matchedKeys = new Set();
  const unmatchedLeft = [];

  leftGrid.slice(1).forEach((row, index) => {
    const key = keyValue(row[li], opts);
    const hits = rightBuckets.get(key);
    if (hits && hits.length) {
      matchedKeys.add(key);
      matched += 1;
      if (hits.length > 1) fanout += hits.length - 1;
      hits.forEach((hit) => rows.push([...row, ...rightCols.map((c) => hit[c.index] || '')]));
    } else {
      leftOnly += 1;
      unmatchedLeft.push({ index: index + 1, key: String(row[li] || ''), row });
      if (opts.type !== 'inner') rows.push([...row, ...blankRight]);
    }
  });

  const unmatchedRight = [];
  let rightOnly = 0;
  rightBuckets.forEach((bucket, key) => {
    if (matchedKeys.has(key)) return;
    rightOnly += bucket.length;
    bucket.forEach((row) => {
      unmatchedRight.push({ key: String(row[ri] || ''), row });
      if (opts.type === 'full') {
        const blankLeft = leftHeader.map((_, i) => (i === li ? row[ri] || '' : ''));
        rows.push([...blankLeft, ...rightCols.map((c) => row[c.index] || '')]);
      }
    });
  });

  const dupKeysRight = Array.from(rightBuckets.values()).filter((bucket) => bucket.length > 1).length;

  const changes = [];
  if (renamed.length) changes.push(`renamed colliding right-hand columns: ${renamed.join(', ')}`);
  changes.push(`${matched} left row(s) matched, ${leftOnly} unmatched`);
  if (fanout) changes.push(`fan-out added ${fanout} extra row(s) from duplicate keys on the right`);
  if (opts.type === 'full' && rightOnly) changes.push(`${rightOnly} right-only row(s) added with empty left columns`);
  if (opts.type === 'inner' && leftOnly) changes.push(`inner join dropped ${leftOnly} unmatched left row(s)`);

  const warnings = [];
  if (dupKeysRight) {
    warnings.push(
      `${dupKeysRight} key(s) appear more than once on the right, so the result has ${fanout} more rows than the left side. Sums over this table will double-count.`
    );
  }
  if (opts.type === 'inner' && leftOnly) {
    warnings.push(`${leftOnly} left row(s) were dropped by the inner join. Export the unmatched list before you rely on this.`);
  }

  return {
    rows: rectangularise(rows),
    stats: { matched, leftOnly, rightOnly, fanout, dupKeysRight, out: rows.length - 1 },
    unmatchedLeft,
    unmatchedRight,
    changes,
    warnings
  };
}

export const tool = {
  id: 'join-csv',
  label: 'Join two CSVs',
  group: 'combine',
  order: 20,
  description:
    'Join a left and a right CSV on a key column. Reports unmatched keys on both sides and any many-to-many fan-out.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'join-csv',
      description: tool.description,
      inputs: [
        { name: 'leftSource', kind: 'csv', label: 'Left CSV' },
        { name: 'rightSource', kind: 'csv', label: 'Right CSV' },
        { name: 'leftKey', kind: 'text', label: 'Left key column (name or 1-based number)', placeholder: 'account_code' },
        { name: 'rightKey', kind: 'text', label: 'Right key column (blank = same as left)', placeholder: 'account_code' },
        {
          name: 'type',
          kind: 'select',
          label: 'Join type',
          value: 'left',
          options: [
            { value: 'left', label: 'Left — keep every left row' },
            { value: 'inner', label: 'Inner — matches only' },
            { value: 'full', label: 'Full — keep everything from both sides' }
          ]
        },
        { name: 'suffix', kind: 'text', label: 'Suffix for colliding right-hand column names', value: '_right' },
        { name: 'ignoreCase', kind: 'checkbox', label: 'Ignore case in the key', value: true },
        { name: 'loose', kind: 'checkbox', label: 'Loose key match (ignore punctuation too)', value: false }
      ],

      run(values) {
        const leftGrid = parseCsvText(values.leftSource);
        const rightGrid = parseCsvText(values.rightSource);
        if (leftGrid.length < 2 || rightGrid.length < 2) {
          return { summary: 'Paste or load both CSVs, each with a header row.' };
        }
        if (!String(values.leftKey || '').trim()) {
          return { summary: `Name the key column. Left headers: ${leftGrid[0].join(', ')}` };
        }

        const resolve = (header, spec) => (/^\d+$/.test(String(spec).trim()) ? Number(spec) - 1 : spec);
        const result = joinGrids(
          { name: 'left', grid: leftGrid },
          { name: 'right', grid: rightGrid },
          {
            ...values,
            leftKey: resolve(leftGrid[0], values.leftKey),
            rightKey: resolve(rightGrid[0], String(values.rightKey || '').trim() || values.leftKey)
          }
        );

        const extras = [];
        if (result.unmatchedLeft.length) {
          extras.push({
            label: `Unmatched left (${result.unmatchedLeft.length})`,
            name: 'unmatched_left',
            rows: [['left_row', 'key', ...leftGrid[0]], ...result.unmatchedLeft.map((e) => [String(e.index), e.key, ...e.row])]
          });
        }
        if (result.unmatchedRight.length) {
          extras.push({
            label: `Unmatched right (${result.unmatchedRight.length})`,
            name: 'unmatched_right',
            rows: [['key', ...rightGrid[0]], ...result.unmatchedRight.map((e) => [e.key, ...e.row])]
          });
        }

        return {
          rows: result.rows,
          name: 'joined',
          summary: [
            `${leftGrid.length - 1} left rows`,
            `${rightGrid.length - 1} right rows`,
            `${result.stats.out} out`,
            `${result.stats.matched} matched`
          ],
          changes: result.changes,
          warnings: result.warnings,
          extras
        };
      }
    });
  }
};
