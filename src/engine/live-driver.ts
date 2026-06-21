/**
 * Live driver — run a transpiled EA against a real broker via the TickerAll
 * egress. Where the backtest driver STEPS bars deterministically, the live
 * driver is EVENT-DRIVEN: it fires the EA's OnTick on each market tick and
 * OnTimer on the configured interval, against live data + a real (demo or live)
 * broker account.
 *
 * The SAME transpiled EA runs here as in backtest — only the provider differs.
 *
 * Safety: handler invocations are serialised through a single lock so a trade
 * placed by one OnTick/OnTimer can never overlap another (a tick arriving while
 * a handler runs is dropped; the next tick re-evaluates with fresh state).
 */

import type { ExpertFactory, Inputs, Runtime } from '../runtime/runtime';
import { createRuntime } from '../runtime';
import type { RuntimeContext } from './types';
import type { TickerallProviders } from '../runtime/providers/tickerall';

export interface RunLiveOptions {
  factory: ExpertFactory;
  live: TickerallProviders;
  symbol: string;
  timeframe: number;
  inputs?: Inputs;
  /** Stop after this many ms (default 60_000). Pass 0 to run until aborted. */
  durationMs?: number;
  /** Re-pull positions/account/pending every N ms (default 5_000). */
  refreshMs?: number;
  /** Optional abort signal to stop early. */
  signal?: AbortSignal;
  /** Called once per handler dispatch (for logging). */
  onActivity?: (what: 'tick' | 'timer', symbol: string) => void;
}

export interface LiveRunSummary {
  ticksSeen: number;
  ticksHandled: number;
  timerFires: number;
  initRetcode: number;
}

export async function runLive(opts: RunLiveOptions): Promise<LiveRunSummary> {
  const ctx: RuntimeContext = { symbol: opts.symbol, timeframe: opts.timeframe };
  const rt: Runtime = createRuntime(opts.live.providers, ctx);
  const instance = opts.factory(rt, opts.inputs);

  const summary: LiveRunSummary = { ticksSeen: 0, ticksHandled: 0, timerFires: 0, initRetcode: 0 };

  // OnInit — bail before trading if it reports failure.
  const initRet = await instance.OnInit?.();
  summary.initRetcode = typeof initRet === 'number' ? initRet : 0;
  if (typeof initRet === 'number' && initRet === rt.INIT_FAILED) {
    await instance.OnDeinit?.(0);
    return summary;
  }

  // Single lock: handlers never overlap (no double-trade). `stopped` makes the
  // teardown clean — once the run window closes we dispatch NO further
  // OnTick/OnTimer, so a tick the broker streams AFTER the run ends can never
  // call into a de-initialised EA (OnDeinit may release indicator handles;
  // calling OnTick then would throw). We also drain any in-flight handler before
  // OnDeinit so deinit never overlaps a running OnTick.
  let busy = false;
  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();
  const dispatch = (kind: 'tick' | 'timer', symbol: string): void => {
    if (stopped || busy) return; // stopped → tearing down; busy → next event re-evaluates
    busy = true;
    inflight = (async () => {
      try {
        opts.onActivity?.(kind, symbol);
        if (kind === 'tick') { await instance.OnTick?.(); summary.ticksHandled++; }
        else await instance.OnTimer?.();
      } finally {
        busy = false;
      }
    })();
  };

  opts.live.onTick((symbol) => {
    if (stopped) return;
    summary.ticksSeen++;
    dispatch('tick', symbol);
  });

  const timerSec = rt.__timerSeconds?.() ?? 0;
  const timers: NodeJS.Timeout[] = [];
  if (timerSec > 0) {
    timers.push(setInterval(() => {
      if (stopped) return;
      summary.timerFires++;
      dispatch('timer', opts.symbol);
    }, timerSec * 1000));
  }

  // Keep the broker caches fresh (positions/account/pending/history).
  const refreshMs = opts.refreshMs ?? 5_000;
  timers.push(setInterval(() => { if (!stopped) void opts.live.refresh(); }, refreshMs));

  // Run for the duration (or until aborted).
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

  await inflight;
  await instance.OnDeinit?.(0);
  return summary;
}
