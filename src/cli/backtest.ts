/**
 * `backtest` CLI — run an ALREADY-EMITTED EA module against synthetic data.
 *
 *   npm run backtest -- <path/to/emitted.ts> [symbol] [timeframe] [bars] [seed]
 *
 * Unlike `poc` (which transpiles the sample first), this takes a module that
 * was produced earlier by `transpile` and just runs + prints it. It shares the
 * same engine driver + report printer as `poc`, so the two stay consistent.
 *
 * Defaults: symbol EURUSD, timeframe PERIOD_M1 (1), 3000 bars, seed 0x5eed,
 * initial balance 10000. A 0 for any numeric arg is honoured as a real value
 * (§29), not treated as "use the default".
 */

import { resolve } from 'node:path';

import { runBacktest } from '../engine/driver';
import { printReport } from '../engine/report-print';
import { loadEmittedExpert } from '../loadExpert';
import type { Inputs } from '../runtime/runtime';
import type { BacktestConfig } from '../runtime/providers/backtest/index';
import type { Bar, SymbolSpec } from '../runtime/providers/types';

export interface RunModuleOptions {
  /** Path to the emitted EA module (absolute or relative to cwd). */
  modulePath: string;
  symbol?: string;
  timeframe?: number;
  bars?: number;
  startPrice?: number;
  startTime?: number;
  seed?: number;
  initialBalance?: number;
  inputs?: Inputs;
  timeframeLabel?: string;
  /** REAL historical bars (e.g. loaded from a CSV). When present + non-empty,
   *  the backtest runs on these instead of the synthetic generator. */
  realBars?: Bar[];
  /** Symbol spec for the real data (digits/point/contractSize/tickValue). A
   *  documented FX-like default is used when omitted. */
  symbolSpec?: SymbolSpec;
}

const PERIOD_M1 = 1;

/** Load an emitted module and run it; returns the report (no printing). */
export async function runEmittedModule(opts: RunModuleOptions) {
  // Load via the loader-independent path (pure-JS emitted module → data: URL) so
  // this runs under plain Node, not only under tsx.
  const factory = await loadEmittedExpert(resolve(opts.modulePath));

  // §29: an explicitly-passed 0 must be honoured; only an absent (undefined)
  // option falls back to the default. `??` does exactly that.
  const symbol = opts.symbol ?? 'EURUSD';
  const timeframe = opts.timeframe ?? PERIOD_M1;
  const startPrice = opts.startPrice ?? 1.1;

  // Price-PROPORTIONAL cycle amplitude so the generated series is realistic for
  // ANY start price. The synthetic generator's own default amplitude
  // (`max(startPrice*0.01, 5)`) has a fixed 5.0 floor meant for index/equity
  // prices in the thousands — applied to a 1.10 FX pair it swings the price into
  // the negatives. A flat 2% of the start price (≈220 pips on EURUSD) crosses
  // the SMAs cleanly at any scale, with noise/wick scaled to match. This is a
  // CLI data-shape default only; the EA + indicator math are untouched (§21).
  const cycleAmplitude = startPrice * 0.02;

  const useReal = opts.realBars !== undefined && opts.realBars.length > 0;
  const config: BacktestConfig = useReal
    ? {
        symbol,
        timeframe,
        initialBalance: opts.initialBalance ?? 10000,
        bars: opts.realBars!,
        ...(opts.symbolSpec ? { symbolSpec: opts.symbolSpec } : {}),
      }
    : {
        symbol,
        timeframe,
        initialBalance: opts.initialBalance ?? 10000,
        bars: {
          bars: opts.bars ?? 3000,
          startPrice,
          startTime: opts.startTime ?? Math.floor(Date.UTC(2024, 0, 1) / 1000),
          seed: opts.seed ?? 0x5eed,
          cycleAmplitude,
          cyclePeriodBars: 120,
          noise: cycleAmplitude * 0.04,
          wick: cycleAmplitude * 0.025,
        },
      };

  return runBacktest({
    factory,
    config,
    inputs: opts.inputs,
  });
}

/**
 * Parse an integer CLI arg, honouring an explicit 0 (§29). Returns `fallback`
 * only when the arg is absent or not a finite number.
 */
function intArg(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(
      'usage: tsx src/cli/backtest.ts <emitted.ts> [symbol] [timeframe] [bars] [seed]\n',
    );
    process.exit(2);
  }

  const modulePath = args[0]!;
  const symbol = args[1];
  const timeframe = args[2] !== undefined ? intArg(args[2], PERIOD_M1) : undefined;
  const bars = args[3] !== undefined ? intArg(args[3], 3000) : undefined;
  const seed = args[4] !== undefined ? intArg(args[4], 0x5eed) : undefined;

  const report = await runEmittedModule({
    modulePath,
    symbol,
    timeframe,
    bars,
    seed,
  });

  printReport(report, { transpiledPath: resolve(modulePath) });

  if (report.totalDeals === 0) {
    process.stderr.write('\nWARNING: 0 deals produced.\n');
    process.exitCode = 1;
  }
}

import { isMainModule } from './isMain';
if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `backtest failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
