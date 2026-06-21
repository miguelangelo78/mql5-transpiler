/**
 * Replay-then-live driver — a HYBRID run that, in ONE continuous EA session:
 *
 *   1. Phase A (warm-up backtest): replays the EA over real historical bars
 *      against a simulated matching engine, producing a normal backtest report.
 *   2. Phase B (live): keeps the SAME EA instance running, now event-driven on
 *      the real broker's live ticks/timer.
 *
 * The EA is unchanged — it only ever touches IBroker/IMarketFeed/IClock. What
 * changes at the seam is which providers those resolve to. We hold the EA over a
 * STABLE provider FACADE whose calls forward to the CURRENT backing providers;
 * flipping the backing from the backtest sim to the live providers is therefore
 * transparent to the runtime and every subsystem (they call through the facade
 * each time and never cache a method ref — verified), so the EA's OWN state
 * (indicator handles, counters, flags) carries across the seam unbroken.
 *
 * ── Honest model of the seam (§21) ──────────────────────────────────────────
 *  - MT5 itself has no "backtest then live in one process"; this is a deliberate
 *    hybrid we add. We treat it as ONE session: OnInit once at the very start,
 *    OnDeinit once at the very end. No OnDeinit/OnInit fires between phases.
 *  - BROKER state does NOT (and cannot) carry: a paper position opened in Phase A
 *    is on the simulated broker; Phase B reads the REAL account, which has its own
 *    positions (typically flat). At the seam the EA's view of positions/orders/
 *    account switches to the real account. EAs that re-query position state each
 *    tick (the norm) handle this cleanly; an EA caching a sim ticket in a member
 *    will simply find no such position live and re-evaluate.
 *  - FIDELITY differs by phase: Phase A uses the bar-tier sim (no spread/swap/
 *    commission yet); Phase B is the real broker. The Phase-A report is an
 *    analysis artifact, not a prediction of the live fills.
 */

import type { ExpertFactory, Inputs, Runtime } from '../runtime/runtime';
import { createRuntime } from '../runtime';
import { createBacktest } from '../runtime/providers/backtest/index';
import { timeframeSeconds } from '../data/synthetic';
import type { BacktestReport, RuntimeContext } from './types';
import type { Bar, SymbolSpec, Providers } from '../runtime/providers/types';
import type { TickerallProviders } from '../runtime/providers/tickerall';
import type { LiveRunSummary } from './live-driver';

const INIT_FAILED = 1;

export interface RunReplayThenLiveOptions {
  /** The transpiled EA factory (from the dynamic-imported emitted module). */
  factory: ExpertFactory;
  /** Real historical bars for the Phase-A warm-up backtest (chronological). */
  history: Bar[];
  /** Symbol spec for the Phase-A sim (digits/point/contractSize/tickValue). */
  symbolSpec?: SymbolSpec;
  /** Starting balance for the Phase-A paper run (default 10000). */
  initialBalance?: number;
  /** The connected live providers — the Phase-B backing + tick source. */
  live: TickerallProviders;
  symbol: string;
  timeframe: number;
  inputs?: Inputs;
  /** Phase-B duration in ms (default 60_000). Pass 0 to run until aborted. */
  durationMs?: number;
  /** Re-pull positions/account/pending every N ms in Phase B (default 5_000). */
  refreshMs?: number;
  /** Optional abort signal to stop Phase B early. */
  signal?: AbortSignal;
  /** Fired with the Phase-A report at the seam, BEFORE Phase B starts (so a CLI
   *  can print the history results, then watch live). */
  onBacktestComplete?: (report: BacktestReport) => void;
  /** Fired when each phase begins ('backtest' then 'live'). */
  onPhase?: (phase: 'backtest' | 'live') => void;
  /** Called once per Phase-B handler dispatch (for logging). */
  onActivity?: (what: 'tick' | 'timer', symbol: string) => void;
}

export interface ReplayThenLiveSummary {
  /** The Phase-A warm-up backtest report. */
  report: BacktestReport;
  /** The Phase-B live run summary. */
  live: LiveRunSummary;
  /** True if OnInit reported INIT_FAILED (neither phase traded). */
  initFailed: boolean;
}

/** A runtime that MAY expose the engine's context-rebind hook. */
interface ContextBindable { setContext(ctx: RuntimeContext): void }
function hasSetContext(rt: Runtime): rt is Runtime & ContextBindable {
  return typeof (rt as Partial<ContextBindable>).setContext === 'function';
}
function timerSeconds(rt: Runtime): number {
  const fn = rt.__timerSeconds;
  if (typeof fn !== 'function') return 0;
  const s = fn.call(rt);
  return typeof s === 'number' && s > 0 ? s : 0;
}

/**
 * A stable `Providers` whose calls forward to the CURRENT backing providers.
 * `switchTo()` flips the backing with no change to the facade's identity, so any
 * holder (the runtime + its subsystems) keeps working against the new backing.
 * Forwarding is per-call (the get trap re-reads `current`), so capability checks
 * like `typeof broker.pendingOrders === 'function'` re-evaluate against whatever
 * is current — exactly what the sim→live switch needs.
 */
function makeSwitchableProviders(initial: Providers): {
  providers: Providers;
  switchTo(p: Providers): void;
} {
  let current = initial;
  const forward = <K extends keyof Providers>(key: K): Providers[K] =>
    new Proxy({}, {
      get(_t, prop): unknown {
        const impl = current[key] as unknown as Record<PropertyKey, unknown>;
        const v = impl[prop];
        return typeof v === 'function'
          ? (v as (...a: unknown[]) => unknown).bind(impl)
          : v;
      },
      has(_t, prop): boolean {
        return prop in (current[key] as object);
      },
    }) as unknown as Providers[K];
  return {
    providers: { clock: forward('clock'), feed: forward('feed'), broker: forward('broker') },
    switchTo(p: Providers): void { current = p; },
  };
}

/**
 * Run a transpiled EA as a warm-up backtest over `history`, then keep the SAME
 * instance running live. Returns both the Phase-A report and the Phase-B summary.
 */
export async function runReplayThenLive(
  opts: RunReplayThenLiveOptions,
): Promise<ReplayThenLiveSummary> {
  const ctx: RuntimeContext = { symbol: opts.symbol, timeframe: opts.timeframe };

  // Phase-A backing: a deterministic sim built from the real historical bars.
  const sim = createBacktest({
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    initialBalance: opts.initialBalance ?? 10000,
    bars: opts.history,
    ...(opts.symbolSpec ? { symbolSpec: opts.symbolSpec } : {}),
  });

  // ONE facade, ONE runtime, ONE EA instance — backing starts on the sim.
  const switchable = makeSwitchableProviders(sim.providers);
  const rt: Runtime = createRuntime(switchable.providers, ctx);
  const instance = opts.factory(rt, opts.inputs);

  const liveSummary: LiveRunSummary = { ticksSeen: 0, ticksHandled: 0, timerFires: 0, initRetcode: 0 };

  // ── OnInit (once, at the very start) ──
  const initRet = await instance.OnInit?.();
  liveSummary.initRetcode = typeof initRet === 'number' ? initRet : 0;
  if (typeof initRet === 'number' && initRet === INIT_FAILED) {
    await instance.OnDeinit?.(0);
    return { report: sim.report(), live: liveSummary, initFailed: true };
  }

  // ── Phase A: backtest replay (mirrors the standalone backtest driver) ──
  opts.onPhase?.('backtest');
  const barDuration = timeframeSeconds(ctx.timeframe);
  let barsSinceTimerFire = 0;
  while (sim.step()) {
    if (hasSetContext(rt)) rt.setContext(ctx);
    if (instance.OnTick !== undefined) await instance.OnTick();
    if (instance.OnTimer !== undefined) {
      const interval = timerSeconds(rt);
      if (interval > 0) {
        barsSinceTimerFire++;
        const barsPerFire = barDuration > 0 ? Math.max(1, Math.ceil(interval / barDuration)) : 1;
        if (barsSinceTimerFire >= barsPerFire) { barsSinceTimerFire = 0; await instance.OnTimer(); }
      } else {
        barsSinceTimerFire = 0;
      }
    }
  }
  const report = sim.report();
  opts.onBacktestComplete?.(report);

  // ── Seam: flip the backing to the live providers (NO OnInit/OnDeinit here) ──
  switchable.switchTo(opts.live.providers);
  if (hasSetContext(rt)) rt.setContext(ctx); // re-read digits/point from the live feed
  opts.onPhase?.('live');

  // ── Phase B: live event loop (mirrors the standalone live driver) ──
  // `stopped` makes the teardown clean: once the window closes we dispatch NO
  // further OnTick/OnTimer, so a tick the broker streams AFTER the run ends can
  // never call into a de-initialised EA (OnDeinit may have released indicator
  // handles — calling OnTick then throws "invalid handle"). We also drain any
  // in-flight handler before OnDeinit so deinit never overlaps a running OnTick.
  let busy = false;
  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();
  const dispatch = (kind: 'tick' | 'timer', symbol: string): void => {
    if (stopped || busy) return; // stopped → tearing down; busy → next event re-evaluates
    busy = true;
    inflight = (async () => {
      try {
        opts.onActivity?.(kind, symbol);
        if (kind === 'tick') { await instance.OnTick?.(); liveSummary.ticksHandled++; }
        else await instance.OnTimer?.();
      } finally {
        busy = false;
      }
    })();
  };

  opts.live.onTick((symbol) => {
    if (stopped) return;
    liveSummary.ticksSeen++;
    dispatch('tick', symbol);
  });

  const timers: NodeJS.Timeout[] = [];
  const timerSec = timerSeconds(rt);
  if (timerSec > 0) {
    timers.push(setInterval(() => { if (!stopped) { liveSummary.timerFires++; dispatch('timer', opts.symbol); } }, timerSec * 1000));
  }
  const refreshMs = opts.refreshMs ?? 5_000;
  timers.push(setInterval(() => { if (!stopped) void opts.live.refresh(); }, refreshMs));

  const durationMs = opts.durationMs ?? 60_000;
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      stopped = true;
      for (const t of timers) clearInterval(t);
      opts.signal?.removeEventListener('abort', stop);
      resolve();
    };
    if (durationMs > 0) setTimeout(stop, durationMs);
    opts.signal?.addEventListener('abort', stop, { once: true });
  });

  // ── OnDeinit (once, at the very end; after any in-flight handler finishes) ──
  await inflight;
  await instance.OnDeinit?.(0);
  return { report, live: liveSummary, initFailed: false };
}
