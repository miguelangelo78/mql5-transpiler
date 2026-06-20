/**
 * Indicator-batch fidelity tests — MT5-EXACT (global CLAUDE.md §21).
 *
 * Covers iBands / iMACD / iStochastic / iADX / iCCI / iMomentum and the
 * timeseries accessors iBars / iHighest / iLowest / iVolume.
 *
 * Each indicator is checked against an INDEPENDENT reference computed inline
 * from MetaQuotes' own source recurrences (BB.mq5 / MACD.mq5 / Stochastic.mq5 /
 * ADX.mq5 / CCI.mq5 / Momentum.mq5 + MovingAverages.mqh), NOT by calling the
 * implementation under test. The reference loops are written longhand so a
 * divergence in the impl is caught. Multi-buffer relationships and warm-up
 * boundaries are asserted explicitly.
 *
 * Run: npx vitest run test/indicators-batch.test.ts
 */

import { describe, it, expect } from 'vitest';
import type { Bar } from '../src/runtime/providers/types';
import { computeBands } from '../src/runtime/indicators/bands';
import { computeMACD } from '../src/runtime/indicators/macd';
import {
  computeStochastic,
  STO_PRICE,
} from '../src/runtime/indicators/stochastic';
import { computeADX } from '../src/runtime/indicators/adx';
import { computeCCI } from '../src/runtime/indicators/cci';
import { computeMomentum } from '../src/runtime/indicators/momentum';
import {
  iBars,
  iVolume,
  iHighest,
  iLowest,
  SERIES_MODE,
} from '../src/runtime/indicators/series';

const PRICE_CLOSE = 1;
const PRICE_TYPICAL = 6;

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

function ohlc(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  vol = 100 + i,
): Bar {
  return {
    time: 1_700_000_000 + i * 60,
    open: o,
    high: h,
    low: l,
    close: c,
    tickVolume: vol,
    spread: 0,
    realVolume: vol * 10,
  };
}

/** Close-only bars (open=high-0.5=low+0.5=close), applied=CLOSE == the close. */
function closeBars(closes: number[]): Bar[] {
  return closes.map((c, i) => ohlc(i, c, c + 0.5, c - 0.5, c));
}

// A wiggly close series for the price-driven indicators.
const CLOSES = [
  44.0, 44.25, 44.5, 43.75, 44.5, 45.0, 47.0, 46.75, 46.5, 46.25, 47.75, 47.5,
  47.0, 47.25, 46.75, 46.5, 46.25, 47.75, 47.5, 47.0, 46.5, 46.75, 47.0, 47.5,
];

// A full-OHLC series with varied ranges, for Bands/Stochastic/ADX.
const OHLC_BARS: Bar[] = [
  ohlc(0, 10.0, 10.6, 9.7, 10.2),
  ohlc(1, 10.2, 10.9, 10.1, 10.7),
  ohlc(2, 10.7, 11.2, 10.5, 10.6),
  ohlc(3, 10.6, 10.8, 10.0, 10.1),
  ohlc(4, 10.1, 10.4, 9.6, 9.8),
  ohlc(5, 9.8, 10.2, 9.5, 10.1),
  ohlc(6, 10.1, 10.7, 10.0, 10.6),
  ohlc(7, 10.6, 11.1, 10.4, 11.0),
  ohlc(8, 11.0, 11.5, 10.8, 10.9),
  ohlc(9, 10.9, 11.0, 10.3, 10.4),
  ohlc(10, 10.4, 10.6, 9.9, 10.0),
  ohlc(11, 10.0, 10.3, 9.4, 9.7),
  ohlc(12, 9.7, 10.1, 9.5, 10.0),
  ohlc(13, 10.0, 10.8, 9.9, 10.7),
  ohlc(14, 10.7, 11.3, 10.6, 11.2),
  ohlc(15, 11.2, 11.6, 11.0, 11.1),
  ohlc(16, 11.1, 11.4, 10.7, 10.8),
  ohlc(17, 10.8, 11.0, 10.2, 10.5),
  ohlc(18, 10.5, 10.7, 10.0, 10.6),
  ohlc(19, 10.6, 11.2, 10.5, 11.1),
];

function expectSeriesMatch(
  got: (number | null)[],
  ref: (number | null)[],
  tol = 1e-9,
): void {
  expect(got.length).toBe(ref.length);
  for (let i = 0; i < ref.length; i++) {
    const g = got[i];
    const r = ref[i];
    if (r === null) {
      expect(g, `index ${i} should be warm-up (null)`).toBeNull();
    } else {
      expect(g, `index ${i} should have a value`).not.toBeNull();
      expect(
        Math.abs((g as number) - r),
        `index ${i}: got ${g}, want ${r}`,
      ).toBeLessThan(tol);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Independent reference implementations (longhand from MT5 source)
// ─────────────────────────────────────────────────────────────────────────

function typical(bar: Bar): number {
  return (bar.high + bar.low + bar.close) / 3.0;
}

/** BB.mq5 longhand. Middle null before period-1; StdDev only when i>=period. */
function refBands(
  bars: Bar[],
  period: number,
  dev: number,
): { base: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const n = bars.length;
  const base: (number | null)[] = new Array(n).fill(null);
  const upper: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  const price = bars.map((b) => b.close);
  for (let i = period - 1; i < n; i++) {
    let s = 0;
    for (let j = 0; j < period; j++) s += price[i - j]!;
    const ml = s / period;
    base[i] = ml;
    let sd = 0;
    if (i >= period) {
      let acc = 0;
      for (let j = 0; j < period; j++) {
        const d = price[i - j]! - ml;
        acc += d * d;
      }
      sd = Math.sqrt(acc / period);
    }
    upper[i] = ml + dev * sd;
    lower[i] = ml - dev * sd;
  }
  return { base, upper, lower };
}

/** MACD.mq5 longhand: MAIN=EMA(fast)-EMA(slow); SIGNAL=SimpleMAOnBuffer(MAIN). */
function refMACD(
  closes: number[],
  fast: number,
  slow: number,
  sig: number,
): { main: (number | null)[]; signal: (number | null)[] } {
  const n = closes.length;
  const ema = (p: number): number[] => {
    const k = 2 / (1 + p);
    const o = new Array<number>(n);
    o[0] = closes[0]!;
    for (let i = 1; i < n; i++) o[i] = closes[i]! * k + o[i - 1]! * (1 - k);
    return o;
  };
  const f = ema(fast);
  const sl = ema(slow);
  const macd = new Array<number>(n);
  const main: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    macd[i] = f[i]! - sl[i]!;
    main[i] = macd[i]!;
  }
  const signal: (number | null)[] = new Array(n).fill(null);
  if (sig > 1 && sig <= n) {
    let first = 0;
    for (let i = 0; i < sig; i++) first += macd[i]!;
    signal[sig - 1] = first / sig;
    for (let i = sig; i < n; i++)
      signal[i] = (signal[i - 1] as number) + (macd[i]! - macd[i - sig]!) / sig;
  }
  return { main, signal };
}

/** Stochastic.mq5 longhand (STO_LOWHIGH). */
function refStoch(
  bars: Bar[],
  kP: number,
  dP: number,
  slow: number,
): { main: (number | null)[]; signal: (number | null)[] } {
  const n = bars.length;
  const main: (number | null)[] = new Array(n).fill(null);
  const signal: (number | null)[] = new Array(n).fill(null);
  if (n <= kP + dP + slow) return { main, signal };
  const lowes: (number | null)[] = new Array(n).fill(null);
  const highes: (number | null)[] = new Array(n).fill(null);
  for (let i = kP - 1; i < n; i++) {
    let dmin = Infinity;
    let dmax = -Infinity;
    for (let k = i - kP + 1; k <= i; k++) {
      if (bars[k]!.low < dmin) dmin = bars[k]!.low;
      if (bars[k]!.high > dmax) dmax = bars[k]!.high;
    }
    lowes[i] = dmin;
    highes[i] = dmax;
  }
  const firstK = kP - 1 + (slow - 1);
  for (let i = firstK; i < n; i++) {
    let sl = 0;
    let sh = 0;
    for (let k = i - slow + 1; k <= i; k++) {
      sl += bars[k]!.close - (lowes[k] as number);
      sh += (highes[k] as number) - (lowes[k] as number);
    }
    main[i] = sh === 0 ? 100 : (sl / sh) * 100;
  }
  // %D: MT5's Stochastic.mq5 writes it from index dP-1, reading the %K buffer
  // where warm-up cells hold 0.0 (it does NOT skip them) — so %D is 0.0 until
  // %K becomes real, then warm-up-contaminated, then clean. Reproduce exactly.
  const firstSig = dP - 1;
  for (let i = firstSig; i < n; i++) {
    let s = 0;
    for (let k = 0; k < dP; k++) {
      const v = main[i - k];
      s += v === null ? 0 : v;
    }
    signal[i] = s / dP;
  }
  return { main, signal };
}

/** ADX.mq5 longhand (EMA-smoothed DI/ADX from a 0 seed at index 0). */
function refADX(
  bars: Bar[],
  period: number,
): { main: (number | null)[]; pdi: (number | null)[]; ndi: (number | null)[] } {
  const n = bars.length;
  const main: (number | null)[] = new Array(n).fill(null);
  const pdi: (number | null)[] = new Array(n).fill(null);
  const ndi: (number | null)[] = new Array(n).fill(null);
  if (n < period) return { main, pdi, ndi };
  const k = 2 / (period + 1);
  let pPrev = 0;
  let nPrev = 0;
  let aPrev = 0;
  main[0] = 0;
  pdi[0] = 0;
  ndi[0] = 0;
  for (let i = 1; i < n; i++) {
    const hp = bars[i]!.high;
    const ph = bars[i - 1]!.high;
    const lp = bars[i]!.low;
    const pl = bars[i - 1]!.low;
    const pc = bars[i - 1]!.close;
    let tp = hp - ph;
    let tn = pl - lp;
    if (tp < 0) tp = 0;
    if (tn < 0) tn = 0;
    if (tp > tn) tn = 0;
    else if (tp < tn) tp = 0;
    else {
      tp = 0;
      tn = 0;
    }
    const tr = Math.max(
      Math.max(Math.abs(hp - lp), Math.abs(hp - pc)),
      Math.abs(lp - pc),
    );
    let pd = 0;
    let nd = 0;
    if (tr !== 0) {
      pd = (100 * tp) / tr;
      nd = (100 * tn) / tr;
    }
    const p = pd * k + pPrev * (1 - k);
    const nn = nd * k + nPrev * (1 - k);
    pPrev = p;
    nPrev = nn;
    let dx = 0;
    if (p + nn !== 0) dx = 100 * Math.abs((p - nn) / (p + nn));
    const a = dx * k + aPrev * (1 - k);
    aPrev = a;
    pdi[i] = p;
    ndi[i] = nn;
    main[i] = a;
  }
  return { main, pdi, ndi };
}

/** CCI.mq5 longhand (typical price). */
function refCCI(bars: Bar[], period: number): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period) return out;
  const price = bars.map(typical);
  const mult = 0.015 / period;
  for (let i = period - 1; i < n; i++) {
    let s = 0;
    for (let j = 0; j < period; j++) s += price[i - j]!;
    const sp = s / period;
    let td = 0;
    for (let j = 0; j < period; j++) td += Math.abs(price[i - j]! - sp);
    const d = td * mult;
    const m = price[i]! - sp;
    out[i] = d !== 0 ? m / d : 0;
  }
  return out;
}

/** Momentum.mq5 longhand (first written index = period). */
function refMomentum(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = period; i < n; i++) out[i] = (closes[i]! * 100) / closes[i - period]!;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// iBands
// ─────────────────────────────────────────────────────────────────────────

describe('iBands — Bollinger Bands, MT5-exact (BB.mq5)', () => {
  it('all three buffers match the independent reference (period 5, dev 2)', () => {
    const b = computeBands(OHLC_BARS, 5, 2.0, PRICE_CLOSE);
    const r = refBands(OHLC_BARS, 5, 2.0);
    expectSeriesMatch(b.base, r.base);
    expectSeriesMatch(b.upper, r.upper);
    expectSeriesMatch(b.lower, r.lower);
  });

  it('middle null before period-1; first middle at period-1 = SMA', () => {
    const period = 5;
    const b = computeBands(OHLC_BARS, period, 2.0, PRICE_CLOSE);
    for (let i = 0; i < period - 1; i++) expect(b.base[i], `index ${i}`).toBeNull();
    let s = 0;
    for (let j = 0; j < period; j++) s += OHLC_BARS[j]!.close;
    expect(Math.abs((b.base[period - 1] as number) - s / period)).toBeLessThan(1e-12);
  });

  it('LOAD-BEARING: at i=period-1 StdDev is 0 → UPPER == BASE == LOWER (collapsed)', () => {
    const period = 5;
    const b = computeBands(OHLC_BARS, period, 2.0, PRICE_CLOSE);
    const mid = b.base[period - 1] as number;
    expect(b.upper[period - 1]).toBe(mid);
    expect(b.lower[period - 1]).toBe(mid);
  });

  it('from i=period the bands open: UPPER > BASE > LOWER', () => {
    const period = 5;
    const b = computeBands(OHLC_BARS, period, 2.0, PRICE_CLOSE);
    for (let i = period; i < OHLC_BARS.length; i++) {
      const u = b.upper[i] as number;
      const m = b.base[i] as number;
      const l = b.lower[i] as number;
      expect(u, `upper>base at ${i}`).toBeGreaterThan(m);
      expect(m, `base>lower at ${i}`).toBeGreaterThan(l);
      // upper/lower symmetric about middle.
      expect(Math.abs(u - m - (m - l))).toBeLessThan(1e-9);
    }
  });

  it('ma_shift shifts all buffers forward by N bars', () => {
    const period = 5;
    const base0 = computeBands(OHLC_BARS, period, 2.0, PRICE_CLOSE);
    const shifted = computeBands(OHLC_BARS, period, 2.0, PRICE_CLOSE, 2);
    for (let i = 2; i < OHLC_BARS.length; i++) {
      const a = base0.base[i - 2];
      const b = shifted.base[i];
      if (a === null) expect(b).toBeNull();
      else expect(Math.abs((b as number) - a)).toBeLessThan(1e-12);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// iMACD
// ─────────────────────────────────────────────────────────────────────────

describe('iMACD — MACD, MT5-exact (MACD.mq5)', () => {
  it('MAIN + SIGNAL match the independent reference (12/26/9)', () => {
    const m = computeMACD(closeBars(CLOSES), 12, 26, 9, PRICE_CLOSE);
    const r = refMACD(CLOSES, 12, 26, 9);
    expectSeriesMatch(m.main, r.main);
    expectSeriesMatch(m.signal, r.signal);
  });

  it('MAIN has a value at EVERY bar (EMA seeds from index 0)', () => {
    const m = computeMACD(closeBars(CLOSES), 3, 5, 3, PRICE_CLOSE);
    for (let i = 0; i < CLOSES.length; i++) expect(m.main[i], `index ${i}`).not.toBeNull();
  });

  it('MAIN[i] = EMA(fast)[i] - EMA(slow)[i] (hand-checked at index 0)', () => {
    // EMA[0]=price[0] for both → MAIN[0] = 0.
    const m = computeMACD(closeBars(CLOSES), 12, 26, 9, PRICE_CLOSE);
    expect(Math.abs(m.main[0] as number)).toBeLessThan(1e-12);
  });

  it('SIGNAL is a SIMPLE MA of MAIN (NOT an EMA) — first valid at signalSMA-1', () => {
    const sig = 9;
    const m = computeMACD(closeBars(CLOSES), 12, 26, sig, PRICE_CLOSE);
    for (let i = 0; i < sig - 1; i++) expect(m.signal[i], `index ${i}`).toBeNull();
    expect(m.signal[sig - 1]).not.toBeNull();
    // first SIGNAL = plain mean of MAIN[0..sig-1].
    let s = 0;
    for (let i = 0; i < sig; i++) s += m.main[i] as number;
    expect(Math.abs((m.signal[sig - 1] as number) - s / sig)).toBeLessThan(1e-9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// iStochastic
// ─────────────────────────────────────────────────────────────────────────

describe('iStochastic — Stochastic Oscillator, MT5-exact (Stochastic.mq5)', () => {
  it('MAIN(%K) + SIGNAL(%D) match the independent reference (5,3,3, LOWHIGH)', () => {
    const s = computeStochastic(OHLC_BARS, 5, 3, 3, STO_PRICE.STO_LOWHIGH);
    const r = refStoch(OHLC_BARS, 5, 3, 3);
    expectSeriesMatch(s.main, r.main);
    expectSeriesMatch(s.signal, r.signal);
  });

  it('every %K and %D value is within [0, 100]', () => {
    const s = computeStochastic(OHLC_BARS, 5, 3, 3, STO_PRICE.STO_LOWHIGH);
    for (let i = 0; i < OHLC_BARS.length; i++) {
      const k = s.main[i];
      const d = s.signal[i];
      if (k !== null) {
        expect(k, `%K ${i} >=0`).toBeGreaterThanOrEqual(0);
        expect(k, `%K ${i} <=100`).toBeLessThanOrEqual(100);
      }
      if (d !== null) {
        expect(d, `%D ${i} >=0`).toBeGreaterThanOrEqual(0);
        expect(d, `%D ${i} <=100`).toBeLessThanOrEqual(100);
      }
    }
  });

  it('warm-up: first %K at (K-1)+(slow-1); %D from Dperiod-1 (MT5 0.0-warm-up)', () => {
    const kP = 5;
    const dP = 3;
    const slow = 3;
    const s = computeStochastic(OHLC_BARS, kP, dP, slow, STO_PRICE.STO_LOWHIGH);
    const firstK = kP - 1 + (slow - 1);
    for (let i = 0; i < firstK; i++) expect(s.main[i], `%K ${i}`).toBeNull();
    expect(s.main[firstK]).not.toBeNull();
    // MT5's Stochastic.mq5 writes %D from index Dperiod-1, reading the %K buffer
    // where warm-up cells are 0.0 — so %D is non-null from Dperiod-1 (NOT only
    // from firstK+(Dperiod-1)). CopyBuffer returns those warm-up cells.
    const firstD = dP - 1;
    for (let i = 0; i < firstD; i++) expect(s.signal[i], `%D ${i}`).toBeNull();
    expect(s.signal[firstD]).not.toBeNull();
  });

  it('STO_CLOSECLOSE uses CLOSE for the extremes (differs from LOWHIGH)', () => {
    const lh = computeStochastic(OHLC_BARS, 5, 3, 3, STO_PRICE.STO_LOWHIGH);
    const cc = computeStochastic(OHLC_BARS, 5, 3, 3, STO_PRICE.STO_CLOSECLOSE);
    // At least one defined %K differs between the two price-field modes.
    let differ = false;
    for (let i = 0; i < OHLC_BARS.length; i++) {
      if (lh.main[i] !== null && cc.main[i] !== null) {
        if (Math.abs((lh.main[i] as number) - (cc.main[i] as number)) > 1e-9)
          differ = true;
      }
    }
    expect(differ).toBe(true);
    // CLOSECLOSE still bounded [0,100].
    for (let i = 0; i < OHLC_BARS.length; i++) {
      const k = cc.main[i];
      if (k !== null) {
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThanOrEqual(100);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// iADX
// ─────────────────────────────────────────────────────────────────────────

describe('iADX — Average Directional Index, MT5-exact (ADX.mq5)', () => {
  it('MAIN(ADX) + +DI + -DI match the independent reference (period 5)', () => {
    const a = computeADX(OHLC_BARS, 5);
    const r = refADX(OHLC_BARS, 5);
    expectSeriesMatch(a.main, r.main);
    expectSeriesMatch(a.plusDI, r.pdi);
    expectSeriesMatch(a.minusDI, r.ndi);
  });

  it('index 0 holds explicit 0.0 for all three buffers; value at every bar', () => {
    const a = computeADX(OHLC_BARS, 5);
    expect(a.main[0]).toBe(0);
    expect(a.plusDI[0]).toBe(0);
    expect(a.minusDI[0]).toBe(0);
    for (let i = 0; i < OHLC_BARS.length; i++) {
      expect(a.main[i], `ADX ${i}`).not.toBeNull();
      expect(a.plusDI[i], `+DI ${i}`).not.toBeNull();
      expect(a.minusDI[i], `-DI ${i}`).not.toBeNull();
    }
  });

  it('+DI and -DI are non-negative and ADX in [0,100]', () => {
    const a = computeADX(OHLC_BARS, 5);
    for (let i = 0; i < OHLC_BARS.length; i++) {
      expect(a.plusDI[i] as number, `+DI ${i}>=0`).toBeGreaterThanOrEqual(0);
      expect(a.minusDI[i] as number, `-DI ${i}>=0`).toBeGreaterThanOrEqual(0);
      const adx = a.main[i] as number;
      expect(adx, `ADX ${i}>=0`).toBeGreaterThanOrEqual(-1e-9);
      expect(adx, `ADX ${i}<=100`).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it('a strong uptrend yields +DI > -DI on the trending leg', () => {
    // monotone-up OHLC: each bar higher highs/lows → +DM dominates.
    const up: Bar[] = [];
    for (let i = 0; i < 16; i++)
      up.push(ohlc(i, 10 + i, 10.5 + i, 9.8 + i, 10.4 + i));
    const a = computeADX(up, 5);
    const last = up.length - 1;
    expect(a.plusDI[last] as number).toBeGreaterThan(a.minusDI[last] as number);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// iCCI
// ─────────────────────────────────────────────────────────────────────────

describe('iCCI — Commodity Channel Index, MT5-exact (CCI.mq5)', () => {
  it('matches the independent reference (period 14, typical price)', () => {
    expectSeriesMatch(computeCCI(OHLC_BARS, 14, PRICE_TYPICAL), refCCI(OHLC_BARS, 14));
  });

  it('first valid value at index period-1; earlier null', () => {
    const period = 5;
    const out = computeCCI(OHLC_BARS, period, PRICE_TYPICAL);
    for (let i = 0; i < period - 1; i++) expect(out[i], `index ${i}`).toBeNull();
    expect(out[period - 1]).not.toBeNull();
  });

  it('flat window → mean deviation 0 → CCI = 0 (not NaN)', () => {
    // constant typical price over the window → D==0 → CCI 0.
    const flat: Bar[] = [];
    for (let i = 0; i < 8; i++) flat.push(ohlc(i, 10, 10.3, 9.7, 10)); // typical=10
    const out = computeCCI(flat, 5, PRICE_TYPICAL);
    expect(out[4]).toBe(0);
    expect(out[7]).toBe(0);
  });

  it('CCI = (typical - SMA) / (0.015 * meanAbsDev) (hand-checked at first index)', () => {
    const period = 5;
    const out = computeCCI(OHLC_BARS, period, PRICE_TYPICAL);
    const price = OHLC_BARS.map(typical);
    let s = 0;
    for (let j = 0; j < period; j++) s += price[j]!;
    const sp = s / period;
    let td = 0;
    for (let j = 0; j < period; j++) td += Math.abs(price[j]! - sp);
    const d = (td * 0.015) / period;
    const want = (price[period - 1]! - sp) / d;
    expect(Math.abs((out[period - 1] as number) - want)).toBeLessThan(1e-9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// iMomentum
// ─────────────────────────────────────────────────────────────────────────

describe('iMomentum — Momentum, MT5-exact (Momentum.mq5)', () => {
  it('matches the independent reference (period 14)', () => {
    expectSeriesMatch(computeMomentum(closeBars(CLOSES), 14, PRICE_CLOSE), refMomentum(CLOSES, 14));
  });

  it('LOAD-BEARING: first written index is `period`, NOT period-1', () => {
    const period = 5;
    const out = computeMomentum(closeBars(CLOSES), period, PRICE_CLOSE);
    for (let i = 0; i < period; i++) expect(out[i], `index ${i}`).toBeNull();
    expect(out[period]).not.toBeNull();
  });

  it('value = price[i]*100/price[i-period] (hand-checked)', () => {
    const period = 5;
    const out = computeMomentum(closeBars(CLOSES), period, PRICE_CLOSE);
    const want = (CLOSES[period]! * 100) / CLOSES[0]!;
    expect(Math.abs((out[period] as number) - want)).toBeLessThan(1e-9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// iBars / iVolume / iHighest / iLowest
// ─────────────────────────────────────────────────────────────────────────

describe('iBars / iVolume — timeseries accessors, MT5-exact', () => {
  it('iBars returns the bar count', () => {
    expect(iBars(OHLC_BARS)).toBe(OHLC_BARS.length);
    expect(iBars([])).toBe(0);
  });

  it('iVolume reads tick volume at as-series shift; 0 out of range', () => {
    const n = OHLC_BARS.length;
    // shift 0 = newest (chronological last).
    expect(iVolume(OHLC_BARS, 0)).toBe(OHLC_BARS[n - 1]!.tickVolume);
    expect(iVolume(OHLC_BARS, 1)).toBe(OHLC_BARS[n - 2]!.tickVolume);
    expect(iVolume(OHLC_BARS, n - 1)).toBe(OHLC_BARS[0]!.tickVolume);
    expect(iVolume(OHLC_BARS, n)).toBe(0); // out of range
    expect(iVolume(OHLC_BARS, -1)).toBe(0);
  });
});

describe('iHighest / iLowest — extreme index over a window, MT5-exact', () => {
  it('iHighest(MODE_HIGH, whole array) returns as-series index of the max high', () => {
    // max high in OHLC_BARS is 11.6 at chrono index 15 → as-series 20-1-15 = 4.
    const idx = iHighest(OHLC_BARS, SERIES_MODE.MODE_HIGH, 0, 0);
    const n = OHLC_BARS.length;
    expect(idx).toBe(n - 1 - 15);
    // cross-check: chrono index it points to has the max high.
    let maxChrono = 0;
    for (let i = 1; i < n; i++) if (OHLC_BARS[i]!.high > OHLC_BARS[maxChrono]!.high) maxChrono = i;
    expect(n - 1 - idx).toBe(maxChrono);
  });

  it('iLowest(MODE_LOW, whole array) returns as-series index of the min low', () => {
    const n = OHLC_BARS.length;
    const idx = iLowest(OHLC_BARS, SERIES_MODE.MODE_LOW, 0, 0);
    let minChrono = 0;
    for (let i = 1; i < n; i++) if (OHLC_BARS[i]!.low < OHLC_BARS[minChrono]!.low) minChrono = i;
    expect(n - 1 - idx).toBe(minChrono);
  });

  it('window [start, count] restricts the search (MODE_CLOSE)', () => {
    // search the most-recent 3 bars only (as-series positions 0..2).
    const n = OHLC_BARS.length;
    const idx = iHighest(OHLC_BARS, SERIES_MODE.MODE_CLOSE, 3, 0);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThanOrEqual(2);
    // verify it's the max close among the last 3 chrono bars.
    let best = n - 3;
    for (let c = n - 3; c < n; c++) if (OHLC_BARS[c]!.close > OHLC_BARS[best]!.close) best = c;
    expect(n - 1 - idx).toBe(best);
  });

  it('start offset shifts the window back in time', () => {
    const n = OHLC_BARS.length;
    // window of 4 bars starting 2 back: as-series 2..5.
    const idx = iLowest(OHLC_BARS, SERIES_MODE.MODE_LOW, 4, 2);
    expect(idx).toBeGreaterThanOrEqual(2);
    expect(idx).toBeLessThanOrEqual(5);
  });

  it('on ties returns the FIRST (smallest as-series index)', () => {
    // two bars share the max high; the newer (smaller as-series index) wins.
    const tie: Bar[] = [
      ohlc(0, 10, 12, 9, 11), // high 12
      ohlc(1, 11, 11, 10, 10.5), // high 11
      ohlc(2, 10.5, 12, 10, 11), // high 12 (tie) — chrono 2, as-series 0
    ];
    // as-series 0 (chrono 2) and as-series 2 (chrono 0) both have high 12.
    expect(iHighest(tie, SERIES_MODE.MODE_HIGH, 0, 0)).toBe(0);
  });

  it('empty / bad args return -1', () => {
    expect(iHighest([], SERIES_MODE.MODE_HIGH, 0, 0)).toBe(-1);
    expect(iLowest(OHLC_BARS, SERIES_MODE.MODE_LOW, 0, -1)).toBe(-1);
    expect(iHighest(OHLC_BARS, SERIES_MODE.MODE_HIGH, 0, OHLC_BARS.length)).toBe(-1);
  });

  it('MODE_VOLUME finds the extreme tick volume', () => {
    // tickVolume increases with i (100+i) → max is the last chrono bar = as-series 0.
    expect(iHighest(OHLC_BARS, SERIES_MODE.MODE_VOLUME, 0, 0)).toBe(0);
    // min volume is the oldest bar = as-series n-1.
    expect(iLowest(OHLC_BARS, SERIES_MODE.MODE_VOLUME, 0, 0)).toBe(OHLC_BARS.length - 1);
  });
});
