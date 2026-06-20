import { describe, it, expect } from 'vitest';
import {
  generateSyntheticBars,
  timeframeSeconds,
  mulberry32,
} from '../src/data/synthetic';
import { createBacktest, defaultSymbolSpec } from '../src/runtime/providers/backtest';
import type { Bar, SymbolSpec } from '../src/runtime/providers/types';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Simple SMA of `close` over `period`, aligned so result[i] = SMA ending at i. */
function smaClose(bars: readonly Bar[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/** Count fast/slow SMA crossovers (sign changes of fast-slow) across the series. */
function countCrossovers(bars: readonly Bar[], fastP: number, slowP: number): number {
  const fast = smaClose(bars, fastP);
  const slow = smaClose(bars, slowP);
  let crossings = 0;
  let prevSign = 0;
  for (let i = 0; i < bars.length; i++) {
    const f = fast[i];
    const s = slow[i];
    if (f === null || s === null) continue;
    const diff = f - s;
    const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) crossings++;
    if (sign !== 0) prevSign = sign;
  }
  return crossings;
}

const SYNTH = {
  symbol: 'EURUSD',
  timeframe: 15, // PERIOD_M15
  bars: 400,
  startPrice: 1.1,
  startTime: 1_700_000_000,
  seed: 12345,
  cycleAmplitude: 0.02,
  cyclePeriodBars: 60,
  noise: 0.0008,
  point: 0.00001,
} as const;

// ── (a) synthetic generator ──────────────────────────────────────────────────

describe('generateSyntheticBars', () => {
  it('is deterministic: same seed ⇒ identical bars', () => {
    const a = generateSyntheticBars({ ...SYNTH });
    const b = generateSyntheticBars({ ...SYNTH });
    expect(a).toEqual(b);
    expect(a.length).toBe(SYNTH.bars);
  });

  it('different seed ⇒ different bars', () => {
    const a = generateSyntheticBars({ ...SYNTH });
    const b = generateSyntheticBars({ ...SYNTH, seed: 999 });
    expect(a).not.toEqual(b);
  });

  it('produces ≥2 SMA(10)/SMA(30) crossovers (so the sample EA trades)', () => {
    const bars = generateSyntheticBars({ ...SYNTH });
    const crossings = countCrossovers(bars, 10, 30);
    expect(crossings).toBeGreaterThanOrEqual(2);
  });

  it('bars are chronological with timeframe-correct spacing', () => {
    const bars = generateSyntheticBars({ ...SYNTH });
    const dt = timeframeSeconds(SYNTH.timeframe);
    expect(dt).toBe(900); // M15
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].time - bars[i - 1].time).toBe(dt);
    }
  });

  it('OHLC invariants hold (low ≤ open,close ≤ high)', () => {
    const bars = generateSyntheticBars({ ...SYNTH });
    for (const b of bars) {
      expect(b.low).toBeLessThanOrEqual(b.open);
      expect(b.low).toBeLessThanOrEqual(b.close);
      expect(b.high).toBeGreaterThanOrEqual(b.open);
      expect(b.high).toBeGreaterThanOrEqual(b.close);
    }
  });

  it('open of bar i+1 equals close of bar i (continuous series)', () => {
    const bars = generateSyntheticBars({ ...SYNTH });
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].open).toBe(bars[i - 1].close);
    }
  });
});

describe('mulberry32', () => {
  it('is deterministic and bounded in [0,1)', () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('timeframeSeconds', () => {
  it('decodes M-series minutes and H/D bitfield encodings', () => {
    expect(timeframeSeconds(1)).toBe(60); // M1
    expect(timeframeSeconds(5)).toBe(300); // M5
    expect(timeframeSeconds(15)).toBe(900); // M15
    expect(timeframeSeconds(30)).toBe(1800); // M30
    expect(timeframeSeconds(16385)).toBe(3600); // H1 (0x4001)
    expect(timeframeSeconds(16388)).toBe(14400); // H4
    expect(timeframeSeconds(16408)).toBe(86400); // D1
  });
});

// ── (b) feed visibility ──────────────────────────────────────────────────────

describe('feed visibility grows by 1 per step()', () => {
  it('history length tracks step count; current bar is last', () => {
    const sim = createBacktest({
      symbol: SYNTH.symbol,
      timeframe: SYNTH.timeframe,
      bars: { ...SYNTH },
    });
    expect(sim.totalBars()).toBe(SYNTH.bars);
    expect(sim.providers.feed.history(SYNTH.symbol, SYNTH.timeframe).length).toBe(0);

    let count = 0;
    while (sim.step()) {
      count++;
      const hist = sim.providers.feed.history(SYNTH.symbol, SYNTH.timeframe);
      expect(hist.length).toBe(count);
      expect(sim.barIndex()).toBe(count - 1);
      // Clock points at current bar's open time.
      expect(sim.providers.clock.now()).toBe(hist[hist.length - 1].time);
    }
    expect(count).toBe(SYNTH.bars);
    expect(sim.step()).toBe(false); // exhausted stays false
  });
});

// ── (c) broker matching engine ───────────────────────────────────────────────

/** Two explicit flat bars: lets us reason about exact fill prices + P/L. */
function flatBars(price: number, n: number, startTime = 1000, dt = 60): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      time: startTime + i * dt,
      open: price,
      high: price,
      low: price,
      close: price,
      tickVolume: 1,
      spread: 0,
      realVolume: 1,
    });
  }
  return out;
}

const SPEC: SymbolSpec = defaultSymbolSpec('EURUSD'); // contractSize 100000, point 1e-5

describe('broker: buy fill at ask then sell-to-close books correct P/L', () => {
  it('long round-trip realises (exit-entry)*vol*contractSize', async () => {
    // Bar 0 at 1.10000, bar 1 at 1.10100. Spread 10 points (= 0.00010).
    const bars: Bar[] = [
      { time: 1000, open: 1.1, high: 1.1, low: 1.1, close: 1.1, tickVolume: 1, spread: 0, realVolume: 1 },
      { time: 1060, open: 1.101, high: 1.101, low: 1.101, close: 1.101, tickVolume: 1, spread: 0, realVolume: 1 },
    ];
    const sim = createBacktest({
      symbol: 'EURUSD',
      timeframe: 1,
      bars,
      initialBalance: 10000,
      spreadPoints: 10, // ask = close + 10 * 1e-5 = close + 0.0001
      symbolSpec: SPEC,
    });
    const broker = sim.providers.broker;

    sim.step(); // reveal bar 0 (1.10000); ask = 1.10010, bid = 1.10000
    const buy = await broker.placeMarketOrder({ symbol: 'EURUSD', side: 'buy', volume: 0.1 });
    expect(buy.ok).toBe(true);
    expect(buy.retcode).toBe(10009);
    expect(buy.price).toBeCloseTo(1.1001, 10); // filled at ask
    const pos = broker.getPosition('EURUSD');
    expect(pos).not.toBeNull();
    expect(pos!.side).toBe('buy');
    expect(pos!.volume).toBeCloseTo(0.1, 10);
    expect(pos!.openPrice).toBeCloseTo(1.1001, 10);

    sim.step(); // reveal bar 1 (1.10100); bid = 1.10100
    // Close long at bid 1.10100. profit = (1.10100 - 1.10010) * 1 * 0.1 * 100000
    const close = await broker.closePosition('EURUSD');
    expect(close.ok).toBe(true);
    const expectedProfit = (1.101 - 1.1001) * 1 * 0.1 * 100000; // = 9.0
    expect(expectedProfit).toBeCloseTo(9.0, 6);
    expect(broker.account().balance).toBeCloseTo(10000 + expectedProfit, 6);
    expect(broker.getPosition('EURUSD')).toBeNull();

    // Report: one round-trip, a win, finalBalance == initial + netProfit.
    const rep = sim.report();
    expect(rep.totalTrades).toBe(1);
    expect(rep.wins).toBe(1);
    expect(rep.losses).toBe(0);
    expect(rep.finalBalance).toBeCloseTo(rep.initialBalance + rep.netProfit, 6);
    expect(rep.finalBalance).toBeCloseTo(10000 + expectedProfit, 6);
  });
});

describe('broker: netting flip', () => {
  it('opposite order larger than position closes old + opens new on remainder', async () => {
    const bars = flatBars(2.0, 3);
    const spec: SymbolSpec = { ...SPEC, point: 0.01 };
    const sim = createBacktest({
      symbol: 'XAUUSD',
      timeframe: 1,
      bars,
      initialBalance: 5000,
      spreadPoints: 0, // bid == ask == close == 2.0 for clean reasoning
      symbolSpec: spec,
    });
    const broker = sim.providers.broker;
    sim.step();

    // Open long 0.3 at 2.0.
    await broker.placeMarketOrder({ symbol: 'XAUUSD', side: 'buy', volume: 0.3 });
    let pos = broker.getPosition('XAUUSD')!;
    expect(pos.side).toBe('buy');
    expect(pos.volume).toBeCloseTo(0.3, 10);

    // Sell 0.5 at same price 2.0 → close 0.3 long (P/L 0 at same price),
    // then flip: open 0.2 short at 2.0.
    const flip = await broker.placeMarketOrder({ symbol: 'XAUUSD', side: 'sell', volume: 0.5 });
    expect(flip.ok).toBe(true);
    pos = broker.getPosition('XAUUSD')!;
    expect(pos).not.toBeNull();
    expect(pos.side).toBe('sell');
    expect(pos.volume).toBeCloseTo(0.2, 10);
    // Closing at the same price ⇒ realised P/L 0 ⇒ balance unchanged.
    expect(broker.account().balance).toBeCloseTo(5000, 6);

    // Two deals from the flip order: a close leg + an open leg, plus the
    // original open. (1 open + 1 close + 1 open = 3 deals.)
    const rep = sim.report();
    expect(rep.totalDeals).toBe(3);
    expect(rep.totalTrades).toBe(1); // one close (round-trip leg) so far
  });

  it('same-side add averages open price (VWAP)', async () => {
    const bars: Bar[] = [
      { time: 1000, open: 2.0, high: 2.0, low: 2.0, close: 2.0, tickVolume: 1, spread: 0, realVolume: 1 },
      { time: 1060, open: 3.0, high: 3.0, low: 3.0, close: 3.0, tickVolume: 1, spread: 0, realVolume: 1 },
    ];
    const spec: SymbolSpec = { ...SPEC, point: 0.01 };
    const sim = createBacktest({
      symbol: 'XAUUSD',
      timeframe: 1,
      bars,
      initialBalance: 5000,
      spreadPoints: 0,
      symbolSpec: spec,
    });
    const broker = sim.providers.broker;

    sim.step(); // price 2.0
    await broker.placeMarketOrder({ symbol: 'XAUUSD', side: 'buy', volume: 0.1 });
    sim.step(); // price 3.0
    await broker.placeMarketOrder({ symbol: 'XAUUSD', side: 'buy', volume: 0.1 });
    const pos = broker.getPosition('XAUUSD')!;
    expect(pos.volume).toBeCloseTo(0.2, 10);
    // VWAP = (2.0*0.1 + 3.0*0.1) / 0.2 = 2.5
    expect(pos.openPrice).toBeCloseTo(2.5, 10);
  });
});

describe('broker: partial close', () => {
  it('reduces volume and books partial P/L; 0 balance start is valid (rule 29)', async () => {
    const bars: Bar[] = [
      { time: 1000, open: 2.0, high: 2.0, low: 2.0, close: 2.0, tickVolume: 1, spread: 0, realVolume: 1 },
      { time: 1060, open: 2.5, high: 2.5, low: 2.5, close: 2.5, tickVolume: 1, spread: 0, realVolume: 1 },
    ];
    const spec: SymbolSpec = { ...SPEC, point: 0.01, contractSize: 100 };
    const sim = createBacktest({
      symbol: 'XAUUSD',
      timeframe: 1,
      bars,
      initialBalance: 0, // a 0 starting balance is a VALID account state
      spreadPoints: 0,
      symbolSpec: spec,
    });
    const broker = sim.providers.broker;
    expect(broker.account().balance).toBe(0);

    sim.step(); // 2.0
    await broker.placeMarketOrder({ symbol: 'XAUUSD', side: 'buy', volume: 0.2 });
    sim.step(); // 2.5
    // Close 0.1 of 0.2 long at 2.5: profit = (2.5-2.0)*1*0.1*100 = 5
    const part = await broker.closePosition('XAUUSD', 0.1);
    expect(part.ok).toBe(true);
    expect(broker.getPosition('XAUUSD')!.volume).toBeCloseTo(0.1, 10);
    expect(broker.account().balance).toBeCloseTo(5, 6);
  });
});

// ── (d) report consistency ───────────────────────────────────────────────────

describe('report stats add up over a full synthetic run', () => {
  it('finalBalance === initialBalance + netProfit; equity reflects floating P/L', () => {
    const sim = createBacktest({
      symbol: SYNTH.symbol,
      timeframe: SYNTH.timeframe,
      bars: { ...SYNTH },
      initialBalance: 10000,
      spreadPoints: 2,
    });
    const broker = sim.providers.broker;

    // Drive a simple SMA-cross strategy inline to actually generate trades.
    let prevDiff: number | null = null;
    const closes: number[] = [];
    while (sim.step()) {
      const hist = sim.providers.feed.history(SYNTH.symbol, SYNTH.timeframe);
      closes.push(hist[hist.length - 1].close);
      if (closes.length < 30) continue;
      const fast = avgLast(closes, 10);
      const slow = avgLast(closes, 30);
      const diff = fast - slow;
      if (prevDiff !== null) {
        if (prevDiff <= 0 && diff > 0) {
          // crossed up → go long (flip if short)
          // eslint-disable-next-line no-await-in-loop
          void broker.placeMarketOrder({ symbol: SYNTH.symbol, side: 'buy', volume: 0.1 });
        } else if (prevDiff >= 0 && diff < 0) {
          // eslint-disable-next-line no-await-in-loop
          void broker.placeMarketOrder({ symbol: SYNTH.symbol, side: 'sell', volume: 0.1 });
        }
      }
      prevDiff = diff;
    }

    const rep = sim.report();
    expect(rep.barsProcessed).toBe(SYNTH.bars);
    expect(rep.finalBalance).toBeCloseTo(rep.initialBalance + rep.netProfit, 6);
    expect(rep.totalDeals).toBe(rep.deals.length);
    expect(rep.wins + rep.losses).toBeLessThanOrEqual(rep.totalTrades);
    // Equity curve has one point per processed bar.
    expect(rep.equityCurve.length).toBe(SYNTH.bars);
    // winRate is wins/(wins+losses) when decisive, else 0.
    if (rep.wins + rep.losses > 0) {
      expect(rep.winRate).toBeCloseTo(rep.wins / (rep.wins + rep.losses), 10);
    } else {
      expect(rep.winRate).toBe(0);
    }
    // maxDrawdown is non-negative.
    expect(rep.maxDrawdown).toBeGreaterThanOrEqual(0);
    // The strategy actually traded (the generator guarantees crossovers).
    expect(rep.totalDeals).toBeGreaterThan(0);
  });
});

function avgLast(arr: number[], n: number): number {
  let sum = 0;
  for (let i = arr.length - n; i < arr.length; i++) sum += arr[i];
  return sum / n;
}
