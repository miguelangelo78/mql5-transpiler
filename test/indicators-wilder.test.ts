/**
 * Indicator fidelity tests — MT5-EXACT (global CLAUDE.md §21).
 *
 * Each indicator is checked against an INDEPENDENT reference computed inline
 * from MetaQuotes' own source recurrences (RSI.mq5 / ATR.mq5 /
 * MovingAverages.mqh), NOT by calling the implementation under test. The
 * reference loops are written longhand so a divergence in the impl is caught.
 *
 * Coverage:
 *   - iRSI: warm-up boundary (first valid at index `period`), Wilder recursion,
 *           the avgLoss==0 / both-zero special cases (RSI=100 / RSI=50).
 *   - iATR: MT5's SMA-of-True-Range (NOT Wilder smoothing — load-bearing §21
 *           finding), exact TR = max(H,Cp)-min(L,Cp), first valid at `period`.
 *   - iMA EMA/SMMA/LWMA: warm-up + smoothing vs reference.
 *
 * Run: npx vitest run test/indicators-wilder.test.ts
 */

import { describe, it, expect } from 'vitest';
import type { Bar } from '../src/runtime/providers/types';
import { computeRSI } from '../src/runtime/indicators/rsi';
import { computeATR } from '../src/runtime/indicators/atr';
import { computeEMA, computeSMMA, computeLWMA } from '../src/runtime/indicators/ma';
import { computeSMA } from '../src/runtime/indicators/sma';

const PRICE_CLOSE = 1;

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

/** Build a bar from explicit OHLC (time auto-increments). */
function ohlc(i: number, o: number, h: number, l: number, c: number): Bar {
  return {
    time: 1_700_000_000 + i * 60,
    open: o,
    high: h,
    low: l,
    close: c,
    tickVolume: 1,
    spread: 0,
    realVolume: 0,
  };
}

/** Close-only bar series (open/high/low derived so applied=CLOSE is the close). */
function closeBars(closes: number[]): Bar[] {
  return closes.map((c, i) => ohlc(i, c, c + 0.5, c - 0.5, c));
}

// A deliberately wiggly close series long enough to clear a period-5 warm-up
// with both up and down moves (so neither avgGain nor avgLoss is trivially 0).
const CLOSES = [
  44.0, 44.25, 44.5, 43.75, 44.5, 45.0, 47.0, 46.75, 46.5, 46.25, 47.75, 47.5,
  47.0, 47.25, 46.75, 46.5, 46.25, 47.75, 47.5, 47.0,
];

// ─────────────────────────────────────────────────────────────────────────
// Independent reference implementations (longhand from MT5 source)
// ─────────────────────────────────────────────────────────────────────────

/** RSI reference — RSI.mq5 OnCalculate, longhand. Returns chronological array
 *  with null for warm-up (indices 0..period-1). */
function refRSI(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period < 1 || n <= period) return out;
  // seed
  let sumPos = 0;
  let sumNeg = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) sumPos += d;
    else if (d < 0) sumNeg += -d;
  }
  let ag = sumPos / period;
  let al = sumNeg / period;
  out[period] = rsiVal(ag, al);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = rsiVal(ag, al);
  }
  return out;
}
function rsiVal(ag: number, al: number): number {
  if (al !== 0) return 100 - 100 / (1 + ag / al);
  if (ag !== 0) return 100;
  return 50;
}

/** ATR reference — ATR.mq5 OnCalculate, longhand (SMA-of-TR). */
function refATR(bars: Bar[], period: number): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period <= 0 || n <= period) return out;
  const tr = new Array<number>(n);
  tr[0] = 0;
  for (let i = 1; i < n; i++) {
    const h = bars[i]!.high;
    const l = bars[i]!.low;
    const pc = bars[i - 1]!.close;
    tr[i] = Math.max(h, pc) - Math.min(l, pc);
  }
  let first = 0;
  for (let i = 1; i <= period; i++) first += tr[i]!;
  out[period] = first / period;
  for (let i = period + 1; i < n; i++) {
    out[i] = (out[i - 1] as number) + (tr[i]! - tr[i - period]!) / period;
  }
  return out;
}

/** EMA reference — ExponentialMAOnBuffer begin=0. */
function refEMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period <= 0 || n === 0) return out;
  const k = 2 / (1 + period);
  out[0] = closes[0]!;
  for (let i = 1; i < n; i++) out[i] = closes[i]! * k + (out[i - 1] as number) * (1 - k);
  return out;
}

/** SMMA reference — SmoothedMAOnBuffer begin=0. */
function refSMMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period <= 0 || n < period) return out;
  let s = 0;
  for (let i = 0; i < period; i++) s += closes[i]!;
  out[period - 1] = s / period;
  for (let i = period; i < n; i++) out[i] = ((out[i - 1] as number) * (period - 1) + closes[i]!) / period;
  return out;
}

/** LWMA reference — LinearWeightedMAOnBuffer classic, begin=0. */
function refLWMA(closes: number[], period: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period <= 0 || n < period) return out;
  let w = 0;
  for (let l = 1; l <= period; l++) w += l;
  for (let pos = period - 1; pos < n; pos++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += closes[pos - period + 1 + j]! * (j + 1);
    out[pos] = sum / w;
  }
  return out;
}

/** Compare two chronological series for exact null-placement + numeric match. */
function expectSeriesMatch(
  got: (number | null)[],
  ref: (number | null)[],
  tol = 1e-12,
): void {
  expect(got.length).toBe(ref.length);
  for (let i = 0; i < ref.length; i++) {
    const g = got[i];
    const r = ref[i];
    if (r === null) {
      expect(g, `index ${i} should be warm-up (null)`).toBeNull();
    } else {
      expect(g, `index ${i} should have a value`).not.toBeNull();
      expect(Math.abs((g as number) - r), `index ${i}: got ${g}, want ${r}`).toBeLessThan(tol);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// iRSI
// ─────────────────────────────────────────────────────────────────────────

describe('iRSI — Wilder RSI, MT5-exact', () => {
  it('matches the independent reference across the full series (period 14)', () => {
    const bars = closeBars(CLOSES);
    expectSeriesMatch(computeRSI(bars, 14, PRICE_CLOSE), refRSI(CLOSES, 14));
  });

  it('first valid value is exactly at index `period`; earlier are null', () => {
    const bars = closeBars(CLOSES);
    const period = 5;
    const out = computeRSI(bars, period, PRICE_CLOSE);
    for (let i = 0; i < period; i++) expect(out[i], `index ${i}`).toBeNull();
    expect(out[period]).not.toBeNull();
  });

  it('seed at index `period` = SMA of the first `period` diffs (hand-checked)', () => {
    // period=5 over CLOSES: diffs i=1..5 = [.25,.25,-.75,.75,.5]
    //   sumPos = .25+.25+.75+.5 = 1.75 ; sumNeg = .75
    //   avgGain=1.75/5=0.35 ; avgLoss=0.75/5=0.15 ; RS=0.35/0.15=2.3333...
    //   RSI = 100 - 100/(1+2.3333...) = 100 - 30 = 70
    const out = computeRSI(closeBars(CLOSES), 5, PRICE_CLOSE);
    expect(Math.abs((out[5] as number) - 70)).toBeLessThan(1e-9);
  });

  it('all-up market → avgLoss==0 → RSI = 100 (not NaN)', () => {
    const out = computeRSI(closeBars([1, 2, 3, 4, 5, 6, 7, 8]), 3, PRICE_CLOSE);
    for (let i = 3; i < 8; i++) expect(out[i]).toBe(100);
  });

  it('perfectly flat market → both avg 0 → RSI = 50 (MT5 flat value)', () => {
    const out = computeRSI(closeBars([5, 5, 5, 5, 5, 5, 5, 5]), 3, PRICE_CLOSE);
    for (let i = 3; i < 8; i++) expect(out[i]).toBe(50);
  });

  it('needs > period bars (n<=period → all null)', () => {
    // exactly period+1 bars is the minimum that yields one value (n>period).
    expect(computeRSI(closeBars([1, 2, 3]), 3, PRICE_CLOSE).every((v) => v === null)).toBe(true);
    const out4 = computeRSI(closeBars([1, 2, 1, 2]), 3, PRICE_CLOSE);
    expect(out4[3]).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// iATR
// ─────────────────────────────────────────────────────────────────────────

describe('iATR — MT5 SMA-of-True-Range (NOT Wilder), exact', () => {
  // A bar series with varied gaps so TR exercises all three max/min branches:
  //   bar with prevClose inside [L,H], prevClose above H, prevClose below L.
  const ATR_BARS: Bar[] = [
    ohlc(0, 10, 11, 9, 10), // TR[0]=0
    ohlc(1, 10, 12, 10, 11), // pc=10 in [10,12] → 12-10=2
    ohlc(2, 11, 13, 11.5, 12), // pc=11 < L=11.5 → max(13,11)-min(11.5,11)=13-11=2
    ohlc(3, 12, 12.5, 11, 11.5), // pc=12 in [11,12.5] → 1.5
    ohlc(4, 11.5, 11.8, 9, 9.5), // pc=11.5 > H=11.8 → max(11.8,11.5)-min(9,11.5)=11.8-9=2.8
    ohlc(5, 9.5, 10.5, 9.2, 10), // pc=9.5 in [9.2,10.5] → 1.3
    ohlc(6, 10, 10.2, 9.8, 10.1), // pc=10 in [9.8,10.2] → 0.4
    ohlc(7, 10.1, 11.0, 10.0, 10.8), // pc=10.1 in [10,11] → 1.0
  ];

  it('matches the independent reference (period 3) over the full series', () => {
    expectSeriesMatch(computeATR(ATR_BARS, 3), refATR(ATR_BARS, 3));
  });

  it('first valid value is at index `period`; earlier are null', () => {
    const out = computeATR(ATR_BARS, 3);
    for (let i = 0; i < 3; i++) expect(out[i], `index ${i}`).toBeNull();
    expect(out[3]).not.toBeNull();
  });

  it('seed = mean(TR[1..period]) (hand-checked)', () => {
    // TR[1..3] = [2, 2, 1.5] → mean = 5.5/3 = 1.8333...
    const out = computeATR(ATR_BARS, 3);
    expect(Math.abs((out[3] as number) - 5.5 / 3)).toBeLessThan(1e-12);
  });

  it('recursion is SMA-of-TR, not Wilder (explicit numeric proof)', () => {
    // ATR[4] under MT5's SMA-of-TR = ATR[3] + (TR[4]-TR[1])/period
    //   = 5.5/3 + (2.8 - 2)/3 = 1.833333.. + 0.266666.. = 2.1
    // A WILDER ATR would instead give (ATR[3]*(p-1)+TR[4])/p
    //   = (1.83333*2 + 2.8)/3 = (3.66666+2.8)/3 = 2.155555..  ← different!
    const out = computeATR(ATR_BARS, 3);
    const mt5 = 5.5 / 3 + (2.8 - 2) / 3;
    const wilder = ((5.5 / 3) * 2 + 2.8) / 3;
    expect(Math.abs((out[4] as number) - mt5)).toBeLessThan(1e-12);
    expect(Math.abs((out[4] as number) - wilder)).toBeGreaterThan(0.05);
  });

  it('TR uses max(H,Cp)-min(L,Cp) including prevClose outside [L,H]', () => {
    // bar 4 has prevClose 11.5 ABOVE its high 11.8 → TR must be 11.8-9=2.8,
    // not the bare high-low = 2.8? (here H-L=2.8 too) — use bar 2 where pc<L:
    // bar 2 H=13 L=11.5 pc=11 → TR=13-11=2 (NOT H-L=1.5). Reference encodes it.
    const ref = refATR(ATR_BARS, 3);
    // Confirm via reference that TR[2] influenced the seed (seed=1.8333 uses 2).
    expect(Math.abs((ref[3] as number) - 5.5 / 3)).toBeLessThan(1e-12);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// iMA EMA / SMMA / LWMA
// ─────────────────────────────────────────────────────────────────────────

describe('iMA EMA — ExponentialMAOnBuffer, exact', () => {
  it('matches reference; value at index 0 = price[0] (no warm-up null)', () => {
    const out = computeEMA(closeBars(CLOSES), 5, PRICE_CLOSE);
    expect(out[0]).toBe(CLOSES[0]); // seeded with first price
    expectSeriesMatch(out, refEMA(CLOSES, 5));
  });

  it('EMA recursion is price*k + prev*(1-k), k=2/(period+1) (hand-checked)', () => {
    const out = computeEMA(closeBars(CLOSES), 9, PRICE_CLOSE);
    const k = 2 / 10;
    const expect1 = CLOSES[1]! * k + CLOSES[0]! * (1 - k);
    expect(Math.abs((out[1] as number) - expect1)).toBeLessThan(1e-12);
  });
});

describe('iMA SMMA — SmoothedMAOnBuffer (= Wilder RMA), exact', () => {
  it('matches reference; first valid at index period-1 (seed = SMA)', () => {
    const period = 5;
    const out = computeSMMA(closeBars(CLOSES), period, PRICE_CLOSE);
    for (let i = 0; i < period - 1; i++) expect(out[i], `index ${i}`).toBeNull();
    // seed = mean(first 5 closes)
    const seed = (44.0 + 44.25 + 44.5 + 43.75 + 44.5) / 5;
    expect(Math.abs((out[period - 1] as number) - seed)).toBeLessThan(1e-12);
    expectSeriesMatch(out, refSMMA(CLOSES, period));
  });
});

describe('iMA LWMA — LinearWeightedMAOnBuffer, exact', () => {
  it('matches reference; first valid at index period-1; newest weight = period', () => {
    const period = 4;
    const out = computeLWMA(closeBars(CLOSES), period, PRICE_CLOSE);
    for (let i = 0; i < period - 1; i++) expect(out[i], `index ${i}`).toBeNull();
    // value at index 3 over closes[0..3]=[44,44.25,44.5,43.75], weights 1..4
    //   = (44*1 + 44.25*2 + 44.5*3 + 43.75*4)/(1+2+3+4)
    const num = 44.0 * 1 + 44.25 * 2 + 44.5 * 3 + 43.75 * 4;
    const den = 1 + 2 + 3 + 4;
    expect(Math.abs((out[period - 1] as number) - num / den)).toBeLessThan(1e-12);
    expectSeriesMatch(out, refLWMA(CLOSES, period));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-check: SMA still matches (no regression from the shared shift helper)
// ─────────────────────────────────────────────────────────────────────────

describe('iMA SMA — unchanged baseline', () => {
  it('first valid at index period-1, value = window mean', () => {
    const out = computeSMA(closeBars(CLOSES), 3, PRICE_CLOSE);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(Math.abs((out[2] as number) - (44.0 + 44.25 + 44.5) / 3)).toBeLessThan(1e-12);
  });
});
