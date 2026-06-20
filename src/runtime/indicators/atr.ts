/**
 * Average True Range — MT5-EXACT (global CLAUDE.md §21).
 *
 * Ground truth: MetaTrader 5's own `MQL5/Indicators/Examples/ATR.mq5`
 * (`Copyright 2000-2026, MetaQuotes Ltd.`) — the indicator iATR actually runs.
 *
 * ⚠️ LOAD-BEARING §21 FINDING: MT5's ATR is a *Simple* Moving Average of True
 * Range — NOT Wilder/SMMA smoothing, despite ATR conventionally being a Wilder
 * indicator. The reference recurrence is
 *     ATR[i] = ATR[i-1] + (TR[i] - TR[i-period]) / period
 * which is the incremental update of a `period`-wide SMA of TR, and the seed
 * ATR[period] = mean(TR[1..period]) is a plain average. A Wilder ATR would be
 * `(ATR[i-1]*(period-1)+TR[i])/period`; MT5 does NOT do that. We replicate MT5.
 *
 * True Range, MT5's exact expression (NOT the textbook 3-way max — algebraically
 * equal, but we mirror the source byte-for-byte):
 *     TR[i] = MathMax(high[i], close[i-1]) - MathMin(low[i], close[i-1])
 *     TR[0] = 0   (no previous close)
 *
 * Layout (chronological index i = bar i, oldest→newest):
 *   - indices 0..period-1 have NO value (MT5 writes 0.0; we model null).
 *   - SEED at index `period`: mean of TR[1..period]  (TR[0]=0 excluded by loop).
 *   - SMA recursion from index period+1:
 *         ATR[i] = ATR[i-1] + (TR[i] - TR[i-period]) / period
 *
 * First valid value is at chronological index `period`. ATR ignores
 * ENUM_APPLIED_PRICE (it reads OHLC directly).
 */

import type { Bar } from '../providers/types';
import type { IndicatorSeries } from './types';

export function computeATR(
  bars: readonly Bar[],
  period: number,
): IndicatorSeries {
  const n = bars.length;
  const out: IndicatorSeries = new Array(n).fill(null);
  // MT5: `if(rates_total<=ExtPeriodATR) return(0);` → need > period bars.
  if (period <= 0 || n <= period) return out;

  // ── True Range series (chronological); TR[0]=0 ──
  const tr = new Array<number>(n);
  tr[0] = 0.0;
  for (let i = 1; i < n; i++) {
    const h = bars[i]!.high;
    const l = bars[i]!.low;
    const pc = bars[i - 1]!.close;
    tr[i] = Math.max(h, pc) - Math.min(l, pc);
  }

  // ── seed ATR[period] = mean(TR[1..period]) ──
  let firstValue = 0.0;
  for (let i = 1; i <= period; i++) firstValue += tr[i]!;
  firstValue /= period;
  out[period] = firstValue;

  // ── SMA-of-TR recursion from index period+1 ──
  for (let i = period + 1; i < n; i++) {
    out[i] = (out[i - 1] as number) + (tr[i]! - tr[i - period]!) / period;
  }

  return out;
}
