/**
 * Replay-then-live driver tests — the hybrid mode (`ea:live --replay-history`):
 * backtest the history, then keep the SAME EA instance running live.
 *
 * The load-bearing claims this pins:
 *   1. ONE EA instance spans both phases — internal state carries (a tick counter
 *      started in Phase A keeps counting into Phase B; OnInit/OnDeinit fire once).
 *   2. The broker SWITCHES at the seam — what the EA reads as the account flips
 *      from the Phase-A sim (initialBalance we set) to the real (mock) live
 *      account, proving the provider facade re-points without rebuilding the EA.
 *   3. The Phase-A report is the sim's, produced before live starts.
 *   4. An INIT_FAILED OnInit aborts before any phase trades (no live run).
 *
 * The live providers are the REAL TickerallProviders built over a mock SDK
 * client (same approach as tickerall-provider.test.ts), so the seam is exercised
 * end-to-end without a broker.
 */

import { describe, expect, it } from 'vitest';
import type { Tickerall } from '@tickerall/sdk';

import { createTickerallProviders } from '../src/runtime/providers/tickerall';
import { runReplayThenLive } from '../src/engine/replay-live-driver';
import type { ExpertFactory } from '../src/runtime/runtime';
import type { Bar } from '../src/runtime/providers/types';

// A minimal mock of the SDK surface createTickerallProviders touches. The live
// (mock) account balance is 10000 — distinct from the Phase-A sim balance below.
function makeMockClient() {
  let tickCb: ((e: unknown) => void) | undefined;
  const stream = {
    subscribeTicks: async () => {},
    subscribePositions: async () => {},
    subscribeAccount: async () => {},
    on: (ev: string, cb: (e: unknown) => void) => { if (ev === 'tick') tickCb = cb; },
    close: async () => {},
    emitTick: (e: unknown) => tickCb?.(e),
  };
  const client = {
    sessions: {
      keepAlive: async () => ({ accountId: 'acc_live', isDemo: true, status: 'connected' }),
      end: async () => {},
    },
    accounts: {
      symbolSpecs: async () => [
        { name: 'EURUSD', volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, specSource: 'broker', digits: 5, point: 1e-5, contractSize: 100000, tickValue: 1 },
      ],
      get: async () => ({
        status: 'online', id: 'acc_live', broker: 'mt5', server: 'X', accountNumber: '99', isDemo: true,
        account: { name: 'Live', accountType: 'demo', leverage: 100, balance: 10000, currency: 'USD', equity: 10000, margin: 0, freeMargin: 10000 },
        positions: [],
      }),
    },
    candles: { get: async () => [
      { timestamp: 1000, open: 1.1, high: 1.11, low: 1.09, close: 1.105, bid: 1.105, tickVolume: 1, spread: 1e-4 },
    ] },
    orders: { listPending: async () => [] },
    history: { get: async () => [] },
    stream: { connect: async () => stream },
  };
  return { client: client as unknown as Tickerall, stream };
}

function bars(): Bar[] {
  // Three flat-ish EURUSD bars for the Phase-A backtest.
  return [0, 1, 2].map((i) => ({
    time: 1000 + i * 60, open: 1.1, high: 1.1 + 0.001, low: 1.1 - 0.001, close: 1.1,
    tickVolume: 1, spread: 0, realVolume: 0,
  }));
}

/** A probe EA: counts OnTick calls and records the account balance it sees each
 *  tick. No trades — we're testing the driver wiring, not order mechanics. */
function probeFactory() {
  const log = { init: 0, deinit: 0, ticks: 0, balances: [] as number[] };
  const factory: ExpertFactory = (rt) => ({
    __inputs: {},
    OnInit() { log.init++; return 0; },
    OnTick() {
      log.ticks++;
      log.balances.push(rt.AccountInfoDouble(rt.ACCOUNT_BALANCE));
    },
    OnDeinit() { log.deinit++; },
  });
  return { factory, log };
}

describe('runReplayThenLive (hybrid backtest → live, same instance)', () => {
  it('carries one EA instance across the seam and switches the broker sim→live', async () => {
    const { client, stream } = makeMockClient();
    const live = await createTickerallProviders({
      apiKey: 'x', broker: 'mt5', server: 'X', account: 1, password: 'y',
      symbol: 'EURUSD', timeframe: 5, client,
    });
    const { factory, log } = probeFactory();

    const result = await runReplayThenLive({
      factory,
      history: bars(),
      initialBalance: 5000, // Phase-A sim balance — distinct from the live 10000
      live,
      symbol: 'EURUSD',
      timeframe: 5,
      durationMs: 60,
      // Emit one live tick shortly after the live phase begins (after the onTick
      // listener is registered) so Phase B handles exactly one tick.
      onPhase: (p) => {
        if (p === 'live') setTimeout(() => stream.emitTick({ type: 'tick', accountId: 'acc_live', symbol: 'EURUSD', bid: 1.2, ask: 1.2002, timestamp: '2024-01-01T00:00:00Z' }), 5);
      },
    });
    await live.disconnect();

    // (1) one session: OnInit + OnDeinit once each
    expect(log.init).toBe(1);
    expect(log.deinit).toBe(1);
    // (1) state carries: 3 history bars + 1 live tick on the SAME counter
    expect(log.ticks).toBe(4);
    // (2) broker switched at the seam: sim balance for the 3 backtest bars, then
    //     the real (mock) live balance for the live tick
    expect(log.balances.slice(0, 3)).toEqual([5000, 5000, 5000]);
    expect(log.balances[3]).toBe(10000);
    // (3) the Phase-A report is the sim's (the balance we configured)
    expect(result.report.initialBalance).toBe(5000);
    expect(result.report.barsProcessed).toBe(3);
    expect(result.initFailed).toBe(false);
    // (2) live summary saw the one tick
    expect(result.live.ticksHandled).toBe(1);
  });

  it('does not dispatch ticks after the window closes (post-deinit handle-release race)', async () => {
    // The seam bug live-verification caught: an indicator EA releases its handles
    // in OnDeinit; a broker tick arriving AFTER the run window (post-OnDeinit) must
    // NOT call OnTick — else CopyBuffer hits a freed handle and throws.
    const { client, stream } = makeMockClient();
    const live = await createTickerallProviders({
      apiKey: 'x', broker: 'mt5', server: 'X', account: 1, password: 'y',
      symbol: 'EURUSD', timeframe: 5, client,
    });
    const log = { ticks: 0, deinitDone: false, tickAfterDeinit: false };
    const factory: ExpertFactory = (rt) => {
      let h: number = rt.INVALID_HANDLE;
      return {
        __inputs: {},
        OnInit() { h = rt.iMA(rt._Symbol, rt._Period, 2, 0, rt.MODE_SMA, rt.PRICE_CLOSE); return 0; },
        OnTick() {
          if (log.deinitDone) log.tickAfterDeinit = true;
          const b: number[] = [];
          rt.CopyBuffer(h, 0, 0, 2, b); // would throw "invalid handle" on a freed handle
          log.ticks++;
        },
        OnDeinit() { log.deinitDone = true; rt.IndicatorRelease(h); },
      };
    };
    const emit = () => stream.emitTick({ type: 'tick', accountId: 'acc_live', symbol: 'EURUSD', bid: 1.2, ask: 1.2002, timestamp: '2024-01-01T00:00:00Z' });

    const result = await runReplayThenLive({
      factory, history: bars(), initialBalance: 5000, live,
      symbol: 'EURUSD', timeframe: 5, durationMs: 40,
      onPhase: (p) => { if (p === 'live') setTimeout(emit, 8); }, // one tick inside the window
    });
    const handledInWindow = result.live.ticksHandled;
    // Window has closed and OnDeinit has freed the handle. Late broker ticks now:
    emit(); emit();
    await new Promise((r) => setTimeout(r, 15)); // give any (wrongly) dispatched OnTick time to run

    await live.disconnect();
    expect(log.deinitDone).toBe(true);
    expect(handledInWindow).toBeGreaterThanOrEqual(1);     // the in-window tick was handled
    expect(log.tickAfterDeinit).toBe(false);               // NO OnTick after deinit
    expect(result.live.ticksHandled).toBe(handledInWindow); // late ticks changed nothing
  });

  it('aborts on INIT_FAILED — neither phase runs, OnDeinit still fires', async () => {
    const { client } = makeMockClient();
    const live = await createTickerallProviders({
      apiKey: 'x', broker: 'mt5', server: 'X', account: 1, password: 'y',
      symbol: 'EURUSD', timeframe: 5, client,
    });
    let ticks = 0, deinit = 0;
    const factory: ExpertFactory = (rt) => ({
      __inputs: {},
      OnInit() { return rt.INIT_FAILED; },
      OnTick() { ticks++; },
      OnDeinit() { deinit++; },
    });

    const result = await runReplayThenLive({
      factory, history: bars(), initialBalance: 5000, live,
      symbol: 'EURUSD', timeframe: 5, durationMs: 20,
    });
    await live.disconnect();

    expect(result.initFailed).toBe(true);
    expect(ticks).toBe(0);      // no backtest, no live
    expect(deinit).toBe(1);     // OnDeinit still called
    expect(result.live.ticksHandled).toBe(0);
  });
});
