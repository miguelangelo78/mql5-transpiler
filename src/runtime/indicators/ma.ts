/**
 * Moving-average methods — MT5-EXACT (global CLAUDE.md §21).
 *
 * Ground truth: MetaTrader 5's own `MQL5/Include/MovingAverages.mqh`
 * (`Copyright 2000-2026, MetaQuotes Ltd.`). The *OnBuffer variants are the
 * functions MT5's iMA indicator actually runs, and they are what we replicate
 * here — NOT the textbook formulas, which differ at the warm-up boundary.
 *
 * Each `compute*` returns a CHRONOLOGICAL series (index i = bar i), 1:1 with
 * `bars`, with `null` at positions MT5 leaves empty (no plottable value). The
 * `shift` is MT5's ma_shift (horizontal forward shift of the whole line).
 *
 * Warm-up boundary per method (begin=0, the iMA case):
 *   - SMA  : first value at index period-1   (see sma.ts)
 *   - EMA  : first value at index 0 — buffer[0]=price[0], no warm-up null.
 *   - SMMA : first value at index period-1 (seed = SMA of first `period`), then
 *            recursive Wilder smoothing.
 *   - LWMA : first value at index period-1 (linearly-weighted, newest = period).
 *
 * Reference (MovingAverages.mqh, begin=0):
 *   ExponentialMAOnBuffer:  buffer[0]=price[0];
 *                           buffer[i]=price[i]*k + buffer[i-1]*(1-k), k=2/(1+p)
 *   SmoothedMAOnBuffer:     buffer[0..p-2]=0 (empty);
 *                           buffer[p-1]=mean(price[0..p-1]);
 *                           buffer[i]=(buffer[i-1]*(p-1)+price[i])/p
 *   LinearWeightedMAOnBuffer (classic): buffer[0..p-1]=0 (empty);
 *                           buffer[p-1] onward = Σ price[pos-p+1+j]*(j+1) / Σ(j+1)
 *                           i.e. the most-recent price carries weight `period`.
 */

import type { Bar } from '../providers/types';
import { appliedPrice, type IndicatorSeries } from './types';

/** Apply MT5 ma_shift: value at bar i = base value at bar (i-shift). */
function applyShift(base: IndicatorSeries, shift: number): IndicatorSeries {
  if (shift === 0) return base;
  const n = base.length;
  const out: IndicatorSeries = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const src = i - shift;
    out[i] = src >= 0 && src < n ? base[src]! : null;
  }
  return out;
}

/** Extract the applied-price series, chronological. */
function priceSeries(bars: readonly Bar[], applied: number): number[] {
  const n = bars.length;
  const price = new Array<number>(n);
  for (let i = 0; i < n; i++) price[i] = appliedPrice(bars[i]!, applied);
  return price;
}

/**
 * Exponential MA — MT5 `ExponentialMAOnBuffer`, begin=0.
 * buffer[0]=price[0]; buffer[i]=price[i]*k + buffer[i-1]*(1-k), k=2/(1+period).
 * Every bar (from index 0) has a value.
 */
export function computeEMA(
  bars: readonly Bar[],
  period: number,
  applied: number,
  shift = 0,
): IndicatorSeries {
  const n = bars.length;
  const out: IndicatorSeries = new Array(n).fill(null);
  if (period <= 0 || n === 0) return out;
  const price = priceSeries(bars, applied);
  const k = 2.0 / (1.0 + period);
  out[0] = price[0]!;
  for (let i = 1; i < n; i++) {
    out[i] = price[i]! * k + (out[i - 1] as number) * (1.0 - k);
  }
  return applyShift(out, shift);
}

/**
 * Smoothed MA (SMMA = Wilder's RMA) — MT5 `SmoothedMAOnBuffer`, begin=0.
 * Empty for the first period-1 bars; seed at index period-1 = SMA of the first
 * `period` prices; then buffer[i]=(buffer[i-1]*(period-1)+price[i])/period.
 */
export function computeSMMA(
  bars: readonly Bar[],
  period: number,
  applied: number,
  shift = 0,
): IndicatorSeries {
  const n = bars.length;
  const out: IndicatorSeries = new Array(n).fill(null);
  if (period <= 0 || n === 0) return out;
  const price = priceSeries(bars, applied);
  if (n < period) return out; // no value yet
  // Seed at index period-1: simple average of price[0..period-1].
  let sum = 0.0;
  for (let i = 0; i < period; i++) sum += price[i]!;
  out[period - 1] = sum / period;
  for (let i = period; i < n; i++) {
    out[i] = ((out[i - 1] as number) * (period - 1) + price[i]!) / period;
  }
  return applyShift(out, shift);
}

/**
 * Linear Weighted MA — MT5 `LinearWeightedMAOnBuffer` (classic), begin=0.
 * Empty for the first period-1 bars; from index period-1 the value at pos is
 *   Σ_{j=0..period-1} price[pos-period+1+j]*(j+1)  /  Σ_{j=0..period-1}(j+1)
 * so the newest bar in the window carries weight `period`, the oldest weight 1.
 */
export function computeLWMA(
  bars: readonly Bar[],
  period: number,
  applied: number,
  shift = 0,
): IndicatorSeries {
  const n = bars.length;
  const out: IndicatorSeries = new Array(n).fill(null);
  if (period <= 0 || n === 0) return out;
  const price = priceSeries(bars, applied);
  if (n < period) return out;
  // Constant weight denominator: 1+2+...+period.
  let weight = 0;
  for (let l = 1; l <= period; l++) weight += l;
  for (let pos = period - 1; pos < n; pos++) {
    // price[pos-period+1] gets weight 1 ... price[pos] gets weight `period`.
    let sum = 0.0;
    for (let j = 0; j < period; j++) {
      sum += price[pos - period + 1 + j]! * (j + 1);
    }
    out[pos] = sum / weight;
  }
  return applyShift(out, shift);
}
