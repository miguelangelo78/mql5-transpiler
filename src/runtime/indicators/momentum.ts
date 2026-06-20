/**
 * Momentum — MT5-EXACT (global CLAUDE.md §21).
 *
 * Ground truth: MetaTrader 5's own `MQL5/Indicators/Examples/Momentum.mq5`
 * (`Copyright 2000-2026, MetaQuotes Ltd.`) — the indicator iMomentum runs.
 *
 * SetIndexBuffer (Momentum.mq5): buffer 0 = ExtMomentumBuffer (the only buffer).
 *
 * OnCalculate (chronological index i = bar i, oldest→newest), begin=0:
 *   ExtMomentumBuffer[i] = price[i] * 100 / price[i-period]
 *
 * ⚠️ LOAD-BEARING §21 boundary: although DRAW_BEGIN/start_position is period-1,
 * the COMPUTATION loop's first index is `period`, not period-1. Momentum.mq5:
 *     int pos = prev_calculated-1;
 *     if(pos < start_position) pos = begin + ExtMomentumPeriod;   // = period
 *     for(i=pos; ...) buffer[i] = price[i]*100/price[i-ExtMomentumPeriod];
 * So on first calc `pos = period`, and the value at index period-1 is never
 * written (it would need price[-1]). First valid value is at index `period`.
 * (Modelled as null before that; matches what CopyBuffer can return.)
 *
 * appliedPrice (default PRICE_CLOSE in iMomentum) selects `price[]`.
 */

import type { Bar } from '../providers/types';
import { appliedPrice, type IndicatorSeries } from './types';

export function computeMomentum(
  bars: readonly Bar[],
  period: number,
  applied: number,
): IndicatorSeries {
  const n = bars.length;
  const out: IndicatorSeries = new Array(n).fill(null);
  if (period <= 0 || n === 0) return out;

  // Applied-price series (chronological).
  const price = new Array<number>(n);
  for (let i = 0; i < n; i++) price[i] = appliedPrice(bars[i]!, applied);

  // First written index is `period` (loop start pos = begin+period, begin=0).
  for (let i = period; i < n; i++) {
    out[i] = (price[i]! * 100.0) / price[i - period]!;
  }

  return out;
}
