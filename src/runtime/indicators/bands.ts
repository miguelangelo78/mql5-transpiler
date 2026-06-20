/**
 * Bollinger Bands — MT5-EXACT (global CLAUDE.md §21).
 *
 * Ground truth: MetaTrader 5's own `MQL5/Indicators/Examples/BB.mq5`
 * (`Copyright 2000-2026, MetaQuotes Ltd.`) — the indicator iBands actually runs.
 *
 * SetIndexBuffer ORDER (BB.mq5 OnInit, load-bearing buffer numbering):
 *   buffer 0 = ExtMLBuffer  (Bands middle = SimpleMA)
 *   buffer 1 = ExtTLBuffer  (Bands upper  = ML + dev*StdDev)
 *   buffer 2 = ExtBLBuffer  (Bands lower  = ML - dev*StdDev)
 *   buffer 3 = ExtStdDevBuffer (INDICATOR_CALCULATIONS — not CopyBuffer-readable)
 *
 * OnCalculate (begin=0, chronological index i = bar i, oldest→newest):
 *   ML[i]      = SimpleMA(i, period, price)            // 0.0 until i>=period-1
 *   StdDev[i]  = StdDev_Func(i, price, ML, period)     // see below
 *   upper[i]   = ML[i] + deviation * StdDev[i]
 *   lower[i]   = ML[i] - deviation * StdDev[i]
 *
 * StdDev_Func (BB.mq5) — LOAD-BEARING boundary:
 *     double std_dev = 0.0;
 *     if (position >= period)                          // STRICT >= period
 *        { Σ (price[position-i] - ML[position])^2 ; std_dev = sqrt(Σ/period); }
 *     return std_dev;
 *   ⚠️ Note the `>= period`, NOT `>= period-1`. So at the FIRST bar where the
 *   middle line exists (i == period-1) the StdDev is 0.0 → upper == ML == lower
 *   (the bands are collapsed onto the middle). Real width only from i == period.
 *
 * Warm-up: ML uses SimpleMA which returns 0.0 for i < period-1 (no plottable
 * value). We model "no value" as `null` exactly like sma.ts; upper/lower share
 * the middle's null positions. PLOT_DRAW_BEGIN is `period`, but the buffer holds
 * the collapsed value at period-1 — we surface the buffer contents, not the plot
 * cosmetic, matching how CopyBuffer reads raw buffer values.
 *
 * ma_shift (InpBandsShift) — PLOT_SHIFT only shifts the displayed line forward;
 * iBands' shift parameter is the horizontal forward shift of all three buffers
 * (the same ma_shift semantics as iMA). value AT bar i = base value at (i-shift).
 *
 * iBands ignores per-bar applied price for OHLC reads but DOES honour
 * ENUM_APPLIED_PRICE for the source series (BB.mq5's `price[]` is the applied
 * price array MT5 feeds OnCalculate). Default PRICE_CLOSE in iBands.
 */

import type { Bar } from '../providers/types';
import { appliedPrice, type IndicatorSeries } from './types';

export interface BandsBuffers {
  base: IndicatorSeries; // buffer 0 — middle (SMA)
  upper: IndicatorSeries; // buffer 1
  lower: IndicatorSeries; // buffer 2
}

/** Apply MT5 ma_shift to one buffer: value at bar i = base value at (i-shift). */
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

export function computeBands(
  bars: readonly Bar[],
  period: number,
  deviation: number,
  applied: number,
  shift = 0,
): BandsBuffers {
  const n = bars.length;
  const base: IndicatorSeries = new Array(n).fill(null);
  const upper: IndicatorSeries = new Array(n).fill(null);
  const lower: IndicatorSeries = new Array(n).fill(null);
  if (period <= 0 || n === 0) return { base, upper, lower };

  // Applied-price series (chronological).
  const price = new Array<number>(n);
  for (let i = 0; i < n; i++) price[i] = appliedPrice(bars[i]!, applied);

  // Middle = SimpleMA(i, period, price): defined iff i >= period-1.
  for (let i = period - 1; i < n; i++) {
    let sum = 0.0;
    for (let j = 0; j < period; j++) sum += price[i - j]!;
    const ml = sum / period;
    base[i] = ml;

    // StdDev_Func: only when position >= period (STRICT). i==period-1 → 0.
    let stdDev = 0.0;
    if (i >= period) {
      let acc = 0.0;
      for (let j = 0; j < period; j++) {
        const d = price[i - j]! - ml;
        acc += d * d;
      }
      stdDev = Math.sqrt(acc / period);
    }
    upper[i] = ml + deviation * stdDev;
    lower[i] = ml - deviation * stdDev;
  }

  return {
    base: applyShift(base, shift),
    upper: applyShift(upper, shift),
    lower: applyShift(lower, shift),
  };
}
