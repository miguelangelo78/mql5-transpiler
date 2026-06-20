/**
 * Simple Moving Average — MT5-exact.
 *
 * Reference: MetaTrader5/MQL5/Include/MovingAverages.mqh `SimpleMA`:
 *
 *   double SimpleMA(position, period, price[]) {
 *     if (period>0 && period<=(position+1)) {
 *       for i in 0..period-1: result += price[position-i];
 *       result /= period;
 *     }
 *     return result;   // 0.0 when not enough bars
 *   }
 *
 * i.e. SMA at chronological bar `pos` = mean of applied-price over
 * [pos-period+1 .. pos]; the first (period-1) bars have NO value. In MT5 the
 * indicator buffer reports EMPTY_VALUE (no plottable value) there; we model
 * "no value" as `null` in the chronological series and let CopyBuffer surface
 * MT5's behaviour (CopyBuffer only ever copies positions that HAVE a value —
 * it returns fewer than requested rather than copying garbage).
 *
 * ma_shift: MT5 shifts the whole MA line forward by `shift` bars. So the value
 * reported AT bar i is the SMA computed at bar (i - shift). Bars where
 * (i - shift) is itself a warm-up position have no value.
 */

import type { Bar } from '../providers/types';
import { appliedPrice, type IndicatorSeries } from './types';

/**
 * Compute the SMA series, chronological, aligned 1:1 with `bars`.
 * @param bars   chronological (oldest→newest) bar array from the feed.
 * @param period averaging period (>0).
 * @param applied ENUM_APPLIED_PRICE id.
 * @param shift  MT5 ma_shift (default 0). Forward shift of the line.
 */
export function computeSMA(
  bars: readonly Bar[],
  period: number,
  applied: number,
  shift = 0,
): IndicatorSeries {
  const n = bars.length;
  const out: IndicatorSeries = new Array(n).fill(null);
  if (period <= 0 || n === 0) return out;

  // price[i] = applied price at chronological bar i.
  const price = new Array<number>(n);
  for (let i = 0; i < n; i++) price[i] = appliedPrice(bars[i]!, applied);

  // Base (unshifted) SMA: sma[pos] defined iff pos >= period-1.
  // Use a running sum for O(n); matches the naive sum to full double precision
  // for the windows MT5 uses (MT5 itself recomputes the window sum each bar).
  const sma = new Array<number | null>(n).fill(null);
  for (let pos = period - 1; pos < n; pos++) {
    // Recompute the window sum exactly like SimpleMA's inner loop (no running
    // carry drift): sum of price[pos-period+1 .. pos].
    let sum = 0.0;
    for (let i = 0; i < period; i++) sum += price[pos - i]!;
    sma[pos] = sum / period;
  }

  // Apply ma_shift: value at bar i = base SMA at bar (i - shift).
  if (shift === 0) return sma;
  for (let i = 0; i < n; i++) {
    const src = i - shift;
    out[i] = src >= 0 && src < n ? sma[src]! : null;
  }
  return out;
}
