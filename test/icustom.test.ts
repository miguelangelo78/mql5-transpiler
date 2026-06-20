/**
 * iCustom — custom-indicator pipeline tests.
 *
 * Proves the SOURCE-custom-indicator path end-to-end:
 *   compileCustomIndicator("SimpleMA")  — resolve+transpile+import the .mq5
 *   runCustomIndicator(...)             — run OnInit (SetIndexBuffer) + OnCalculate
 *   CustomIndicatorRegistry.iCustom / copyBuffer — handle + as-series CopyBuffer
 *
 * The oracle (§21): SimpleMA's buffer 0 MUST equal a direct SMA over the SAME
 * bars, within 1e-9. The reference SMA is computed INLINE here (longhand from
 * MovingAverages.mqh's SimpleMA), NOT by calling the implementation under test.
 *
 * Run: npx vitest run test/icustom.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  compileCustomIndicator,
  runCustomIndicator,
  EMPTY_VALUE,
} from '../src/icustom/compile';
import {
  CustomIndicatorRegistry,
  CUSTOM_HANDLE_BASE,
} from '../src/runtime/indicators/icustom';
import { ArraySeriesRegistry } from '../src/runtime/arrays';
import type { Bar, IMarketFeed, SymbolSpec, Tick } from '../src/runtime/providers/types';
import type { RuntimeContext } from '../src/engine/types';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const SPEC: SymbolSpec = {
  name: 'EURUSD',
  digits: 5,
  point: 0.00001,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  contractSize: 100000,
  tickSize: 0.00001,
  tickValue: 1,
};

const CTX: RuntimeContext = { symbol: 'EURUSD', timeframe: 1 };

/** A wiggly close series long enough to clear a period-10 warm-up. */
const CLOSES = [
  1.1000, 1.1012, 1.1025, 1.1018, 1.1031, 1.1047, 1.1039, 1.1052, 1.1066,
  1.1058, 1.1071, 1.1063, 1.1080, 1.1075, 1.1062, 1.1049, 1.1058, 1.1071,
  1.1085, 1.1078, 1.1090, 1.1083, 1.1097, 1.1110, 1.1102,
];

function bar(i: number, c: number): Bar {
  return {
    time: 1_700_000_000 + i * 60,
    open: c,
    high: c + 0.0005,
    low: c - 0.0005,
    close: c,
    tickVolume: 1,
    spread: 2,
    realVolume: 0,
  };
}

function barsFromCloses(closes: number[]): Bar[] {
  return closes.map((c, i) => bar(i, c));
}

/**
 * A feed whose visible window is controllable (mirrors BacktestFeed) so we can
 * test that a custom indicator recomputes as the backtest advances.
 */
class WindowedFeed implements IMarketFeed {
  private visible: number;
  constructor(private readonly dataset: readonly Bar[]) {
    this.visible = dataset.length;
  }
  setVisible(n: number): void {
    this.visible = Math.max(0, Math.min(this.dataset.length, n));
  }
  history(): readonly Bar[] {
    return this.dataset.slice(0, this.visible);
  }
  tick(): Tick {
    const b = this.dataset[this.visible - 1];
    return b
      ? { time: b.time, bid: b.close, ask: b.close, last: b.close, volume: b.tickVolume }
      : { time: 0, bid: 0, ask: 0, last: 0, volume: 0 };
  }
  symbolInfo(): SymbolSpec {
    return SPEC;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Independent reference (longhand SMA — MovingAverages.mqh SimpleMA)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Chronological SMA over `closes`, aligned 1:1: index i has a value iff
 * i >= period-1, else null (warm-up — what MT5 reports EMPTY_VALUE for).
 */
function refSMA(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let pos = period - 1; pos < closes.length; pos++) {
    let sum = 0;
    for (let k = 0; k < period; k++) sum += closes[pos - k]!;
    out[pos] = sum / period;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// compile + run
// ─────────────────────────────────────────────────────────────────────────

describe('compileCustomIndicator (resolve → transpile → import)', () => {
  it('compiles the SimpleMA sample and exposes its single input', () => {
    const c = compileCustomIndicator('SimpleMA');
    expect(c.name).toBe('SimpleMA');
    expect(c.sourcePath).toMatch(/examples\/indicators\/SimpleMA\.mq5$/);
    expect(typeof c.factory).toBe('function');
    expect(c.inputNames).toEqual(['InpMAPeriod']);
    // OnCalculate is the long (10-param) form.
    expect(c.module.events.OnCalculate).toBeDefined();
  });

  it('reports a missing indicator loudly (does NOT fake a handle) — §21', () => {
    expect(() => compileCustomIndicator('DefinitelyNotThere')).toThrow(/not found/i);
  });

  it('rejects a compiled .ex5 as out of scope — §21', () => {
    expect(() => compileCustomIndicator('Something.ex5')).toThrow(/\.ex5|out of scope/i);
  });
});

describe('runCustomIndicator (OnInit SetIndexBuffer + OnCalculate) — buffer 0 == SMA', () => {
  it('buffer 0 equals a direct SMA(period) within 1e-9, with EMPTY_VALUE warm-up', () => {
    const bars = barsFromCloses(CLOSES);
    const feed = new WindowedFeed(bars);
    const compiled = compileCustomIndicator('SimpleMA');

    for (const period of [5, 10, 14]) {
      const res = runCustomIndicator(compiled, { feed, ctx: CTX, params: [period], bars });
      expect(res.buffers.length).toBe(1);
      const buf = res.buffers[0]!;
      expect(buf.length).toBe(CLOSES.length);

      const ref = refSMA(CLOSES, period);
      for (let i = 0; i < CLOSES.length; i++) {
        if (ref[i] === null) {
          // Warm-up: the indicator writes EMPTY_VALUE (no MA value yet).
          expect(buf[i]).toBe(EMPTY_VALUE);
        } else {
          expect(buf[i]).toBeCloseTo(ref[i]!, 9);
        }
      }
    }
  });

  it('maps positional iCustom params onto inputs (period drives the result)', () => {
    const bars = barsFromCloses(CLOSES);
    const feed = new WindowedFeed(bars);
    const compiled = compileCustomIndicator('SimpleMA');

    const r5 = runCustomIndicator(compiled, { feed, ctx: CTX, params: [5], bars });
    const r10 = runCustomIndicator(compiled, { feed, ctx: CTX, params: [10], bars });
    // The newest SMA value differs between a 5- and 10-period average.
    const last5 = r5.buffers[0]!.at(-1)!;
    const last10 = r10.buffers[0]!.at(-1)!;
    expect(last5).not.toBe(last10);
    expect(last5).toBeCloseTo(refSMA(CLOSES, 5).at(-1)!, 9);
    expect(last10).toBeCloseTo(refSMA(CLOSES, 10).at(-1)!, 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CustomIndicatorRegistry — iCustom() handle + CopyBuffer projection
// ─────────────────────────────────────────────────────────────────────────

function makeRegistry(feed: IMarketFeed): {
  reg: CustomIndicatorRegistry;
  series: ArraySeriesRegistry;
} {
  const series = new ArraySeriesRegistry();
  let next = 0;
  const reg = new CustomIndicatorRegistry(feed, series, CTX, () => next++);
  return { reg, series };
}

describe('CustomIndicatorRegistry — iCustom handle + CopyBuffer', () => {
  it('iCustom returns a non-negative handle the registry owns', () => {
    const feed = new WindowedFeed(barsFromCloses(CLOSES));
    const { reg } = makeRegistry(feed);
    const h = reg.iCustom('EURUSD', 1, 'SimpleMA', 10);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(reg.owns(h)).toBe(true);
    expect(reg.has(h)).toBe(true);
  });

  it('iCustom returns INVALID_HANDLE (-1) for a missing indicator, with lastError', () => {
    const feed = new WindowedFeed(barsFromCloses(CLOSES));
    const { reg } = makeRegistry(feed);
    const h = reg.iCustom('EURUSD', 1, 'NoSuchIndicator', 10);
    expect(h).toBe(-1);
    expect(reg.owns(h)).toBe(false);
    expect(reg.lastError()).toMatch(/not found/i);
  });

  it('CopyBuffer (as-series dest) returns newest-first SMA values == direct SMA', () => {
    const feed = new WindowedFeed(barsFromCloses(CLOSES));
    const { reg, series } = makeRegistry(feed);
    const period = 10;
    const h = reg.iCustom('EURUSD', 1, 'SimpleMA', period);

    const dest: number[] = [];
    series.setAsSeries(dest, true);
    const copied = reg.copyBuffer(h, 0, 0, 3, dest);
    expect(copied).toBe(3);

    // newest-first: dest[0] = SMA at the newest bar, dest[1] = one bar back, …
    const ref = refSMA(CLOSES, period);
    const refNewestFirst = ref.filter((v) => v !== null) as number[];
    refNewestFirst.reverse(); // newest last → newest first
    for (let i = 0; i < 3; i++) {
      expect(dest[i]).toBeCloseTo(refNewestFirst[i]!, 9);
    }
  });

  it('CopyBuffer (non-series dest) returns oldest-first within the window', () => {
    const feed = new WindowedFeed(barsFromCloses(CLOSES));
    const { reg } = makeRegistry(feed);
    const period = 10;
    const h = reg.iCustom('EURUSD', 1, 'SimpleMA', period);

    const dest: number[] = []; // non-series by default
    const copied = reg.copyBuffer(h, 0, 0, 4, dest);
    expect(copied).toBe(4);

    // Non-series: dest[last] = newest. So reversed dest == newest-first.
    const ref = refSMA(CLOSES, period);
    const refNewestFirst = (ref.filter((v) => v !== null) as number[]).reverse();
    const destNewestFirst = [...dest].reverse();
    for (let i = 0; i < 4; i++) {
      expect(destNewestFirst[i]).toBeCloseTo(refNewestFirst[i]!, 9);
    }
  });

  it('CopyBuffer returns FEWER than requested when the window reaches warm-up', () => {
    const feed = new WindowedFeed(barsFromCloses(CLOSES));
    const { reg, series } = makeRegistry(feed);
    const period = 10;
    const h = reg.iCustom('EURUSD', 1, 'SimpleMA', period);

    const dest: number[] = [];
    series.setAsSeries(dest, true);
    // Ask for far more than exist with a value: 25 bars, period-10 ⇒ 9 warm-up,
    // so only 25 - 9 = 16 positions carry a value.
    const copied = reg.copyBuffer(h, 0, 0, 100, dest);
    expect(copied).toBe(CLOSES.length - (period - 1));
    expect(dest.length).toBe(copied);
  });

  it('recomputes as the feed advances (a stale-cache bug would be caught)', () => {
    const bars = barsFromCloses(CLOSES);
    const feed = new WindowedFeed(bars);
    const { reg, series } = makeRegistry(feed);
    const period = 5;
    const h = reg.iCustom('EURUSD', 1, 'SimpleMA', period);

    // Reveal only the first 12 bars; newest SMA(5) = mean of closes[7..11].
    feed.setVisible(12);
    const d1: number[] = [];
    series.setAsSeries(d1, true);
    reg.copyBuffer(h, 0, 0, 1, d1);
    expect(d1[0]).toBeCloseTo(refSMA(CLOSES.slice(0, 12), period).at(-1)!, 9);

    // Advance to all 25 bars; newest SMA(5) changes accordingly.
    feed.setVisible(CLOSES.length);
    const d2: number[] = [];
    series.setAsSeries(d2, true);
    reg.copyBuffer(h, 0, 0, 1, d2);
    expect(d2[0]).toBeCloseTo(refSMA(CLOSES, period).at(-1)!, 9);
    expect(d2[0]).not.toBe(d1[0]);
  });

  it('release() frees the handle (mirrors IndicatorRelease)', () => {
    const feed = new WindowedFeed(barsFromCloses(CLOSES));
    const { reg } = makeRegistry(feed);
    const h = reg.iCustom('EURUSD', 1, 'SimpleMA', 10);
    expect(reg.release(h)).toBe(true);
    expect(reg.owns(h)).toBe(false);
    expect(reg.release(h)).toBe(false); // already gone
  });

  it('the integrator-style disjoint-base allocator yields non-colliding handles', () => {
    // Mirrors how the integrator wires allocHandle: a private monotonic counter
    // offset by CUSTOM_HANDLE_BASE, so custom handles never collide with the
    // native registry's 0-based handles. owns() answers only for these.
    const feed = new WindowedFeed(barsFromCloses(CLOSES));
    const series = new ArraySeriesRegistry();
    let n = 0;
    const reg = new CustomIndicatorRegistry(
      feed,
      series,
      CTX,
      () => CUSTOM_HANDLE_BASE + n++,
    );
    const h0 = reg.iCustom('EURUSD', 1, 'SimpleMA', 10);
    const h1 = reg.iCustom('EURUSD', 1, 'SimpleMA', 5);
    expect(h0).toBe(CUSTOM_HANDLE_BASE);
    expect(h1).toBe(CUSTOM_HANDLE_BASE + 1);
    expect(reg.owns(h0)).toBe(true);
    expect(reg.owns(h1)).toBe(true);
    // A native-range handle (e.g. 0) is NOT owned by the custom registry, so the
    // integrator's owns()-based CopyBuffer routing is unambiguous.
    expect(reg.owns(0)).toBe(false);
  });

  it('a buffer value of 0 is a REAL value, never dropped as warm-up (§29)', () => {
    // A flat zero series → SMA is 0 everywhere past warm-up. CopyBuffer must
    // return those 0s (a 0 is data), not treat them as no-value.
    const zeros = new Array(15).fill(0);
    const feed = new WindowedFeed(barsFromCloses(zeros));
    const { reg, series } = makeRegistry(feed);
    const period = 5;
    const h = reg.iCustom('EURUSD', 1, 'SimpleMA', period);

    const dest: number[] = [];
    series.setAsSeries(dest, true);
    const copied = reg.copyBuffer(h, 0, 0, 100, dest);
    expect(copied).toBe(zeros.length - (period - 1));
    for (const v of dest) expect(v).toBe(0);
  });
});
