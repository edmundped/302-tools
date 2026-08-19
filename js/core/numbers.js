/**
 * core/numbers.js — the single source of truth for number parsing.
 *
 * No other module may parse numbers. See docs/ARCHITECTURE.md § Numbers.
 *
 * The distinction that matters in financial statements:
 *   '-'      => not applicable  => value null, clean '' (NEVER 0)
 *   '0'      => zero            => value 0,    clean '0'
 *   '(1,204)'=> negative        => value -1204
 */

/** Every dash-ish codepoint that can appear as a "nil" marker in a statement. */
export const DASH_CHARS = '-‐‑‒–—―⁃−﹘﹣－';

const NIL_RE = new RegExp(`^[${DASH_CHARS}\\s]+$`);
const MINUS_RE = new RegExp(`[${DASH_CHARS}]`);

/** Currency symbols and ISO-ish codes seen in Ghanaian / West African reports. */
const CURRENCY_TOKENS = [
  { re: /GH[¢C₵]/gi, code: 'GHS' },
  { re: /\bGHS\b/gi, code: 'GHS' },
  { re: /\bUSD\b|\bUS\$/gi, code: 'USD' },
  { re: /\bGBP\b/gi, code: 'GBP' },
  { re: /\bEUR\b/gi, code: 'EUR' },
  { re: /\bNGN\b/gi, code: 'NGN' },
  { re: /\bZAR\b/gi, code: 'ZAR' },
  { re: /₵/g, code: 'GHS' },
  { re: /₦/g, code: 'NGN' },
  { re: /\$/g, code: 'USD' },
  { re: /£/g, code: 'GBP' },
  { re: /€/g, code: 'EUR' },
  { re: /¥/g, code: 'JPY' },
  { re: /¢/g, code: null }
];

/** Footnote markers that get glued onto printed figures. */
const FOOTNOTE_RE = /[*∗٭†‡§¶#]+$|[¹²³⁰-⁹ᵃ-ᵢ]+$/u;

/** Characters used as thousands separators that are never decimal points. */
const SOFT_SEPARATORS = /[\s    '’ʼ]/g;

const EMPTY = Object.freeze({
  raw: '',
  value: null,
  clean: '',
  isNumeric: false,
  isNegative: false,
  isPercent: false,
  hadParens: false,
  isNil: false,
  currency: null,
  footnote: null,
  warnings: Object.freeze([])
});

function blank(raw) {
  return { ...EMPTY, raw, warnings: [] };
}

/**
 * Canonical numeric string with float noise removed.
 * 12.3% -> 0.123 rather than 0.12300000000000001.
 */
function canonical(value) {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  const trimmed = Number(value.toPrecision(12));
  return String(Object.is(trimmed, -0) ? 0 : trimmed);
}

/**
 * Resolve which of `.` / `,` is the decimal separator.
 * European format is only assumed when it is unambiguous; otherwise we default
 * to Anglo and record a warning rather than guessing silently.
 */
function resolveSeparators(s, warnings) {
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // 1.234,56 — European
      if (!/^\d{1,3}(\.\d{3})*,\d+$/.test(s)) {
        warnings.push(`ambiguous separators in "${s}"; read as European decimal`);
      }
      return s.replace(/\./g, '').replace(',', '.');
    }
    // 1,234.56 — Anglo
    if (!/^\d{1,3}(,\d{3})*\.\d+$/.test(s)) {
      warnings.push(`ambiguous separators in "${s}"; read as Anglo decimal`);
    }
    return s.replace(/,/g, '');
  }

  if (lastComma >= 0) {
    if (/^\d{1,3}(,\d{3})+$/.test(s)) return s.replace(/,/g, ''); // 12,442,697
    if (/^\d+,\d{1,2}$/.test(s)) {
      warnings.push(`"${s}" read as European decimal`);
      return s.replace(',', '.');
    }
    warnings.push(`irregular comma grouping in "${s}"; commas dropped`);
    return s.replace(/,/g, '');
  }

  if (lastDot >= 0) {
    const dots = (s.match(/\./g) || []).length;
    if (dots > 1) {
      if (/^\d{1,3}(\.\d{3})+$/.test(s)) return s.replace(/\./g, ''); // 1.234.567
      warnings.push(`irregular dot grouping in "${s}"; dots dropped`);
      return s.replace(/\./g, '');
    }
    return s; // single dot: Anglo decimal (1.234 stays 1.234)
  }

  return s;
}

/**
 * parseNumber(raw) -> {
 *   value, clean, isNumeric, isNegative, isPercent, hadParens, isNil,
 *   currency, footnote, raw, warnings
 * }
 */
export function parseNumber(raw) {
  const original = raw === null || raw === undefined ? '' : String(raw);
  const out = blank(original);

  let s = original.replace(/[  ]/g, ' ').trim();
  if (!s) return out;

  // '-', '–', '—' alone: not applicable. Empty, never zero.
  if (NIL_RE.test(s)) {
    out.isNil = true;
    return out;
  }

  // Parentheses negative — may be doubled with a currency symbol inside.
  const parens = s.match(/^\(\s*([\s\S]*?)\s*\)$/);
  if (parens) {
    out.hadParens = true;
    out.isNegative = true;
    s = parens[1].trim();
    if (!s || NIL_RE.test(s)) {
      out.isNil = true;
      out.isNegative = false;
      out.hadParens = true;
      return out;
    }
  }

  // Currency symbols / codes anywhere in the token.
  for (const { re, code } of CURRENCY_TOKENS) {
    re.lastIndex = 0;
    if (re.test(s)) {
      if (code && !out.currency) out.currency = code;
      s = s.replace(re, '');
      re.lastIndex = 0;
    }
  }
  s = s.trim();

  // Percent.
  if (/%\s*$/.test(s)) {
    out.isPercent = true;
    s = s.replace(/%\s*$/, '').trim();
  }

  // Footnote marker glued to the value: 1,234²  1,234*
  const foot = s.match(FOOTNOTE_RE);
  if (foot && /\d/.test(s.slice(0, foot.index))) {
    out.footnote = foot[0];
    out.warnings.push(`footnote marker "${foot[0]}" stripped from "${original.trim()}"`);
    s = s.slice(0, foot.index).trim();
  }

  // Trailing minus (1234-) and unicode minus.
  if (s.length > 1 && MINUS_RE.test(s.slice(-1))) {
    out.isNegative = !out.isNegative;
    s = s.slice(0, -1).trim();
  }
  if (s.length > 0 && MINUS_RE.test(s[0])) {
    out.isNegative = !out.isNegative;
    s = s.slice(1).trim();
  } else if (s[0] === '+') {
    s = s.slice(1).trim();
  }

  // Space / apostrophe thousands separators.
  s = s.replace(SOFT_SEPARATORS, '');

  if (!s) return out;
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return out;

  const normalised = resolveSeparators(s, out.warnings);
  if (!/^\d*\.?\d+$/.test(normalised) && !/^\d+\.?\d*$/.test(normalised)) return out;

  let value = Number(normalised);
  if (!Number.isFinite(value)) return out;

  if (out.isNegative) value = -value;
  if (out.isPercent) value = Number((value / 100).toPrecision(12));

  out.value = value;
  out.isNumeric = true;
  out.isNegative = value < 0;
  out.clean = canonical(value);
  return out;
}

/** True when the cell holds a real figure. */
export function isNumericCell(raw) {
  return parseNumber(raw).isNumeric;
}

/** True when the cell is a dash meaning "not applicable". */
export function isNilCell(raw) {
  return parseNumber(raw).isNil;
}

/** A cell that participates in a numeric column: a figure or an explicit nil. */
export function isFigureCell(raw) {
  const p = parseNumber(raw);
  return p.isNumeric || p.isNil;
}

/** Canonical numeric string, or '' when not numeric. */
export function cleanValue(raw) {
  return parseNumber(raw).clean;
}

/** Year / period label such as 2011, FY2011, 2011/12 — a header, not a figure. */
export function isPeriodLabel(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return false;
  if (/^(FY\s*)?(19|20)\d{2}$/i.test(s)) return true;
  if (/^(19|20)\d{2}\s*[/-]\s*\d{2,4}$/.test(s)) return true;
  if (/^(19|20)\d{2}\s*(restated|audited|unaudited|actual|budget|proforma)$/i.test(s)) return true;
  return false;
}

/**
 * Sum a list of raw cells. Nils contribute nothing but do not invalidate the sum.
 * Returns { sum, count, nils, skipped } — `count` is the number of real figures.
 */
export function sumCells(cells) {
  let sum = 0;
  let count = 0;
  let nils = 0;
  let skipped = 0;
  for (const cell of cells) {
    const p = parseNumber(cell);
    if (p.isNumeric) {
      sum += p.value;
      count += 1;
    } else if (p.isNil) {
      nils += 1;
    } else if (String(cell ?? '').trim()) {
      skipped += 1;
    }
  }
  return { sum: Number(sum.toPrecision(12)), count, nils, skipped };
}

/** Scale words found in captions: 'GH¢000' -> 1000. */
export function unitScale(unitLabel) {
  const s = String(unitLabel || '').toLowerCase();
  if (/billion|bn\b/.test(s)) return 1e9;
  if (/million|'?000'?000|m\b/.test(s)) return 1e6;
  if (/thousand|'?000\b/.test(s)) return 1e3;
  return 1;
}

export default { parseNumber, isNumericCell, isNilCell, isFigureCell, cleanValue, isPeriodLabel, sumCells, unitScale };
