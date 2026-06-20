/**
 * MQL5 String* host helpers — pure, MT5-exact semantics (global CLAUDE.md §21).
 *
 * No I/O. The runtime delegates each `StringXxx(...)` builtin here. The headline
 * piece is `StringFormat`, a faithful C `printf` (MT5's StringFormat is a thin
 * wrapper over the CRT formatter) supporting the specifiers EAs use in practice:
 *   %d %i %u %f %.Nf %e %g %s %x %X %c %%  plus  flags(- + space 0 #),
 *   width, and precision (incl. `*`-by-arg is NOT supported by MT5 → we skip it).
 *
 * Indexing/find return-value contracts mirror MT5 exactly:
 *   - StringFind returns the 0-based index or -1 (not undefined).
 *   - StringSubstr clamps: start past end → "".
 *   - StringReplace replaces ALL occurrences (returns the new string; the count
 *     is available via stringReplaceCount for callers that need MT5's return).
 *   - StringToInteger parses a leading integer (MT5 returns `long`); a non-
 *     numeric string → 0 (NOT NaN — §29: 0 is a valid result, distinct from a
 *     parse error which MT5 also reports as 0).
 */

/** StringLen — number of characters (UTF-16 code units, matching MT5's ushort string). */
export function StringLen(s: string): number {
  return typeof s === 'string' ? s.length : 0;
}

/**
 * StringSubstr(text, start[, length]) — substring of `length` chars from
 * `start`. MT5: omitted/negative length (the EMPTY/WHOLE_ARRAY sentinel) → to
 * end of string. start past end → "". start < 0 is clamped to 0 by MT5.
 */
export function StringSubstr(text: string, start: number, length?: number): string {
  if (typeof text !== 'string') return '';
  const s = Math.max(0, Math.trunc(start));
  if (s >= text.length) return '';
  // MT5: length omitted, or the WHOLE_ARRAY/-1 sentinel → to end.
  if (length === undefined || length < 0) return text.slice(s);
  const len = Math.trunc(length);
  if (len === 0) return '';
  return text.slice(s, s + len);
}

/**
 * StringFind(text, match[, start]) — 0-based index of `match` in `text` at or
 * after `start` (default 0), or -1 if not found. MT5 start<0 → 0.
 */
export function StringFind(text: string, match: string, start?: number): number {
  if (typeof text !== 'string' || typeof match !== 'string') return -1;
  const from = start === undefined ? 0 : Math.max(0, Math.trunc(start));
  return text.indexOf(match, from);
}

/**
 * StringReplace — replace EVERY occurrence of `find` with `replacement`.
 * Returns the resulting string. (MT5's StringReplace mutates the string in
 * place and RETURNS THE COUNT of replacements; since TS strings are immutable
 * the runtime assigns the returned string back and can read the count via
 * `stringReplaceCount`.) An empty `find` yields the original string unchanged
 * (MT5 returns -1/no-op for an empty search; we keep the text untouched).
 */
export function StringReplace(text: string, find: string, replacement: string): string {
  if (typeof text !== 'string') return text;
  if (typeof find !== 'string' || find.length === 0) return text;
  return text.split(find).join(replacement ?? '');
}

/** Count of replacements StringReplace would make (MT5's actual return value). */
export function stringReplaceCount(text: string, find: string): number {
  if (typeof text !== 'string' || typeof find !== 'string' || find.length === 0) {
    return 0;
  }
  return text.split(find).length - 1;
}

/**
 * StringToDouble — parse a leading floating-point number from `text`. MT5 parses
 * a leading numeric token and ignores trailing non-numeric chars; a string with
 * no leading number → 0.0 (NOT NaN — §29). Accepts leading whitespace, sign,
 * decimal point, and exponent.
 */
export function StringToDouble(text: string): number {
  if (typeof text !== 'string') return 0;
  const m = text.match(/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/);
  if (!m) return 0;
  const v = Number.parseFloat(m[0]);
  return Number.isNaN(v) ? 0 : v;
}

/**
 * StringToInteger — parse a leading integer from `text` (MT5 returns `long`).
 * Leading whitespace + optional sign + digits; stops at the first non-digit.
 * No leading number → 0 (§29: a valid 0, distinct from the absence of input).
 */
export function StringToInteger(text: string): number {
  if (typeof text !== 'string') return 0;
  const m = text.match(/^\s*[-+]?\d+/);
  if (!m) return 0;
  const v = Number.parseInt(m[0], 10);
  return Number.isNaN(v) ? 0 : v;
}

// ─────────────────────────────────────────────────────────────────────────
// StringFormat — faithful C/printf formatter (MT5 wraps the CRT formatter).
// ─────────────────────────────────────────────────────────────────────────

/**
 * StringFormat(format, ...args) — printf-style formatting.
 *
 * Supported conversion specifiers (the set MQL5 EAs use):
 *   %d %i  signed decimal integer
 *   %u     unsigned decimal integer
 *   %x %X  hexadecimal (lower / upper)
 *   %o     octal
 *   %f %F  fixed-point float (default precision 6, like C)
 *   %e %E  scientific
 *   %g %G  shortest of %e/%f
 *   %s     string
 *   %c     single character (from a char code or first char of a string)
 *   %%     a literal percent
 * Flags: '-' (left-justify), '+' (always sign), ' ' (space for positive),
 *        '0' (zero-pad), '#' (alt form for x/o). Width and `.precision`.
 * Length modifiers (l, ll, h, I64, etc.) are accepted and ignored (JS numbers
 * cover the range EAs format).
 */
export function StringFormat(format: string, ...args: unknown[]): string {
  if (typeof format !== 'string') return '';

  let argi = 0;
  const re = /%([-+ 0#]*)(\d+)?(?:\.(\d+))?(?:hh|h|ll|l|L|j|z|t|I64|I32|I)?([diouxXeEfFgGscn%])/g;

  return format.replace(
    re,
    (
      _whole: string,
      flags: string,
      widthStr: string | undefined,
      precStr: string | undefined,
      conv: string,
    ): string => {
      if (conv === '%') return '%';

      const width = widthStr !== undefined ? parseInt(widthStr, 10) : undefined;
      const precision = precStr !== undefined ? parseInt(precStr, 10) : undefined;
      const arg = args[argi++];

      let body: string;
      let isNumeric = false;
      let negative = false;

      switch (conv) {
        case 'd':
        case 'i': {
          isNumeric = true;
          let n = Math.trunc(toNum(arg));
          negative = n < 0 || Object.is(n, -0);
          body = Math.abs(n).toString(10);
          break;
        }
        case 'u': {
          isNumeric = true;
          // unsigned 32-bit (printf %u). MT5 uint is 32-bit.
          const n = Math.trunc(toNum(arg)) >>> 0;
          body = n.toString(10);
          break;
        }
        case 'o': {
          isNumeric = true;
          const n = Math.trunc(toNum(arg)) >>> 0;
          body = (flags.includes('#') ? '0' : '') + n.toString(8);
          break;
        }
        case 'x':
        case 'X': {
          isNumeric = true;
          const n = Math.trunc(toNum(arg)) >>> 0;
          let hex = n.toString(16);
          if (conv === 'X') hex = hex.toUpperCase();
          if (flags.includes('#') && n !== 0) hex = (conv === 'X' ? '0X' : '0x') + hex;
          body = hex;
          break;
        }
        case 'f':
        case 'F': {
          isNumeric = true;
          const v = toNum(arg);
          negative = v < 0 || Object.is(v, -0);
          const p = precision === undefined ? 6 : precision;
          body = Math.abs(v).toFixed(p);
          break;
        }
        case 'e':
        case 'E': {
          isNumeric = true;
          const v = toNum(arg);
          negative = v < 0 || Object.is(v, -0);
          const p = precision === undefined ? 6 : precision;
          body = fixExponent(Math.abs(v).toExponential(p), conv === 'E');
          break;
        }
        case 'g':
        case 'G': {
          isNumeric = true;
          const v = toNum(arg);
          negative = v < 0 || Object.is(v, -0);
          // C %g: precision = significant digits (default 6, 0 treated as 1).
          let p = precision === undefined ? 6 : precision;
          if (p === 0) p = 1;
          body = formatG(Math.abs(v), p, conv === 'G');
          break;
        }
        case 'c': {
          // char from a code or the first char of a string.
          if (typeof arg === 'string') body = arg.length > 0 ? arg[0]! : '';
          else body = String.fromCharCode(Math.trunc(toNum(arg)) & 0xffff);
          break;
        }
        case 's': {
          body = stringifyArg(arg);
          if (precision !== undefined) body = body.slice(0, precision);
          break;
        }
        case 'n': {
          // %n is unsupported/dangerous; MT5 ignores it. Emit nothing.
          argi--; // %n consumes no positional value in our model
          return '';
        }
        default:
          return _whole;
      }

      // Assemble sign prefix for numeric conversions.
      let sign = '';
      if (isNumeric) {
        if (negative) sign = '-';
        else if (flags.includes('+')) sign = '+';
        else if (flags.includes(' ')) sign = ' ';
      }

      // Apply width with padding.
      if (width !== undefined && sign.length + body.length < width) {
        const pad = width - sign.length - body.length;
        if (flags.includes('-')) {
          // left-justify → pad on the right with spaces (0-flag ignored with '-')
          return sign + body + ' '.repeat(pad);
        }
        if (flags.includes('0') && isNumeric && conv !== 's' && conv !== 'c') {
          // zero-pad between sign and digits
          return sign + '0'.repeat(pad) + body;
        }
        return ' '.repeat(pad) + sign + body;
      }
      return sign + body;
    },
  );
}

/** C %g formatting: trim per significant-digit rule, drop trailing zeros. */
function formatG(v: number, sig: number, upper: boolean): string {
  if (v === 0) return '0';
  const exp = Math.floor(Math.log10(v));
  let out: string;
  if (exp < -4 || exp >= sig) {
    // scientific, sig-1 digits after the point, then strip trailing zeros
    out = v.toExponential(sig - 1);
    out = stripExpZeros(out);
    out = fixExponent(out, upper);
  } else {
    // fixed, (sig - 1 - exp) digits after the point, then strip trailing zeros
    const decimals = Math.max(0, sig - 1 - exp);
    out = v.toFixed(decimals);
    if (out.includes('.')) out = out.replace(/\.?0+$/, '');
  }
  return upper ? out.toUpperCase() : out;
}

/** Strip trailing zeros from the mantissa of a JS exponential string. */
function stripExpZeros(s: string): string {
  const m = s.match(/^(\d)(?:\.(\d+))?e([-+]\d+)$/i);
  if (!m) return s;
  let frac = m[2] ?? '';
  frac = frac.replace(/0+$/, '');
  const mant = frac.length > 0 ? `${m[1]}.${frac}` : m[1]!;
  return `${mant}e${m[3]}`;
}

/**
 * Normalize JS `toExponential` output to C printf form: C uses a 2-digit
 * (min) exponent ("1.00e+05"), JS may emit 1 digit ("1.00e+5").
 */
function fixExponent(s: string, upper: boolean): string {
  let out = s.replace(/e([-+])(\d+)/i, (_m, sgn: string, digits: string) => {
    const d = digits.length < 2 ? digits.padStart(2, '0') : digits;
    return `e${sgn}${d}`;
  });
  if (upper) out = out.replace(/e/i, 'E');
  else out = out.replace(/E/, 'e');
  return out;
}

/** Coerce an arg to a number for numeric conversions (booleans → 0/1). */
function toNum(arg: unknown): number {
  if (typeof arg === 'number') return arg;
  if (typeof arg === 'bigint') return Number(arg);
  if (typeof arg === 'boolean') return arg ? 1 : 0;
  if (typeof arg === 'string') {
    const v = Number(arg);
    return Number.isNaN(v) ? 0 : v;
  }
  return 0;
}

/** Coerce an arg to a string for %s (MT5 stringifies numbers/bools sensibly). */
function stringifyArg(arg: unknown): string {
  if (arg === null || arg === undefined) return '';
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'boolean') return arg ? 'true' : 'false';
  return String(arg);
}
