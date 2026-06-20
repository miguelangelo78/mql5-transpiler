/**
 * Commodity Channel Index — MT5-EXACT (global CLAUDE.md §21).
 *
 * Ground truth: MetaTrader 5's own `MQL5/Indicators/Examples/CCI.mq5`
 * (`Copyright 2000-2026, MetaQuotes Ltd.`) — the indicator iCCI actually runs.
 *
 * SetIndexBuffer ORDER (CCI.mq5 OnInit):
 *   buffer 0 = ExtCCIBuffer (MAIN — the only CopyBuffer-readable buffer)
 *   buffer 1 = ExtDBuffer   (INDICATOR_CALCULATIONS — mean deviation * 0.015)
 *   buffer 2 = ExtMBuffer   (INDICATOR_CALCULATIONS — price-SMA)
 *   buffer 3 = ExtSPBuffer  (INDICATOR_CALCULATIONS — SimpleMA)
 *
 * `#property indicator_applied_price PRICE_TYPICAL` — CCI's default source is the
 * typical price (H+L+C)/3. iCCI takes an ENUM_APPLIED_PRICE arg (default
 * PRICE_TYPICAL); the value flows into `price[]` exactly as MT5 feeds OnCalculate.
 *
 * OnCalculate (chronological index i = bar i, oldest→newest), begin=0:
 *   ExtMultiplyer = 0.015 / period
 *   SP[i] = SimpleMA(i, period, price)                    // valid from i>=period-1
 *   D[i]  = (Σ_{j=0..period-1} |price[i-j]-SP[i]|) * ExtMultiplyer
 *   M[i]  = price[i] - SP[i]
 *   CCI[i] = D[i]!=0 ? M[i]/D[i] : 0.0
 *
 * i.e. CCI = (price - SMA) / (0.015 * meanAbsDeviation). The `/0.015` lives in
 * ExtMultiplyer (folded into D), and the `D==0 → CCI=0` special case is honoured
 * exactly (a flat window has zero mean deviation → MT5 reports 0, not NaN).
 *
 * Warm-up: first value at chronological index period-1 (SimpleMA's boundary).
 * Modelled as null before that, consistent with sma.ts.
 */

import type { Bar } from '../providers/types';
import { appliedPrice, type IndicatorSeries } from './types';

export function computeCCI(
  bars: readonly Bar[],
  period: number,
  applied: number,
): IndicatorSeries {
  const n = bars.length;
  const out: IndicatorSeries = new Array(n).fill(null);
  if (period <= 0 || n === 0 || n < period) return out;

  // Applied-price series (chronological); iCCI default PRICE_TYPICAL.
  const price = new Array<number>(n);
  for (let i = 0; i < n; i++) price[i] = appliedPrice(bars[i]!, applied);

  const multiplyer = 0.015 / period;

  for (let i = period - 1; i < n; i++) {
    // SP[i] = SimpleMA(i, period, price).
    let sum = 0.0;
    for (let j = 0; j < period; j++) sum += price[i - j]!;
    const sp = sum / period;

    // D[i] = mean abs deviation * 0.015.
    let tmpD = 0.0;
    for (let j = 0; j < period; j++) tmpD += Math.abs(price[i - j]! - sp);
    const d = tmpD * multiplyer;

    // M[i] = price[i] - SP[i].
    const m = price[i]! - sp;

    out[i] = d !== 0.0 ? m / d : 0.0;
  }

  return out;
}
