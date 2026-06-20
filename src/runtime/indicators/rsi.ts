/**
 * Relative Strength Index — MT5-EXACT (global CLAUDE.md §21).
 *
 * Ground truth: MetaTrader 5's own `MQL5/Indicators/Examples/RSI.mq5`
 * (`Copyright 2000-2026, MetaQuotes Ltd.`) — the indicator iRSI actually runs.
 * We replicate its `OnCalculate` exactly, including the warm-up boundary and
 * the avgLoss==0 special cases (which a naïve `100-100/(1+RS)` gets wrong).
 *
 * Layout (begin=0, chronological index i = bar i, oldest→newest):
 *   - price diff at bar i: diff = price[i] - price[i-1]   (diff at i=0 unused)
 *   - SEED at index `period` (NOT period-1): the first `period` diffs (i=1..period)
 *     are simple-averaged:
 *         avgGain[period] = Σ_{i=1..period} max(diff_i,0) / period
 *         avgLoss[period] = Σ_{i=1..period} max(-diff_i,0) / period
 *   - indices 0..period-1 have NO value (MT5 writes 0.0 there; we model null).
 *   - Wilder recursion from index period+1:
 *         avgGain[i] = (avgGain[i-1]*(period-1) + max(diff_i,0)) / period
 *         avgLoss[i] = (avgLoss[i-1]*(period-1) + max(-diff_i,0)) / period
 *   - RSI:
 *         if avgLoss != 0:  RSI = 100 - 100/(1 + avgGain/avgLoss)
 *         elif avgGain != 0: RSI = 100
 *         else:              RSI = 50      ← MT5's flat-market value
 *
 * First valid value is at chronological index `period`. The applied price is
 * selected per ENUM_APPLIED_PRICE (PRICE_CLOSE by default in iRSI).
 */

import type { Bar } from '../providers/types';
import { appliedPrice, type IndicatorSeries } from './types';

export function computeRSI(
  bars: readonly Bar[],
  period: number,
  applied: number,
): IndicatorSeries {
  const n = bars.length;
  const out: IndicatorSeries = new Array(n).fill(null);
  // MT5: `if(rates_total<=ExtPeriodRSI) return(0);` → need > period bars.
  if (period < 1 || n <= period) return out;

  // Applied-price series (chronological).
  const price = new Array<number>(n);
  for (let i = 0; i < n; i++) price[i] = appliedPrice(bars[i]!, applied);

  // ── seed at index `period`: simple average of the first `period` diffs ──
  let sumPos = 0.0;
  let sumNeg = 0.0;
  for (let i = 1; i <= period; i++) {
    const diff = price[i]! - price[i - 1]!;
    sumPos += diff > 0 ? diff : 0;
    sumNeg += diff < 0 ? -diff : 0;
  }
  let avgGain = sumPos / period;
  let avgLoss = sumNeg / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  // ── Wilder recursion from index period+1 ──
  for (let i = period + 1; i < n; i++) {
    const diff = price[i]! - price[i - 1]!;
    const up = diff > 0.0 ? diff : 0.0;
    const dn = diff < 0.0 ? -diff : 0.0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + dn) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }

  return out;
}

/** MT5's RSI value from avg gain/loss, including the avgLoss==0 branches. */
function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss !== 0.0) {
    return 100.0 - 100.0 / (1.0 + avgGain / avgLoss);
  }
  if (avgGain !== 0.0) return 100.0;
  return 50.0; // flat market — MT5 reports 50, not 0/NaN.
}
