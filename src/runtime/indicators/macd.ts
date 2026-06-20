/**
 * MACD — MT5-EXACT (global CLAUDE.md §21).
 *
 * Ground truth: MetaTrader 5's own `MQL5/Indicators/Examples/MACD.mq5`
 * (`Copyright 2000-2026, MetaQuotes Ltd.`) — the indicator iMACD actually runs.
 *
 * SetIndexBuffer ORDER (MACD.mq5 OnInit, load-bearing buffer numbering):
 *   buffer 0 = ExtMacdBuffer   (MAIN  = EMA(fast) - EMA(slow))
 *   buffer 1 = ExtSignalBuffer (SIGNAL = SimpleMA of MAIN, period=signalSMA)
 *   buffer 2 = ExtFastMaBuffer (INDICATOR_CALCULATIONS)
 *   buffer 3 = ExtSlowMaBuffer (INDICATOR_CALCULATIONS)
 *
 * ⚠️ LOAD-BEARING §21: the SIGNAL line is a *Simple* MA of the MACD line, NOT an
 * EMA. MACD.mq5 calls `SimpleMAOnBuffer(...,InpSignalSMA,ExtMacdBuffer,ExtSignalBuffer)`.
 * (A common textbook MACD uses an EMA signal; MT5's example does NOT.)
 *
 * MAIN line (MACD.mq5):
 *   - Fast & Slow are iMA(NULL,0,period,0,MODE_EMA,price) — `ExponentialMAOnBuffer`
 *     with begin=0: buffer[0]=price[0]; buffer[i]=price[i]*k+buffer[i-1]*(1-k),
 *     k=2/(1+period). Every bar (from index 0) has a value.
 *   - ExtMacdBuffer[i] = ExtFastMaBuffer[i] - ExtSlowMaBuffer[i]  (every bar).
 *
 * SIGNAL line — `SimpleMAOnBuffer(rates_total, 0, begin=0, period=signalSMA,
 *   price=ExtMacdBuffer, buffer=ExtSignalBuffer)`:
 *     start_position = signalSMA;                         // = period+begin, begin=0
 *     buffer[0..signalSMA-2] = 0.0;                       // empty (warm-up)
 *     buffer[signalSMA-1] = mean(macd[0..signalSMA-1]);   // first visible value
 *     buffer[i] = buffer[i-1] + (macd[i]-macd[i-signalSMA])/signalSMA;  // i>=signalSMA
 *   ⇒ SIGNAL's first plottable value is at chronological index signalSMA-1.
 *
 * Warm-up modelling: MAIN exists at every bar (EMA seeds from index 0), so MAIN
 * has NO null. SIGNAL is null for i < signalSMA-1 (SimpleMAOnBuffer writes 0.0
 * there; we model "no value" as null, consistent with sma.ts).
 *
 * appliedPrice (default PRICE_CLOSE in iMACD) flows into both EMAs.
 */

import type { Bar } from '../providers/types';
import { appliedPrice, type IndicatorSeries } from './types';

export interface MacdBuffers {
  main: IndicatorSeries; // buffer 0
  signal: IndicatorSeries; // buffer 1
}

/** ExponentialMAOnBuffer (begin=0): full-length EMA series, value at every bar. */
function emaBuffer(price: readonly number[], period: number): number[] {
  const n = price.length;
  const out = new Array<number>(n);
  if (n === 0) return out;
  const k = 2.0 / (1.0 + period);
  out[0] = price[0]!;
  for (let i = 1; i < n; i++) out[i] = price[i]! * k + out[i - 1]! * (1.0 - k);
  return out;
}

export function computeMACD(
  bars: readonly Bar[],
  fastEMA: number,
  slowEMA: number,
  signalSMA: number,
  applied: number,
): MacdBuffers {
  const n = bars.length;
  const main: IndicatorSeries = new Array(n).fill(null);
  const signal: IndicatorSeries = new Array(n).fill(null);
  if (fastEMA <= 0 || slowEMA <= 0 || signalSMA <= 0 || n === 0)
    return { main, signal };

  // Applied-price series (chronological).
  const price = new Array<number>(n);
  for (let i = 0; i < n; i++) price[i] = appliedPrice(bars[i]!, applied);

  // MAIN = EMA(fast) - EMA(slow), value at every bar.
  const fast = emaBuffer(price, fastEMA);
  const slow = emaBuffer(price, slowEMA);
  const macd = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    macd[i] = fast[i]! - slow[i]!;
    main[i] = macd[i]!;
  }

  // SIGNAL = SimpleMAOnBuffer over MAIN with period=signalSMA, begin=0.
  // SimpleMAOnBuffer guard: period>1 && period<=rates_total. period==1 is a
  // degenerate SMA (== the series itself); MT5's guard `period<=1` returns 0
  // (no buffer written), so SIGNAL stays all-null. We honour that exactly.
  if (signalSMA > 1 && signalSMA <= n) {
    // first visible value at index signalSMA-1 = mean(macd[0..signalSMA-1]).
    let firstValue = 0.0;
    for (let i = 0; i < signalSMA; i++) firstValue += macd[i]!;
    signal[signalSMA - 1] = firstValue / signalSMA;
    // incremental SMA recursion from index signalSMA.
    for (let i = signalSMA; i < n; i++) {
      signal[i] =
        (signal[i - 1] as number) + (macd[i]! - macd[i - signalSMA]!) / signalSMA;
    }
  }

  return { main, signal };
}
