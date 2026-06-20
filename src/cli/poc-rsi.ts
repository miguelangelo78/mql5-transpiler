/**
 * `poc:rsi` CLI — the SECOND end-to-end proof of concept (`npm run poc:rsi`).
 *
 * Drives the whole pipeline on the harder sample EA, examples/RsiReversal.mq5,
 * with zero hand-written glue between MQL5 and the running backtest:
 *
 *   1. Read examples/RsiReversal.mq5.
 *   2. compileMql5ToIR → emitTypeScript → write out/RsiReversal.ts.
 *   3. checkCoverage(module) — MUST be ZERO error diagnostics now that the
 *      runtime implements iRSI/iATR (Wilder/SMA-of-TR), EventSetTimer/
 *      EventKillTimer, and CTrade.BuyLimit/SellLimit/OrderDelete. We print the
 *      diagnostics either way; a non-zero error count is a real regression.
 *   4. Dynamic-import the EMITTED module under tsx to get `createExpert`
 *      (proving the generated code is real, runnable TypeScript).
 *   5. runBacktest with deterministic synthetic data SHAPED so the strategy
 *      actually trades: a slow mean-reverting cycle whose amplitude is large
 *      relative to ATR so RSI reaches oversold/overbought near the troughs/
 *      peaks, the resting BUY/SELL LIMIT (0.5 ATR beyond price) is touched as
 *      price overshoots, and the subsequent reversion hits TP while the
 *      occasional continued move hits SL. We do NOT modify the EA to force
 *      trades (§21) — the data is shaped; the strategy decides.
 *   6. Print the transpiled path, the trade log (pending fills + SL/TP exits
 *      are tagged in the `note` column), and the summary.
 *
 * Why this data shape (rule 21 — documented, not a heuristic in the runtime):
 *   - The synthetic series is a pure sinusoid + bounded noise (src/data/
 *     synthetic.ts). RSI(14) on a sinusoid sweeps to its extremes near each
 *     turning point; the larger the cycle amplitude relative to the per-bar
 *     noise, the deeper the RSI excursion past 30 / 70. We pick an amplitude /
 *     cycle / noise combination (below) for which RSI genuinely crosses the
 *     30/70 thresholds — verified by RUNNING it, not assumed.
 *   - The entry offset is 0.5·ATR below/above the signal bar's price. Because
 *     the cycle keeps moving in the signal direction for several more bars after
 *     RSI first crosses the threshold (the trough/peak is not yet reached), the
 *     resting limit IS touched. After the turn, mean reversion of ~2·ATR carries
 *     price to TP; a cycle that overshoots the entry by >1.5·ATR before reverting
 *     produces the occasional SL. Both outcomes occur in the chosen series.
 *
 * If this produced 0 pending fills or 0 SL/TP exits, that would be a real
 * fidelity bug to chase in the indicator / pending-book / intrabar-fill path,
 * NOT something to paper over.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { transpileFile } from './transpile';
import { runBacktest } from '../engine/driver';
import { printReport } from '../engine/report-print';
import type { ExpertFactory } from '../runtime/runtime';
import type { BacktestConfig } from '../runtime/providers/backtest/index';
import { formatDiagnostics, hasErrors } from '../diagnostics';
import type { BacktestReport } from '../engine/types';

/** The sample EA this PoC runs end-to-end. */
const SAMPLE_EA = resolve('examples/RsiReversal.mq5');

/** Where the emitted module lands. */
const OUT_DIR = resolve('out');

/** PERIOD_M15 (MT5 ENUM_TIMEFRAMES = 15). 15-min bars → the 60-s timer fires
 *  once per bar (a 60-s interval ≤ a 900-s bar collapses to one OnTimer/bar in
 *  the bar tier — see driver.ts). A 15-min cadence is realistic for this kind
 *  of mean-reversion EA and keeps the run a few hundred bars long. */
const PERIOD_M15 = 15;

/**
 * Count pending fills and SL/TP exits in a report (for the run's self-check).
 *
 * A PENDING FILL is an `open` deal whose note marks it as a pending activation
 * (the backtest broker tags it `[<kind> fill]` when the EA gave no comment).
 * RsiReversal only ever opens via BuyLimit/SellLimit, so every `open` deal here
 * is a pending fill — but we key on the explicit tag so the check is honest and
 * survives an EA that also placed market orders.
 *
 * An SL/TP EXIT is a `close` deal whose note is `[sl]` or `[tp]` (the matching
 * engine's intrabar exit tag).
 */
function summariseExecutions(report: BacktestReport): {
  pendingFills: number;
  slExits: number;
  tpExits: number;
} {
  let pendingFills = 0;
  let slExits = 0;
  let tpExits = 0;
  for (const d of report.deals) {
    if (d.kind === 'open' && d.comment.includes('fill]')) pendingFills++;
    if (d.kind === 'close' && d.comment === '[sl]') slExits++;
    if (d.kind === 'close' && d.comment === '[tp]') tpExits++;
  }
  return { pendingFills, slExits, tpExits };
}

async function main(): Promise<void> {
  // ── 1 + 2: transpile the sample EA to a runnable TS module on disk. ──
  process.stdout.write(`Transpiling ${SAMPLE_EA} …\n`);
  const { outPath, diagnostics } = transpileFile(SAMPLE_EA, OUT_DIR);
  process.stdout.write(`  → ${outPath}\n\n`);

  // ── 3: diagnostics (honesty layer). MUST be zero errors. ──
  if (diagnostics.length > 0) {
    process.stdout.write(formatDiagnostics(diagnostics) + '\n\n');
    if (hasErrors(diagnostics)) {
      process.stderr.write(
        'WARNING: RsiReversal produced ERROR diagnostics — it should be fully ' +
          'covered now that iRSI/iATR/timer/pending CTrade methods are real. ' +
          'Investigate the runtime coverage gap.\n\n',
      );
      // A coverage regression must fail the PoC loudly.
      process.exitCode = 1;
      return;
    }
  } else {
    process.stdout.write(
      'Diagnostics: 0 — RsiReversal is fully covered by the runtime ' +
        '(iRSI, iATR, EventSetTimer/EventKillTimer, CTrade pending methods).\n\n',
    );
  }

  // ── 4: dynamic-import the EMITTED module to get its createExpert factory. ──
  const moduleUrl = pathToFileURL(outPath).href;
  const mod: unknown = await import(moduleUrl);
  const factory = (mod as { createExpert?: unknown }).createExpert;
  if (typeof factory !== 'function') {
    throw new Error(
      `Emitted module ${outPath} does not export a createExpert function ` +
        `(got ${typeof factory}). The backend emission ABI was not honoured.`,
    );
  }

  // ── 5: run the backtest on data shaped to exercise the FULL strategy. ──
  //
  // EURUSD-like 5-digit FX symbol, M15 bars. The mean-reverting cycle below was
  // tuned (by running) so RSI(14) crosses 30 and 70, the resting limit (0.5·ATR
  // beyond price) is touched on the overshoot, and the reversion produces BOTH
  // TP exits and the occasional SL exit. A fixed seed keeps the run reproducible.
  //
  // Shape rationale (documented per §21; the EA + indicator math are untouched):
  //   cycleAmplitude 0.012 (≈120 pips) over a 64-bar cycle gives a steep enough
  //   sweep that RSI(14) reaches the low-20s / high-70s near the turns; the
  //   per-bar noise (12 pips) and wick (9 pips) are large enough that the limit
  //   0.5·ATR (ATR ≈ the per-bar range ≈ 20-30 pips) past price is reached as the
  //   price keeps moving toward the trough/peak, yet small enough not to drown
  //   the cycle. The ~2·ATR reversion to the cycle mean hits TP; a deeper
  //   overshoot past the 1.5·ATR stop before the turn hits SL.
  const startPrice = 1.1;
  const config: BacktestConfig = {
    symbol: 'EURUSD',
    timeframe: PERIOD_M15,
    initialBalance: 10000,
    bars: {
      bars: 2000,
      startPrice,
      startTime: Math.floor(Date.UTC(2024, 0, 1) / 1000),
      seed: 0x1234,
      cycleAmplitude: 0.012, // ≈120-pip peak-to-trough slow cycle
      cyclePeriodBars: 64, // a full up/down cycle every 64 M15 bars (16 h)
      noise: 0.0012, // ±12-pip per-bar noise
      wick: 0.0009, // 9-pip intrabar wick half-range
    },
  };

  // The EA's default inputs (RSI 14 / ATR 14 / 30-70 levels / 0.5-1.5-2 ATRs /
  // 0.10 lots / 60-s timer) come from the emitted module — no overrides.
  const report = await runBacktest({
    factory: factory as ExpertFactory,
    config,
  });

  // ── 6: print the report. ──
  process.stdout.write('\n');
  printReport(report, {
    transpiledPath: outPath,
    timeframeLabel: 'M15',
  });

  // ── self-check: the run must exercise pending fills AND SL/TP exits. ──
  const { pendingFills, slExits, tpExits } = summariseExecutions(report);
  process.stdout.write('\n');
  process.stdout.write('── Execution coverage (this run) ─────────────────────────────────────\n');
  process.stdout.write(` Pending fills   : ${pendingFills}\n`);
  process.stdout.write(` SL exits        : ${slExits}\n`);
  process.stdout.write(` TP exits        : ${tpExits}\n`);
  process.stdout.write('══════════════════════════════════════════════════════════════════════\n');

  if (report.totalDeals === 0) {
    process.stderr.write(
      '\nWARNING: the backtest produced 0 deals. The data is shaped to push RSI ' +
        'to its extremes and fill the resting limits — investigate the indicator / ' +
        'pending-book / intrabar-fill path.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (pendingFills === 0) {
    process.stderr.write(
      '\nWARNING: 0 pending fills. RSI may not be reaching the thresholds, or the ' +
        'resting limit is never touched — investigate before claiming success.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (slExits + tpExits === 0) {
    process.stderr.write(
      '\nWARNING: 0 SL/TP exits. Filled positions are never reaching their stop or ' +
        'target — investigate the intrabar SL/TP path / the ATR sizing.\n',
    );
    process.exitCode = 1;
    return;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `poc:rsi failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
