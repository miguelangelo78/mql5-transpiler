/**
 * `poc` CLI — the end-to-end proof of concept (`npm run poc`).
 *
 * Demonstrates the WHOLE pipeline on the sample EA, with zero hand-written glue
 * between MQL5 and the running backtest:
 *
 *   1. Read examples/MovingAverageCross.mq5.
 *   2. compileMql5ToIR → emitTypeScript → write out/MovingAverageCross.ts.
 *   3. Dynamic-import the EMITTED module under tsx to get `createExpert`
 *      (proving the generated code is real, runnable TypeScript — not just a
 *      string we inspected).
 *   4. runBacktest with deterministic synthetic data (seeded) designed to make
 *      the fast/slow SMAs cross, EURUSD / M1-equivalent timeframe, and the EA's
 *      own default inputs.
 *   5. Print the transpiled path, the trade log, and the summary.
 *
 * The synthetic series is engineered (src/data/synthetic.ts) to cross the SMAs
 * several times so the EA actually trades — we do NOT modify the EA to force
 * trades (§21). If it produced 0 trades, that would be a real bug to chase in
 * the indicator / as-series / crossover path, not something to paper over.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { transpileFile } from './transpile';
import { runBacktest } from '../engine/driver';
import { printReport } from '../engine/report-print';
import type { ExpertFactory } from '../runtime/runtime';
import type { BacktestConfig } from '../runtime/providers/backtest/index';
import { formatDiagnostics, hasErrors } from '../diagnostics';

/** The sample EA the PoC runs end-to-end. */
const SAMPLE_EA = resolve('examples/MovingAverageCross.mq5');

/** Where the emitted module lands. */
const OUT_DIR = resolve('out');

/** PERIOD_M1 (MT5 ENUM_TIMEFRAMES). The driver/feed decode timeframe → seconds. */
const PERIOD_M1 = 1;

async function main(): Promise<void> {
  // ── 1 + 2: transpile the sample EA to a runnable TS module on disk. ──
  process.stdout.write(`Transpiling ${SAMPLE_EA} …\n`);
  const { outPath, diagnostics } = transpileFile(SAMPLE_EA, OUT_DIR);
  process.stdout.write(`  → ${outPath}\n\n`);

  // Print diagnostics (honesty layer). The sample EA is expected to have ZERO
  // — it uses only implemented builtins. We print them either way; if it ever
  // grows an error diagnostic, that's a real regression the report makes loud
  // (but the PoC still runs the backtest so the diff is observable).
  if (diagnostics.length > 0) {
    process.stdout.write(formatDiagnostics(diagnostics) + '\n\n');
    if (hasErrors(diagnostics)) {
      process.stderr.write(
        'WARNING: the sample EA produced ERROR diagnostics — it should be ' +
          'fully covered by the runtime. Investigate the runtime coverage gap.\n\n',
      );
    }
  } else {
    process.stdout.write('Diagnostics: 0 — the sample EA is fully covered by the runtime.\n\n');
  }

  // ── 3: dynamic-import the EMITTED module to get its createExpert factory. ──
  // tsx transpiles the .ts on import, so the generated module runs as-is.
  const moduleUrl = pathToFileURL(outPath).href;
  const mod: unknown = await import(moduleUrl);
  const factory = (mod as { createExpert?: unknown }).createExpert;
  if (typeof factory !== 'function') {
    throw new Error(
      `Emitted module ${outPath} does not export a createExpert function ` +
        `(got ${typeof factory}). The backend emission ABI was not honoured.`,
    );
  }

  // ── 4: run the backtest with deterministic synthetic data. ──
  // EURUSD-like 5-digit FX symbol; a few thousand bars; a fixed seed so the run
  // is reproducible.
  //
  // FX-REALISTIC SHAPE: the synthetic generator's *defaults* size the cycle as
  // `max(startPrice*0.01, 5)` — a 5.0-unit floor meant for index/equity-priced
  // symbols (thousands), which on a 1.10-priced FX pair would swing the price
  // from -3.9 to +6.1 (nonsensical). We pin FX-appropriate knobs here so the
  // series looks like real EURUSD: a 0.02 (≈200-pip) slow cycle around 1.10
  // with small noise/wick. This is a DATA-SHAPE choice for a believable demo —
  // it does NOT touch the EA, the indicator math, or the crossover logic (§21).
  // The crossovers (and thus the trade count) are unaffected by the scale; only
  // the price/P&L magnitudes become realistic.
  const config: BacktestConfig = {
    symbol: 'EURUSD',
    timeframe: PERIOD_M1,
    initialBalance: 10000,
    bars: {
      bars: 3000,
      startPrice: 1.1,
      startTime: Math.floor(Date.UTC(2024, 0, 1) / 1000),
      seed: 0x5eed,
      cycleAmplitude: 0.02, // ≈200-pip peak-to-trough slow cycle
      cyclePeriodBars: 120, // one full up/down cycle every 120 M1 bars (2h)
      noise: 0.0008, // ±8-pip per-bar noise (perturbs, never dominates)
      wick: 0.0005, // 5-pip intrabar wick half-range
    },
  };

  // The EA's default inputs (InpFastPeriod=10, InpSlowPeriod=30, InpLots=0.10)
  // come from the emitted module itself — we pass no overrides so the defaults
  // baked into createExpert are used verbatim.
  const report = await runBacktest({
    factory: factory as ExpertFactory,
    config,
  });

  // ── 5: print the report. ──
  process.stdout.write('\n');
  printReport(report, {
    transpiledPath: outPath,
    timeframeLabel: 'M1',
  });

  // A non-zero exit if the run somehow produced zero deals would surface a
  // regression loudly; the PoC is expected to trade on the engineered data.
  if (report.totalDeals === 0) {
    process.stderr.write(
      '\nWARNING: the backtest produced 0 deals. The synthetic data is designed ' +
        'to cross the SMAs — investigate the indicator / as-series / crossover path.\n',
    );
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`poc failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
