/**
 * MQL5 conversion host helpers — pure, MT5-exact semantics (global CLAUDE.md §21).
 *
 *   DoubleToString(value, digits)        — number → text
 *   IntegerToString(value, width, fill)  — integer → text, optional padding
 *   TimeToString(datetime, flags)        — MT5 datetime (sec since epoch) → text
 *   PrintFormat(format, ...args)         — StringFormat + print to stdout
 *
 * `PrintFormat` is the ONE helper here that performs output; it reuses the pure
 * `StringFormat` from ./str. The rest are pure value→string conversions.
 */

import { StringFormat } from './str';

/**
 * DoubleToString(value, digits=8) — format a double.
 *
 * MT5 contract:
 *   - digits in [0, 16]  → fixed-point with exactly `digits` fractional digits.
 *   - digits omitted     → 8 (MT5's documented default).
 *   - digits < 0         → the number of SIGNIFICANT digits in scientific
 *                          notation, |digits| significant figures
 *                          (e.g. DoubleToString(1.23456, -4) = "1.235e+00").
 *
 * Rounding is round-half-away-from-zero (toFixed/toPrecision round half-up for
 * positive magnitudes, matching MT5 for the magnitudes EAs format).
 */
export function DoubleToString(value: number, digits: number = 8): number | string {
  if (typeof value !== 'number') value = Number(value) || 0;
  const d = Math.trunc(digits);

  if (!Number.isFinite(value)) {
    // MT5 prints "nan"/"inf"; mirror the lower-case CRT form.
    if (Number.isNaN(value)) return 'nan';
    return value > 0 ? 'inf' : '-inf';
  }

  if (d < 0) {
    // significant-digits scientific form. |d| sig figs → toExponential(|d|-1).
    const sig = Math.min(17, Math.abs(d));
    const p = Math.max(0, sig - 1);
    const sign = value < 0 || Object.is(value, -0) ? '-' : '';
    let s = Math.abs(value).toExponential(p);
    // normalize exponent to a 2-digit minimum (C/MT5 style: e+00).
    s = s.replace(/e([-+])(\d+)/i, (_m, sgn: string, dig: string) => {
      const dd = dig.length < 2 ? dig.padStart(2, '0') : dig;
      return `e${sgn}${dd}`;
    });
    return sign + s;
  }

  // fixed-point. Clamp to MT5's documented 0..16 range.
  const fd = Math.min(16, d);
  return value.toFixed(fd);
}

/**
 * IntegerToString(value, str_len=0, fill_symbol='0') — integer → text, optionally
 * padded on the LEFT to `str_len` characters with `fill_symbol`.
 *
 * MT5: if the formatted number is already >= str_len chars, no padding. The
 * sign counts toward the width. For a ZERO-padded negative the sign LEADS and
 * the zeros go between the sign and the digits (`-0042`, like printf `%05d`),
 * NOT `00-42`. For any other fill (e.g. space) the whole rendered text is
 * left-padded (`  -42`). `fill_symbol` is a CHAR CODE in MQL5 (ushort); MT5's
 * documented default is '0' (0x30). We accept a single-char string or a char
 * code for ergonomics; default '0'.
 */
export function IntegerToString(
  value: number,
  strLen: number = 0,
  fillSymbol: number | string = '0',
): string {
  const n = Math.trunc(Number(value) || 0);
  const text = n.toString(10);
  const width = Math.trunc(strLen);
  if (!(width > text.length)) return text;

  const fill = resolveFill(fillSymbol);
  if (n < 0 && fill === '0') {
    // Zero-pad keeps the sign at the front: '-' + zero-padded magnitude.
    return '-' + text.slice(1).padStart(width - 1, '0');
  }
  return text.padStart(width, fill);
}

function resolveFill(fillSymbol: number | string): string {
  if (typeof fillSymbol === 'number') {
    const code = Math.trunc(fillSymbol) & 0xffff;
    return code === 0 ? '0' : String.fromCharCode(code);
  }
  if (typeof fillSymbol === 'string' && fillSymbol.length > 0) return fillSymbol[0]!;
  return '0';
}

// ── TimeToString ──────────────────────────────────────────────────────────

/** MT5 TIME_* flags (kernel constants; values per MQL5 docs). */
export const TIME_DATE = 1;
export const TIME_MINUTES = 2;
export const TIME_SECONDS = 4;

/**
 * TimeToString(datetime, flags=TIME_DATE|TIME_MINUTES) — MT5 datetime (seconds
 * since the 1970 epoch, UTC) → text. The flags select which parts appear:
 *   TIME_DATE     → "YYYY.MM.DD"
 *   TIME_MINUTES  → "HH:MM"
 *   TIME_SECONDS  → "HH:MM:SS"
 * Default (flags omitted) = TIME_DATE|TIME_MINUTES → "YYYY.MM.DD HH:MM".
 * If both TIME_MINUTES and TIME_SECONDS are set, MT5 prints "HH:MM:SS".
 * MT5 datetime has no timezone — it is the broker's clock value; we render the
 * UTC fields of the epoch-seconds so the string is the literal calendar value.
 */
export function TimeToString(
  datetime: number,
  flags: number = TIME_DATE | TIME_MINUTES,
): string {
  const secs = Math.trunc(Number(datetime) || 0);
  const date = new Date(secs * 1000);

  const yyyy = date.getUTCFullYear();
  const MM = pad2(date.getUTCMonth() + 1);
  const DD = pad2(date.getUTCDate());
  const HH = pad2(date.getUTCHours());
  const mm = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());

  // MT5: if neither date nor any time bit is set, it defaults to date+minutes.
  let f = Math.trunc(flags);
  if ((f & (TIME_DATE | TIME_MINUTES | TIME_SECONDS)) === 0) {
    f = TIME_DATE | TIME_MINUTES;
  }

  const parts: string[] = [];
  if (f & TIME_DATE) parts.push(`${yyyy}.${MM}.${DD}`);

  // Seconds bit implies a full HH:MM:SS; minutes-only → HH:MM.
  if (f & TIME_SECONDS) parts.push(`${HH}:${mm}:${ss}`);
  else if (f & TIME_MINUTES) parts.push(`${HH}:${mm}`);

  return parts.join(' ');
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

// ── PrintFormat ─────────────────────────────────────────────────────────────

/**
 * PrintFormat(format, ...args) — format like StringFormat and print to stdout
 * (the MT5 Experts log). Returns void (MT5 PrintFormat is `void`). The actual
 * sink is injectable so the runtime can route it; default writes to
 * `process.stdout` like the runtime's `Print`.
 */
export function PrintFormat(
  format: string,
  ...args: unknown[]
): void {
  const line = StringFormat(format, ...args);
  process.stdout.write(line + '\n');
}

/**
 * Pure variant — returns the formatted line WITHOUT printing. Handy for the
 * runtime to wire its own sink (e.g. route to a captured log) and for tests to
 * assert the formatting without stdout side effects.
 */
export function formatLine(format: string, ...args: unknown[]): string {
  return StringFormat(format, ...args);
}
