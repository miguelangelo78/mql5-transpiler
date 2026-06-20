/**
 * Engine driver — runs a transpiled EA against a backtest simulation.
 *
 * This is the seam that binds the four modules together at runtime:
 *
 *   createBacktest(config)            → a BacktestSimulation (providers + step)
 *   createRuntime(sim.providers, ctx) → the Runtime `rt` the EA factory needs
 *   factory(rt, inputs)               → the ExpertInstance (OnInit/OnTick/...)
 *
 * The expert factory is INJECTED (not imported here): the PoC CLI transpiles the
 * .mq5, emits a TS module, dynamic-imports it to obtain `createExpert`, and hands
 * that function in. This keeps the driver independent of any one EA and lets the
 * same driver run any emitted module.
 *
 * ── Run flow (MT5-faithful ordering) ────────────────────────────────────────
 *   1. Build the simulation + runtime; instantiate the expert.
 *   2. Call OnInit(); if it returns INIT_FAILED, abort BEFORE any ticks fire
 *      (MT5 never calls OnTick on a failed init).
 *   3. Step the simulation one bar at a time. After each step the feed's
 *      history ends at the new current bar (engine/types.ts invariant), so
 *      OnTick sees the new bar via the runtime's feed reads. Re-bind the
 *      runtime context each step if the runtime exposes a setter (no-op for the
 *      single bound (symbol,timeframe) of a backtest, but kept for correctness).
 *   4. After the dataset is exhausted, call OnDeinit(reason=0) (REASON_PROGRAM).
 *   5. Return the final report.
 *
 * Async discipline: OnInit/OnTick/OnDeinit may be sync or async (the emitted
 * handlers are `async` only when they contain a trade call). We `await` them
 * uniformly — awaiting a non-promise is a no-op — so both shapes run correctly
 * and trades complete before the next bar.
 */

import { createBacktest, type BacktestConfig } from '../runtime/providers/backtest/index';
import { createRuntime } from '../runtime/index';
import { timeframeSeconds } from '../data/synthetic';
import type { BacktestReport, RuntimeContext } from './types';
import type { ExpertFactory, Inputs, Runtime } from '../runtime/runtime';

/**
 * MT5's OnInit return value for a failed initialisation. The EA's
 * `return(INIT_FAILED)` lowers to a numeric `1` (constants.ts INIT_FAILED=1);
 * we compare against the same constant the runtime exposes so the check is
 * spelled once and stays in sync.
 *
 * Per MT5: OnInit may return either a value of ENUM_INIT_RETCODE (where
 * INIT_SUCCEEDED=0 and INIT_FAILED=1) or the older bool/int convention. The
 * authoritative "do not trade" signal is INIT_FAILED. We treat ONLY an explicit
 * INIT_FAILED as an abort (§29: a return of 0 = INIT_SUCCEEDED is a valid
 * success, never confused with "falsy ⇒ fail").
 */
const INIT_FAILED = 1;

export interface RunBacktestOptions {
  /** The transpiled EA factory (from the dynamic-imported emitted module). */
  factory: ExpertFactory;
  /** Backtest configuration (symbol, timeframe, bars/synthetic, balance, ...). */
  config: BacktestConfig;
  /** Input overrides for the EA (defaults ∪ these). A 0/false/"" is kept (§29). */
  inputs?: Inputs;
}

/** A runtime that MAY expose the engine's context-rebind hook. */
interface ContextBindable {
  setContext(ctx: RuntimeContext): void;
}

function hasSetContext(rt: Runtime): rt is Runtime & ContextBindable {
  return typeof (rt as Partial<ContextBindable>).setContext === 'function';
}

/**
 * Read the EA's currently-configured timer interval (seconds) via the
 * engine-internal `__timerSeconds()` hook, or 0 when no timer is set / the hook
 * is absent. We re-read every bar (not once after OnInit) because the EA may
 * start the timer in OnInit, change it later, or kill it — the driver must
 * react to the live value (§29: 0 = "no timer", a real, valid value, NOT
 * "missing"; distinguished from the hook being absent, which also yields 0).
 */
function timerSeconds(rt: Runtime): number {
  const fn = rt.__timerSeconds;
  if (typeof fn !== 'function') return 0;
  const s = fn.call(rt);
  return typeof s === 'number' && s > 0 ? s : 0;
}

/**
 * Run a transpiled EA over a deterministic backtest and return the report.
 *
 * The expert factory is injected; the driver owns the simulation lifecycle,
 * the runtime, and the bar-stepping loop.
 */
export async function runBacktest(opts: RunBacktestOptions): Promise<BacktestReport> {
  const sim = createBacktest(opts.config);
  const ctx: RuntimeContext = {
    symbol: opts.config.symbol,
    timeframe: opts.config.timeframe,
  };

  const rt = createRuntime(sim.providers, ctx);
  const instance = opts.factory(rt, opts.inputs);

  // ── OnInit ── (must precede any tick; INIT_FAILED aborts trading) ──
  if (instance.OnInit !== undefined) {
    const initCode = await instance.OnInit();
    if (initCode === INIT_FAILED) {
      // MT5 does not run OnTick after a failed init. Still call OnDeinit so the
      // EA can release handles, then return the (no-trade) report.
      if (instance.OnDeinit !== undefined) {
        await instance.OnDeinit(0);
      }
      return sim.report();
    }
  }

  // ── Tick/timer loop ── one OnTick per revealed bar; OnTimer at its cadence ──
  //
  // Timer cadence (bar tier — §21 modelling choice, documented):
  //   The bar tier has no sub-bar resolution: the smallest unit of time is one
  //   bar (`barDuration` seconds). So OnTimer fires on a WHOLE-BAR cadence:
  //     - interval ≤ barDuration  → fire once per bar (sub-bar resolution is
  //       NOT modelled — MT5 would fire OnTimer multiple times within a bar in
  //       real time / tick mode; the bar tier collapses those to one fire/bar).
  //     - interval > barDuration  → fire every ceil(interval / barDuration) bars
  //       (the nearest whole-bar count that is ≥ the requested interval).
  //   `barsPerFire = max(1, ceil(interval / barDuration))`. We fire when
  //   `barsSinceTimerFire` reaches it, then reset the counter.
  // OnTick (if present) fires every bar regardless. (RsiReversal has only
  // OnTimer; the 1st sample has only OnTick — both shapes run.)
  const barDuration = timeframeSeconds(ctx.timeframe);
  let barsSinceTimerFire = 0;

  while (sim.step()) {
    // Re-bind the runtime's chart context if it supports it. For a single-symbol
    // backtest this is the same (symbol, timeframe) every step, so it is a no-op
    // in practice — but it keeps the driver correct if a future runtime caches
    // per-bar context or a multi-context backtest is introduced.
    if (hasSetContext(rt)) {
      rt.setContext(ctx);
    }

    // OnTick first (mirrors MT5: a new bar is a tick event before any timer
    // event scheduled within it). The EA's per-tick logic runs each bar.
    if (instance.OnTick !== undefined) {
      await instance.OnTick();
    }

    // OnTimer at its whole-bar cadence, when a timer is currently configured.
    if (instance.OnTimer !== undefined) {
      const interval = timerSeconds(rt);
      if (interval > 0) {
        barsSinceTimerFire++;
        const barsPerFire =
          barDuration > 0 ? Math.max(1, Math.ceil(interval / barDuration)) : 1;
        if (barsSinceTimerFire >= barsPerFire) {
          barsSinceTimerFire = 0;
          await instance.OnTimer();
        }
      } else {
        // No timer set → never fire, and keep the counter reset so a later
        // EventSetTimer starts a fresh cadence from the next eligible bar.
        barsSinceTimerFire = 0;
      }
    }
  }

  // ── OnDeinit ── reason 0 = REASON_PROGRAM (normal end of a tester run) ──
  if (instance.OnDeinit !== undefined) {
    await instance.OnDeinit(0);
  }

  return sim.report();
}
