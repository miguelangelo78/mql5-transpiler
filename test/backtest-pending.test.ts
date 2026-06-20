/**
 * Agent B — backtest engine: pending-order book + intrabar fill + intrabar
 * SL/TP + OnTimer cadence.
 *
 * These tests pin the §21 modelling choices documented in
 * src/runtime/providers/backtest/broker.ts (markBar) and src/engine/driver.ts:
 *   - pending activation rules (buyLimit/sellLimit/buyStop/sellStop),
 *   - fill AT the activation price (not bar close),
 *   - SL/TP trigger rules + the conservative SL-wins-when-both-hit choice,
 *   - OnTimer firing once per bar at the bar tier.
 *
 * All bar series are built by hand so every trigger is deterministic.
 */

import { describe, it, expect } from 'vitest';
import { createBacktest, defaultSymbolSpec } from '../src/runtime/providers/backtest';
import { runBacktest } from '../src/engine/driver';
import type { Bar, SymbolSpec } from '../src/runtime/providers/types';
import type {
  ExpertFactory,
  ExpertInstance,
  Runtime,
} from '../src/runtime/runtime';

// ── helpers ────────────────────────────────────────────────────────────────

const M1 = 1; // PERIOD_M1 → 60s bars
const T0 = 1_700_000_000;

/** A single bar with sane defaults; pass the OHLC that matters for the test. */
function bar(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
): Bar {
  return {
    time: T0 + i * 60,
    open: o,
    high: h,
    low: l,
    close: c,
    tickVolume: 1,
    spread: 0,
    realVolume: 0,
  };
}

/** 1-lot FX-like spec, contractSize 100000, zero spread (so bid===ask===close). */
const SPEC: SymbolSpec = defaultSymbolSpec('EURUSD');

function makeSim(bars: Bar[], initialBalance = 10_000) {
  return createBacktest({
    symbol: 'EURUSD',
    timeframe: M1,
    bars,
    initialBalance,
    spreadPoints: 0,
    symbolSpec: SPEC,
  });
}

/**
 * Drive a sim manually one bar at a time (no EA) so the test directly observes
 * the broker's pending book + intrabar engine. `markBar` runs inside step().
 */
function stepAll(sim: ReturnType<typeof makeSim>): void {
  while (sim.step()) {
    /* advance to exhaustion; markBar runs each step */
  }
}

// ── (a) a buyLimit FILLS at the limit price when a later bar.low crosses it ──

describe('pending-order book: buyLimit activation', () => {
  it('fills at the limit price (not bar close) and becomes a position', async () => {
    // bar0 close 1.1000 (above the limit). bar1 dips to low 1.0940 — crosses
    // the 1.0950 buy-limit → fills AT 1.0950. bar1 closes back at 1.0980.
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.0990, 1.0990, 1.0940, 1.0980),
    ];
    const sim = makeSim(bars);
    const broker = sim.providers.broker;

    // Step to bar0, then place the pending (so it can only fill from bar1 on).
    expect(sim.step()).toBe(true); // bar0 visible
    expect(broker.placePendingOrder).toBeDefined();
    const res = await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'buyLimit',
      volume: 0.10,
      price: 1.0950,
      sl: 1.0900,
      tp: 1.1050,
    });
    expect(res.ok).toBe(true);
    const ticket = res.order;
    expect(ticket).toBeGreaterThan(0);
    expect(broker.getPendingOrder!(ticket)).not.toBeNull();
    expect(broker.getPosition('EURUSD')).toBeNull();

    // Step to bar1 → intrabar engine triggers the limit.
    expect(sim.step()).toBe(true);

    // Pending consumed; a long position exists, opened AT the limit price.
    expect(broker.getPendingOrder!(ticket)).toBeNull();
    const pos = broker.getPosition('EURUSD');
    expect(pos).not.toBeNull();
    expect(pos!.side).toBe('buy');
    expect(pos!.volume).toBeCloseTo(0.10, 10);
    expect(pos!.openPrice).toBeCloseTo(1.0950, 10); // AT the limit, NOT bar close
    expect(pos!.sl).toBeCloseTo(1.0900, 10);
    expect(pos!.tp).toBeCloseTo(1.1050, 10);

    // An open deal was recorded at the fill price.
    const report = sim.report();
    const opens = report.deals.filter((d) => d.kind === 'open');
    expect(opens.length).toBe(1);
    expect(opens[0].price).toBeCloseTo(1.0950, 10);
    expect(opens[0].profit).toBe(0);
  });

  it('does NOT fill while bar.low stays above the limit', async () => {
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.0990, 1.0990, 1.0960, 1.0980), // low 1.0960 > limit 1.0950
    ];
    const sim = makeSim(bars);
    const broker = sim.providers.broker;
    sim.step();
    const res = await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'buyLimit',
      volume: 0.10,
      price: 1.0950,
    });
    sim.step();
    expect(broker.getPendingOrder!(res.order)).not.toBeNull(); // still resting
    expect(broker.getPosition('EURUSD')).toBeNull();
  });
});

// ── (b) that position closes at its TP with correct realised P/L ─────────────

describe('intrabar TP on the filled position', () => {
  it('closes at TP when a bar.high reaches it; P/L is exact', async () => {
    // bar0 place. bar1 fills the buy-limit at 1.0950. bar2 rallies to high
    // 1.1060 — reaches the TP 1.1050 → closes AT 1.1050 (long TP).
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.0990, 1.0990, 1.0940, 1.0980), // fills at 1.0950
      bar(2, 1.0990, 1.1060, 1.0985, 1.1040), // high 1.1060 ≥ TP 1.1050
    ];
    const sim = makeSim(bars, 10_000);
    const broker = sim.providers.broker;

    sim.step(); // bar0
    await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'buyLimit',
      volume: 0.10,
      price: 1.0950,
      sl: 1.0900,
      tp: 1.1050,
    });
    sim.step(); // bar1 → fills at 1.0950
    expect(broker.getPosition('EURUSD')).not.toBeNull();

    sim.step(); // bar2 → TP hit
    expect(broker.getPosition('EURUSD')).toBeNull(); // closed

    // Realised P/L = (1.1050 - 1.0950) * 1 * 0.10 * 100000 = 0.0100 * 10000 = 100.
    const report = sim.report();
    const closes = report.deals.filter((d) => d.kind === 'close');
    expect(closes.length).toBe(1);
    expect(closes[0].price).toBeCloseTo(1.1050, 10);
    const expectedPL = (1.1050 - 1.0950) * 0.10 * SPEC.contractSize;
    expect(closes[0].profit).toBeCloseTo(expectedPL, 6);
    expect(closes[0].comment).toBe('[tp]');
    expect(report.finalBalance).toBeCloseTo(10_000 + expectedPL, 6);
    expect(report.wins).toBe(1);
    expect(report.losses).toBe(0);
  });
});

// ── (c) SL trigger symmetric (and for a short, too) ──────────────────────────

describe('intrabar SL trigger', () => {
  it('long closes at SL when bar.low reaches it; loss is exact', async () => {
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.0990, 1.0990, 1.0940, 1.0980), // fills buy-limit at 1.0950
      bar(2, 1.0980, 1.0985, 1.0890, 1.0900), // low 1.0890 ≤ SL 1.0900
    ];
    const sim = makeSim(bars, 10_000);
    const broker = sim.providers.broker;

    sim.step();
    await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'buyLimit',
      volume: 0.10,
      price: 1.0950,
      sl: 1.0900,
      tp: 1.1050,
    });
    sim.step(); // fill at 1.0950
    sim.step(); // SL hit at 1.0900

    expect(broker.getPosition('EURUSD')).toBeNull();
    const closes = sim.report().deals.filter((d) => d.kind === 'close');
    expect(closes.length).toBe(1);
    expect(closes[0].price).toBeCloseTo(1.0900, 10);
    const expectedPL = (1.0900 - 1.0950) * 0.10 * SPEC.contractSize; // negative
    expect(closes[0].profit).toBeCloseTo(expectedPL, 6);
    expect(closes[0].profit).toBeLessThan(0);
    expect(closes[0].comment).toBe('[sl]');
  });

  it('short (sellLimit) closes at SL when bar.high reaches it', async () => {
    // sellLimit at 1.1050 fills when a bar.high ≥ 1.1050. SL for a short is
    // ABOVE entry: SL 1.1100, TP 1.0950. bar2 spikes high 1.1110 → SL hit.
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.1010, 1.1060, 1.1005, 1.1040), // high 1.1060 ≥ sellLimit 1.1050
      bar(2, 1.1040, 1.1110, 1.1035, 1.1090), // high 1.1110 ≥ SL 1.1100
    ];
    const sim = makeSim(bars, 10_000);
    const broker = sim.providers.broker;

    sim.step();
    await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'sellLimit',
      volume: 0.10,
      price: 1.1050,
      sl: 1.1100,
      tp: 1.0950,
    });
    sim.step(); // fill at 1.1050 (short)
    const pos = broker.getPosition('EURUSD');
    expect(pos).not.toBeNull();
    expect(pos!.side).toBe('sell');
    expect(pos!.openPrice).toBeCloseTo(1.1050, 10);

    sim.step(); // bar2 → short SL hit at 1.1100
    expect(broker.getPosition('EURUSD')).toBeNull();
    const closes = sim.report().deals.filter((d) => d.kind === 'close');
    expect(closes.length).toBe(1);
    expect(closes[0].price).toBeCloseTo(1.1100, 10);
    // Short P/L = (entry - exit) * vol * contract = (1.1050-1.1100)*0.10*100000.
    const expectedPL = (1.1050 - 1.1100) * 0.10 * SPEC.contractSize;
    expect(closes[0].profit).toBeCloseTo(expectedPL, 6);
    expect(closes[0].profit).toBeLessThan(0);
    expect(closes[0].comment).toBe('[sl]');
  });
});

// ── (d) when SL and TP are both inside ONE bar, SL wins (documented) ─────────

describe('both SL and TP inside one bar → SL wins (conservative §21 choice)', () => {
  it('long: closes at SL, not TP, with the loss booked', async () => {
    // Fill a buy-limit at 1.0950 (SL 1.0900, TP 1.1050). The VERY NEXT bar
    // straddles BOTH: low 1.0890 (≤ SL) AND high 1.1060 (≥ TP). SL must win.
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.0990, 1.0990, 1.0940, 1.0980), // fills at 1.0950
      bar(2, 1.0980, 1.1060, 1.0890, 1.0980), // BOTH SL(1.0890) and TP(1.1060)
    ];
    const sim = makeSim(bars, 10_000);
    const broker = sim.providers.broker;

    sim.step();
    await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'buyLimit',
      volume: 0.10,
      price: 1.0950,
      sl: 1.0900,
      tp: 1.1050,
    });
    sim.step(); // fill
    sim.step(); // straddle bar

    expect(broker.getPosition('EURUSD')).toBeNull();
    const closes = sim.report().deals.filter((d) => d.kind === 'close');
    expect(closes.length).toBe(1);
    // SL wins → exit at SL price, loss booked, comment [sl].
    expect(closes[0].price).toBeCloseTo(1.0900, 10);
    expect(closes[0].comment).toBe('[sl]');
    expect(closes[0].profit).toBeLessThan(0);
    const expectedPL = (1.0900 - 1.0950) * 0.10 * SPEC.contractSize;
    expect(closes[0].profit).toBeCloseTo(expectedPL, 6);
  });

  it('short: also SL-wins when one bar straddles both', async () => {
    // sellLimit fills at 1.1050 (SL 1.1100 above, TP 1.0950 below). Next bar
    // straddles: high 1.1110 (≥ SL) AND low 1.0940 (≤ TP). SL must win.
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.1010, 1.1060, 1.1005, 1.1040), // fills sellLimit at 1.1050
      bar(2, 1.1040, 1.1110, 1.0940, 1.1040), // BOTH SL(1.1110) and TP(1.0940)
    ];
    const sim = makeSim(bars, 10_000);
    const broker = sim.providers.broker;

    sim.step();
    await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'sellLimit',
      volume: 0.10,
      price: 1.1050,
      sl: 1.1100,
      tp: 1.0950,
    });
    sim.step(); // fill (short)
    sim.step(); // straddle bar

    expect(broker.getPosition('EURUSD')).toBeNull();
    const closes = sim.report().deals.filter((d) => d.kind === 'close');
    expect(closes.length).toBe(1);
    expect(closes[0].price).toBeCloseTo(1.1100, 10); // SL price (above entry)
    expect(closes[0].comment).toBe('[sl]');
    expect(closes[0].profit).toBeLessThan(0);
  });
});

// ── extra: buyStop / sellStop activation rules (round out the dispatch) ──────

describe('pending-order book: stop orders', () => {
  it('buyStop fills when bar.high ≥ price', async () => {
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.1005, 1.1060, 1.1000, 1.1050), // high 1.1060 ≥ buyStop 1.1050
    ];
    const sim = makeSim(bars);
    const broker = sim.providers.broker;
    sim.step();
    const res = await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'buyStop',
      volume: 0.10,
      price: 1.1050,
    });
    sim.step();
    expect(broker.getPendingOrder!(res.order)).toBeNull();
    const pos = broker.getPosition('EURUSD');
    expect(pos!.side).toBe('buy');
    expect(pos!.openPrice).toBeCloseTo(1.1050, 10);
  });

  it('sellStop fills when bar.low ≤ price', async () => {
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.0995, 1.1000, 1.0940, 1.0950), // low 1.0940 ≤ sellStop 1.0950
    ];
    const sim = makeSim(bars);
    const broker = sim.providers.broker;
    sim.step();
    const res = await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'sellStop',
      volume: 0.10,
      price: 1.0950,
    });
    sim.step();
    expect(broker.getPendingOrder!(res.order)).toBeNull();
    const pos = broker.getPosition('EURUSD');
    expect(pos!.side).toBe('sell');
    expect(pos!.openPrice).toBeCloseTo(1.0950, 10);
  });
});

// ── extra: deletePendingOrder removes a resting order ────────────────────────

describe('deletePendingOrder', () => {
  it('removes a resting pending so it never fills', async () => {
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.0990, 1.0990, 1.0940, 1.0980), // would cross 1.0950 if present
    ];
    const sim = makeSim(bars);
    const broker = sim.providers.broker;
    sim.step();
    const res = await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'buyLimit',
      volume: 0.10,
      price: 1.0950,
    });
    const del = await broker.deletePendingOrder!(res.order);
    expect(del.ok).toBe(true);
    expect(broker.getPendingOrder!(res.order)).toBeNull();
    sim.step();
    expect(broker.getPosition('EURUSD')).toBeNull(); // never filled
  });
});

// ── (e) OnTimer fires once per bar when EventSetTimer is set ──────────────────

describe('driver: OnTimer cadence', () => {
  /**
   * A minimal hand-built expert factory + runtime stub. We DON'T use the real
   * runtime here — the driver only needs an ExpertInstance and a Runtime that
   * exposes __timerSeconds(). But the driver builds its OWN runtime via
   * createRuntime(sim.providers, ctx); so to exercise the cadence we instead
   * test against the REAL runtime by emitting the timer through it. Simplest
   * correct path (§30/§32): inject a factory that uses rt.EventSetTimer and
   * counts OnTimer fires; the driver reads rt.__timerSeconds().
   */
  it('fires OnTimer once per bar at a sub-bar interval (M1 bars, 60s timer)', async () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 5; i++) bars.push(bar(i, 1.1, 1.1, 1.1, 1.1));

    let timerFires = 0;
    let tickFires = 0;
    const factory: ExpertFactory = (rt: Runtime): ExpertInstance => ({
      __inputs: {},
      OnInit: () => {
        // EventSetTimer is optional on the runtime; assert present then call.
        expect(rt.EventSetTimer).toBeDefined();
        rt.EventSetTimer!(60); // 60s = one M1 bar → once per bar
        return 0; // INIT_SUCCEEDED
      },
      OnTimer: () => {
        timerFires++;
      },
      OnTick: () => {
        tickFires++;
      },
    });

    const report = await runBacktest({
      factory,
      config: {
        symbol: 'EURUSD',
        timeframe: M1,
        bars,
        initialBalance: 10_000,
        symbolSpec: SPEC,
      },
    });

    // 5 bars → OnTick every bar (5), OnTimer once per bar (5).
    expect(report.barsProcessed).toBe(5);
    expect(tickFires).toBe(5);
    expect(timerFires).toBe(5);
  });

  it('fires OnTimer every ceil(interval/barDuration) bars when interval > barDuration', async () => {
    // M1 bars (60s). Timer 180s → ceil(180/60)=3 → fire every 3rd bar.
    const bars: Bar[] = [];
    for (let i = 0; i < 7; i++) bars.push(bar(i, 1.1, 1.1, 1.1, 1.1));

    let timerFires = 0;
    const factory: ExpertFactory = (rt: Runtime): ExpertInstance => ({
      __inputs: {},
      OnInit: () => {
        rt.EventSetTimer!(180);
        return 0;
      },
      OnTimer: () => {
        timerFires++;
      },
    });

    await runBacktest({
      factory,
      config: { symbol: 'EURUSD', timeframe: M1, bars, symbolSpec: SPEC },
    });

    // 7 bars, fire on bars 3 and 6 → 2 fires.
    expect(timerFires).toBe(2);
  });

  it('never fires OnTimer when EventSetTimer is not called', async () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 4; i++) bars.push(bar(i, 1.1, 1.1, 1.1, 1.1));

    let timerFires = 0;
    const factory: ExpertFactory = (_rt: Runtime): ExpertInstance => ({
      __inputs: {},
      OnInit: () => 0,
      OnTimer: () => {
        timerFires++;
      },
    });

    await runBacktest({
      factory,
      config: { symbol: 'EURUSD', timeframe: M1, bars, symbolSpec: SPEC },
    });

    expect(timerFires).toBe(0);
  });
});

// ── extra: equity/balance bookkeeping sanity on a full round-trip ────────────

describe('report bookkeeping on a pending→position→TP round-trip', () => {
  it('drives end-to-end with stepAll and produces one win', async () => {
    const bars = [
      bar(0, 1.1000, 1.1010, 1.0990, 1.1000),
      bar(1, 1.0990, 1.0990, 1.0940, 1.0980),
      bar(2, 1.0990, 1.1060, 1.0985, 1.1040),
    ];
    const sim = makeSim(bars, 10_000);
    const broker = sim.providers.broker;
    sim.step();
    await broker.placePendingOrder!({
      symbol: 'EURUSD',
      kind: 'buyLimit',
      volume: 0.10,
      price: 1.0950,
      sl: 1.0900,
      tp: 1.1050,
    });
    stepAll(sim);
    const report = sim.report();
    expect(report.totalTrades).toBe(1);
    expect(report.wins).toBe(1);
    expect(report.netProfit).toBeGreaterThan(0);
    expect(report.finalBalance).toBeGreaterThan(10_000);
  });
});
