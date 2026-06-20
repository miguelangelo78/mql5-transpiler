/**
 * Human-readable backtest-report printer, shared by the `poc` and `backtest`
 * CLIs. Pure formatting — takes a BacktestReport (engine/types.ts) and returns
 * a string; the caller decides where to write it.
 *
 * The output has three sections:
 *   - a header (symbol / timeframe / bars / transpiled-TS path if supplied)
 *   - a trade log: one row per deal (time, side, kind, volume, price, profit,
 *     balance-after)
 *   - a summary: deals, round-trip trades, wins/losses/win-rate, net profit,
 *     final balance/equity, max drawdown.
 *
 * §29: a 0 value is real (a 0-profit break-even deal, a 0 net result, a 0
 * drawdown) and is printed as `0`, never blanked or treated as "missing".
 */

import type { BacktestReport, BacktestDeal } from './types';

export interface PrintReportOptions {
  /** Path of the emitted TypeScript module (shown in the header). */
  transpiledPath?: string;
  /** Human label for the timeframe (e.g. "M15"); falls back to the raw number. */
  timeframeLabel?: string;
}

/** Format an epoch-seconds time as a compact UTC `YYYY-MM-DD HH:MM` stamp. */
function fmtTime(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return String(epochSeconds);
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

/** Fixed-precision number for a price column (5 dp = FX-ish). */
function fmtPrice(v: number): string {
  return v.toFixed(5);
}

/** Signed money to 2 dp (so -0.00 collapses to 0.00). */
function fmtMoney(v: number): string {
  const r = Object.is(v, -0) ? 0 : v;
  return r.toFixed(2);
}

function fmtVolume(v: number): string {
  return v.toFixed(2);
}

/** Right-pad to `w`. */
function padRight(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** Left-pad to `w`. */
function padLeft(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function dealRow(d: BacktestDeal): string {
  const time = padRight(fmtTime(d.time), 16);
  const side = padRight(d.side, 4);
  const kind = padRight(d.kind, 5);
  const vol = padLeft(fmtVolume(d.volume), 6);
  const price = padLeft(fmtPrice(d.price), 11);
  const profit = padLeft(fmtMoney(d.profit), 11);
  const bal = padLeft(fmtMoney(d.balanceAfter), 12);
  // The deal's note carries WHY this leg happened, when the matching engine sets
  // it: a pending fill is tagged (e.g. `[buyLimit fill]`), an SL/TP exit is
  // `[sl]`/`[tp]`, a market open/close carries the EA's own comment (often ''). A
  // blank note is printed blank (§29: an empty note is real, never invented).
  const note = d.comment ?? '';
  return `  ${time} ${side} ${kind} ${vol} ${price} ${profit} ${bal}  ${note}`;
}

/**
 * Render the full report to a string.
 */
export function formatReport(report: BacktestReport, opts: PrintReportOptions = {}): string {
  const lines: string[] = [];
  const tf = opts.timeframeLabel ?? String(report.timeframe);

  lines.push('══════════════════════════════════════════════════════════════════════');
  lines.push(' Backtest Report');
  lines.push('══════════════════════════════════════════════════════════════════════');
  if (opts.transpiledPath !== undefined) {
    lines.push(` Transpiled TS : ${opts.transpiledPath}`);
  }
  lines.push(` Symbol        : ${report.symbol}`);
  lines.push(` Timeframe     : ${tf}`);
  lines.push(` Bars processed: ${report.barsProcessed}`);
  lines.push('');

  // ── Trade log ──
  lines.push('── Trade Log ─────────────────────────────────────────────────────────');
  if (report.deals.length === 0) {
    lines.push('  (no deals)');
  } else {
    lines.push(
      '  ' +
        padRight('time', 16) +
        ' ' +
        padRight('side', 4) +
        ' ' +
        padRight('kind', 5) +
        ' ' +
        padLeft('vol', 6) +
        ' ' +
        padLeft('price', 11) +
        ' ' +
        padLeft('profit', 11) +
        ' ' +
        padLeft('balance', 12) +
        '  ' +
        'note',
    );
    for (const d of report.deals) {
      lines.push(dealRow(d));
    }
  }
  lines.push('');

  // ── Summary ──
  const winRatePct = (report.winRate * 100).toFixed(1);
  lines.push('── Summary ───────────────────────────────────────────────────────────');
  lines.push(` Total deals      : ${report.totalDeals}`);
  lines.push(` Round-trip trades: ${report.totalTrades}`);
  lines.push(` Wins / Losses    : ${report.wins} / ${report.losses}  (win rate ${winRatePct}%)`);
  lines.push(` Net profit       : ${fmtMoney(report.netProfit)}`);
  lines.push(` Initial balance  : ${fmtMoney(report.initialBalance)}`);
  lines.push(` Final balance    : ${fmtMoney(report.finalBalance)}`);
  lines.push(` Final equity     : ${fmtMoney(report.finalEquity)}`);
  lines.push(` Max drawdown     : ${fmtMoney(report.maxDrawdown)}`);
  lines.push('══════════════════════════════════════════════════════════════════════');

  return lines.join('\n');
}

/** Print the report to stdout. */
export function printReport(report: BacktestReport, opts: PrintReportOptions = {}): void {
  process.stdout.write(formatReport(report, opts) + '\n');
}
