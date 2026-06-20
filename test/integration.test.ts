/**
 * Integration tests for the engine driver + report printer + the full
 * compile→emit→import→run pipeline. This is the seam the integration agent owns:
 * it exercises every module together (frontend, backend, runtime, backtest)
 * exactly as the `poc` CLI does, plus the driver's control-flow edge cases.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { compileMql5ToIR } from '../src/compile';
import { emitTypeScript } from '../src/backend/typescript/emit';
import { runBacktest } from '../src/engine/driver';
import { formatReport } from '../src/engine/report-print';
import type { BacktestConfig } from '../src/runtime/providers/backtest/index';
import type { ExpertFactory } from '../src/runtime/runtime';
import type { BacktestReport } from '../src/engine/types';

const SAMPLE = resolve('examples/MovingAverageCross.mq5');

/** FX-realistic synthetic config (matches the poc CLI's shaping). */
function fxConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: 'EURUSD',
    timeframe: 1,
    initialBalance: 10000,
    bars: {
      bars: 2000,
      startPrice: 1.1,
      startTime: Math.floor(Date.UTC(2024, 0, 1) / 1000),
      seed: 0x5eed,
      cycleAmplitude: 0.02,
      cyclePeriodBars: 120,
      noise: 0.0008,
      wick: 0.0005,
    },
    ...overrides,
  };
}

/** Emit the sample EA, write it to a temp dir, and dynamic-import its factory. */
async function importSampleFactory(): Promise<ExpertFactory> {
  const source = readFileSync(SAMPLE, 'utf8');
  const mod = compileMql5ToIR(source, { name: 'MovingAverageCross', filePath: SAMPLE });
  const code = emitTypeScript(mod);
  const dir = mkdtempSync(join(tmpdir(), 'mql5-int-'));
  const outPath = join(dir, 'MovingAverageCross.ts');
  writeFileSync(outPath, code, 'utf8');
  const imported: unknown = await import(pathToFileURL(outPath).href);
  const factory = (imported as { createExpert?: unknown }).createExpert;
  if (typeof factory !== 'function') {
    throw new Error('emitted module did not export createExpert');
  }
  return factory as ExpertFactory;
}

describe('end-to-end pipeline (compile → emit → import → run)', () => {
  let factory: ExpertFactory;
  let report: BacktestReport;

  beforeAll(async () => {
    factory = await importSampleFactory();
    report = await runBacktest({ factory, config: fxConfig() });
  });

  it('emits a module that exports a runnable createExpert factory', () => {
    expect(typeof factory).toBe('function');
  });

  it('produces at least one trade on the engineered (crossing) data', () => {
    // The synthetic series is designed to cross the SMAs; 0 trades would be a
    // real bug in the indicator/as-series/crossover path (§21), not acceptable.
    expect(report.totalDeals).toBeGreaterThanOrEqual(1);
    expect(report.totalTrades).toBeGreaterThanOrEqual(1);
  });

  it('keeps prices in a realistic EURUSD band (data-shape sanity)', () => {
    for (const d of report.deals) {
      expect(d.price).toBeGreaterThan(1.0);
      expect(d.price).toBeLessThan(1.3);
    }
  });

  it('books realised P/L only on close legs; opens carry 0 profit (§29 — 0 is real)', () => {
    for (const d of report.deals) {
      if (d.kind === 'open') {
        expect(d.profit).toBe(0);
      }
    }
    // At least one close leg exists and at least one carries non-zero P/L.
    const closes = report.deals.filter((d) => d.kind === 'close');
    expect(closes.length).toBeGreaterThanOrEqual(1);
    expect(closes.some((d) => d.profit !== 0)).toBe(true);
  });

  it('balance accounting is consistent: final = initial + netProfit', () => {
    expect(report.finalBalance).toBeCloseTo(report.initialBalance + report.netProfit, 6);
  });

  it('processes every bar of the dataset', () => {
    expect(report.barsProcessed).toBe(2000);
  });

  it('is deterministic: same seed ⇒ identical report', async () => {
    const r2 = await runBacktest({ factory, config: fxConfig() });
    expect(r2.totalDeals).toBe(report.totalDeals);
    expect(r2.finalBalance).toBe(report.finalBalance);
    expect(r2.deals.map((d) => d.price)).toEqual(report.deals.map((d) => d.price));
  });
});

describe('driver control flow', () => {
  it('honours input overrides (different periods ⇒ different trade count)', async () => {
    const factory = await importSampleFactory();
    const base = await runBacktest({ factory, config: fxConfig() });
    const slower = await runBacktest({
      factory,
      config: fxConfig(),
      inputs: { InpFastPeriod: 20, InpSlowPeriod: 60 },
    });
    // Slower MAs cross less often; the override must actually take effect.
    expect(slower.totalDeals).not.toBe(base.totalDeals);
  });

  it('an override of 0 lots is honoured (§29) and the broker rejects it ⇒ no deals', async () => {
    const factory = await importSampleFactory();
    // InpLots=0 is a real value, not "absent". CTrade.Buy(0) → broker rejects
    // (invalid volume) → no position ever opens → 0 deals. This proves a 0
    // override is passed through, not silently replaced by the default 0.10.
    const r = await runBacktest({
      factory,
      config: fxConfig(),
      inputs: { InpLots: 0 },
    });
    expect(r.totalDeals).toBe(0);
  });

  it('aborts trading when OnInit returns INIT_FAILED (no OnTick runs)', async () => {
    // A factory whose OnInit fails: the driver must NOT call OnTick, and the
    // report must have 0 deals. We inject a hand-built factory (no MQL5 needed).
    let ticks = 0;
    const failingFactory: ExpertFactory = () => ({
      OnInit: () => 1, // INIT_FAILED
      OnTick: () => {
        ticks++;
      },
      __inputs: {},
    });
    const r = await runBacktest({ factory: failingFactory, config: fxConfig() });
    expect(ticks).toBe(0);
    expect(r.totalDeals).toBe(0);
  });

  it('runs when OnInit returns INIT_SUCCEEDED (0) — a 0 is success, not a falsy abort (§29)', async () => {
    let ticks = 0;
    const okFactory: ExpertFactory = () => ({
      OnInit: () => 0, // INIT_SUCCEEDED — must NOT be treated as a falsy failure
      OnTick: () => {
        ticks++;
      },
      __inputs: {},
    });
    const r = await runBacktest({ factory: okFactory, config: fxConfig({ bars: { bars: 50, startPrice: 1.1, startTime: 0, seed: 1 } }) });
    expect(ticks).toBe(50);
    expect(r.barsProcessed).toBe(50);
  });

  it('runs even with no OnInit handler at all', async () => {
    let ticks = 0;
    const noInit: ExpertFactory = () => ({
      OnTick: () => {
        ticks++;
      },
      __inputs: {},
    });
    const r = await runBacktest({ factory: noInit, config: fxConfig({ bars: { bars: 10, startPrice: 1.1, startTime: 0, seed: 1 } }) });
    expect(ticks).toBe(10);
  });
});

describe('report printer', () => {
  it('renders a header, a trade-log row per deal, and a summary', async () => {
    const factory = await importSampleFactory();
    const report = await runBacktest({ factory, config: fxConfig() });
    const text = formatReport(report, { transpiledPath: '/tmp/x.ts', timeframeLabel: 'M1' });

    expect(text).toContain('Backtest Report');
    expect(text).toContain('Transpiled TS : /tmp/x.ts');
    expect(text).toContain('Symbol        : EURUSD');
    expect(text).toContain('Timeframe     : M1');
    expect(text).toContain('Trade Log');
    expect(text).toContain('Summary');
    expect(text).toContain(`Round-trip trades: ${report.totalTrades}`);
    // One body row per deal, plus the header row.
    const tradeRows = text.split('\n').filter((l) => /\bbuy\b|\bsell\b/.test(l) && /open|close/.test(l));
    expect(tradeRows.length).toBe(report.deals.length);
  });

  it('prints a clean "(no deals)" log and 0 values when nothing traded (§29)', () => {
    const empty: BacktestReport = {
      symbol: 'EURUSD',
      timeframe: 1,
      barsProcessed: 0,
      initialBalance: 0, // a 0 balance is valid (§29)
      finalBalance: 0,
      finalEquity: 0,
      netProfit: 0,
      totalDeals: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      maxDrawdown: 0,
      deals: [],
      equityCurve: [],
    };
    const text = formatReport(empty);
    expect(text).toContain('(no deals)');
    expect(text).toContain('Net profit       : 0.00');
    expect(text).toContain('Initial balance  : 0.00');
    expect(text).toContain('win rate 0.0%');
  });
});
