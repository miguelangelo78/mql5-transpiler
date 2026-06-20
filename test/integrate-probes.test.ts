/**
 * INTEGRATE probes — the four feature-completion probes wired end-to-end.
 *
 * This is the integrator's regression pin for the surface closed this cycle:
 *   (1) user classes-with-methods + single inheritance  (examples/_probe_class.mq5)
 *   (2) the raw trade API: MqlTradeRequest/MqlTradeResult + OrderSend
 *                                                          (examples/_probe_ordersend.mq5)
 *   (3) CTrade completions: PositionOpen + config setters + Result* accessors
 *                                                          (examples/_probe_ctrade.mq5)
 *   (4) iCustom — a SOURCE custom indicator                (examples/_probe_icustom.mq5)
 *
 * Each probe is taken through the EXACT user pipeline: compileMql5ToIR → ZERO
 * error diagnostics → checkCoverage empty (the honesty layer agrees it is fully
 * supported) → emitTypeScript → import → runBacktest. We assert both that it
 * COMPILES clean AND that it RUNS (the class state round-trips; the trade probes
 * actually book deals). A regression in any wired feature fails here.
 *
 * Run: npx vitest run test/integrate-probes.test.ts
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { compileMql5ToIR } from '../src/compile';
import { emitTypeScript } from '../src/backend/typescript/emit';
import { checkCoverage } from '../src/runtime/coverage';
import { runBacktest } from '../src/engine/driver';
import type { BacktestConfig } from '../src/runtime/providers/backtest/index';
import type { ExpertFactory } from '../src/runtime/runtime';
import type { BacktestReport } from '../src/engine/types';
import type { Diagnostic } from '../src/diagnostics';

// ─────────────────────────────────────────────────────────────────────────
// Pipeline helpers
// ─────────────────────────────────────────────────────────────────────────

/** FX-realistic synthetic config (matches the `ea` CLI's shaping). */
function fxConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  const startPrice = 1.1;
  const amp = startPrice * 0.02;
  return {
    symbol: 'EURUSD',
    timeframe: 1,
    initialBalance: 10000,
    bars: {
      bars: 600,
      startPrice,
      startTime: Math.floor(Date.UTC(2024, 0, 1) / 1000),
      seed: 0x5eed,
      cycleAmplitude: amp,
      cyclePeriodBars: 120,
      noise: amp * 0.04,
      wick: amp * 0.025,
    },
    ...overrides,
  };
}

interface Compiled {
  diagnostics: Diagnostic[];
  coverage: Diagnostic[];
  factory: ExpertFactory;
}

/**
 * Compile a probe through the FULL pipeline and import its factory. Returns the
 * lowering + coverage diagnostics (so a test can assert ZERO errors) and the
 * runnable factory. `filePath`/`sourceDir` are threaded so `#include` resolves.
 */
async function compileProbe(probeFile: string): Promise<Compiled> {
  const abs = resolve('examples', probeFile);
  const source = readFileSync(abs, 'utf8');
  const mod = compileMql5ToIR(source, {
    name: probeFile.replace(/\.mq5$/, ''),
    filePath: abs,
    sourceDir: dirname(abs),
  });
  const diagnostics = mod.diagnostics ?? [];
  const coverage = checkCoverage(mod);

  const code = emitTypeScript(mod);
  const dir = mkdtempSync(join(tmpdir(), 'mql5-probe-'));
  const outPath = join(dir, `${probeFile.replace(/\.mq5$/, '')}.ts`);
  writeFileSync(outPath, code, 'utf8');
  const imported: unknown = await import(pathToFileURL(outPath).href);
  const factory = (imported as { createExpert?: unknown }).createExpert;
  if (typeof factory !== 'function') {
    throw new Error(`probe ${probeFile} did not export createExpert`);
  }
  return { diagnostics, coverage, factory: factory as ExpertFactory };
}

/** The error-severity diagnostics, for a readable assertion message. */
function errors(diags: Diagnostic[]): Diagnostic[] {
  return diags.filter((d) => d.severity === 'error');
}

// ─────────────────────────────────────────────────────────────────────────
// (1) user classes-with-methods + single inheritance
// ─────────────────────────────────────────────────────────────────────────

describe('INTEGRATE — _probe_class (user classes + inheritance)', () => {
  it('compiles with ZERO error diagnostics and empty coverage', async () => {
    const { diagnostics, coverage } = await compileProbe('_probe_class.mq5');
    expect(errors(diagnostics), JSON.stringify(errors(diagnostics), null, 2)).toHaveLength(0);
    expect(coverage, JSON.stringify(coverage, null, 2)).toHaveLength(0);
  });

  it('runs end-to-end (OnInit drives the class; the inherited method resolves)', async () => {
    const { factory } = await compileProbe('_probe_class.mq5');
    // A no-trade EA: it must run without throwing. The class-computed value (17)
    // is logged by OnInit; we assert the run completes + books no deals.
    const report: BacktestReport = await runBacktest({ factory, config: fxConfig() });
    expect(report.barsProcessed).toBeGreaterThan(0);
    expect(report.totalDeals).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (2) raw trade API — MqlTradeRequest/MqlTradeResult + OrderSend
// ─────────────────────────────────────────────────────────────────────────

describe('INTEGRATE — _probe_ordersend (MqlTradeRequest + OrderSend)', () => {
  it('compiles with ZERO error diagnostics and empty coverage', async () => {
    const { diagnostics, coverage } = await compileProbe('_probe_ordersend.mq5');
    expect(errors(diagnostics), JSON.stringify(errors(diagnostics), null, 2)).toHaveLength(0);
    expect(coverage, JSON.stringify(coverage, null, 2)).toHaveLength(0);
  });

  it('runs + books a real deal via OrderSend (retcode DONE)', async () => {
    const { factory } = await compileProbe('_probe_ordersend.mq5');
    const report: BacktestReport = await runBacktest({ factory, config: fxConfig() });
    // The probe opens exactly one market BUY on the first flat tick.
    expect(report.totalDeals).toBeGreaterThanOrEqual(1);
    const open = report.deals.find((d) => d.kind === 'open');
    expect(open).toBeDefined();
    expect(open!.side).toBe('buy');
    expect(open!.comment).toBe('ordersend probe');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (3) CTrade completions — PositionOpen + setters + Result* accessors
// ─────────────────────────────────────────────────────────────────────────

describe('INTEGRATE — _probe_ctrade (PositionOpen + setters + Result*)', () => {
  it('compiles with ZERO error diagnostics and empty coverage', async () => {
    const { diagnostics, coverage } = await compileProbe('_probe_ctrade.mq5');
    expect(errors(diagnostics), JSON.stringify(errors(diagnostics), null, 2)).toHaveLength(0);
    expect(coverage, JSON.stringify(coverage, null, 2)).toHaveLength(0);
  });

  it('runs + books a real deal via CTrade.PositionOpen', async () => {
    const { factory } = await compileProbe('_probe_ctrade.mq5');
    const report: BacktestReport = await runBacktest({ factory, config: fxConfig() });
    expect(report.totalDeals).toBeGreaterThanOrEqual(1);
    const open = report.deals.find((d) => d.kind === 'open');
    expect(open).toBeDefined();
    expect(open!.side).toBe('buy');
    expect(open!.comment).toBe('ctrade probe');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (4) iCustom — a SOURCE custom indicator
// ─────────────────────────────────────────────────────────────────────────

describe('INTEGRATE — _probe_icustom (iCustom SOURCE custom indicator)', () => {
  it('compiles with ZERO error diagnostics and empty coverage', async () => {
    const { diagnostics, coverage } = await compileProbe('_probe_icustom.mq5');
    expect(errors(diagnostics), JSON.stringify(errors(diagnostics), null, 2)).toHaveLength(0);
    expect(coverage, JSON.stringify(coverage, null, 2)).toHaveLength(0);
  });

  it('runs: iCustom loads SimpleMA, CopyBuffer reads it, the MA-cross trades', async () => {
    const { factory } = await compileProbe('_probe_icustom.mq5');
    const report: BacktestReport = await runBacktest({ factory, config: fxConfig() });
    // The MA-cross strategy over the custom indicator books multiple round-trips
    // on the synthetic series (proves the custom buffer drove the logic).
    expect(report.totalDeals).toBeGreaterThan(0);
    expect(report.totalTrades).toBeGreaterThan(0);
    // Deals carry the probe's open/close comments → the iCustom path drove them.
    const opens = report.deals.filter((d) => d.comment === 'icustom probe');
    expect(opens.length).toBeGreaterThan(0);
  });
});
