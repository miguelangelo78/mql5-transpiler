/**
 * Stochastic Oscillator — MT5-EXACT (global CLAUDE.md §21).
 *
 * Ground truth: MetaTrader 5's own `MQL5/Indicators/Examples/Stochastic.mq5`
 * (`Copyright 2000-2026, MetaQuotes Ltd.`) — the indicator iStochastic runs.
 *
 * SetIndexBuffer ORDER (Stochastic.mq5 OnInit, load-bearing buffer numbering):
 *   buffer 0 = ExtMainBuffer   (MAIN  = %K)
 *   buffer 1 = ExtSignalBuffer (SIGNAL = %D = SMA(Dperiod) of %K)
 *   buffer 2 = ExtHighesBuffer (INDICATOR_CALCULATIONS)
 *   buffer 3 = ExtLowesBuffer  (INDICATOR_CALCULATIONS)
 *
 * The example uses high[]/low[]/close[] directly — it does NOT branch on a
 * price-field selector. iStochastic's `priceField` (STO_LOWHIGH vs STO_CLOSECLOSE)
 * selects which series feeds the Lowes/Highes extremes AND the %K numerator:
 *   - STO_LOWHIGH (0): lowest = min(LOW), highest = max(HIGH); numerator uses CLOSE.
 *   - STO_CLOSECLOSE (1): lowest = min(CLOSE), highest = max(CLOSE); numerator CLOSE.
 * The example file is the STO_LOWHIGH formula (its dmin from low[], dmax from
 * high[]); we add the STO_CLOSECLOSE variant per MT5's documented behaviour by
 * substituting CLOSE for the low/high extremes. The %K numerator is always CLOSE.
 *
 * OnCalculate (chronological index i = bar i, oldest→newest), STO_LOWHIGH:
 *   Lowes[i]  = min(low[k]),  Highes[i] = max(high[k]),  k=i-Kperiod+1..i
 *               (valid from i >= Kperiod-1)
 *   %K (MAIN), from i >= Kperiod-1+slowing-1:
 *       sum_low  = Σ (close[k]-Lowes[k]),  k=i-slowing+1..i
 *       sum_high = Σ (Highes[k]-Lowes[k]), k=i-slowing+1..i
 *       MAIN[i]  = (sum_high==0) ? 100.0 : sum_low/sum_high*100
 *   %D (SIGNAL), simple average of the last Dperiod %K values:
 *       SIGNAL[i] = Σ MAIN[i-k]/Dperiod, k=0..Dperiod-1
 *
 * ⚠️ §21 NOTE: the example's maMethod parameter is NOT used in this OnCalculate —
 * %D is a plain Simple MA (`sum/InpDPeriod`). iStochastic exposes a maMethod arg,
 * but MetaQuotes' own indicator ALWAYS uses SMA for %D, so we replicate SMA and
 * do NOT fake the other smoothings (would silently diverge from MT5).
 *
 * Warm-up (replicating Stochastic.mq5 exactly, §21):
 *   - MAIN (%K): null before index firstK = (Kperiod-1)+(slowing-1); real from there.
 *   - SIGNAL (%D): MT5's %D loop runs from index Dperiod-1 and reads the %K buffer
 *     where warm-up cells hold the empty value 0.0 — so %D is 0.0 for i<firstK,
 *     "warm-up-contaminated" (real, non-zero) for firstK..firstClean-1, and clean
 *     from firstClean = firstK+(Dperiod-1). CopyBuffer returns ALL of these (the
 *     chart's PLOT_DRAW_BEGIN merely hides the early ones). We reproduce that, so
 *     %D is non-null from index Dperiod-1 onward (NOT only from firstClean).
 * `rates_total<=Kperiod+Dperiod+slowing` ⇒ all null (matches the source guard).
 */

import type { Bar } from '../providers/types';
import type { IndicatorSeries } from './types';

/** MT5 ENUM_STO_PRICE numeric ids. */
export const STO_PRICE = {
  STO_LOWHIGH: 0,
  STO_CLOSECLOSE: 1,
} as const;

export interface StochasticBuffers {
  main: IndicatorSeries; // buffer 0 — %K
  signal: IndicatorSeries; // buffer 1 — %D
}

export function computeStochastic(
  bars: readonly Bar[],
  kPeriod: number,
  dPeriod: number,
  slowing: number,
  priceField: number,
): StochasticBuffers {
  const n = bars.length;
  const main: IndicatorSeries = new Array(n).fill(null);
  const signal: IndicatorSeries = new Array(n).fill(null);
  if (kPeriod <= 0 || dPeriod <= 0 || slowing <= 0 || n === 0)
    return { main, signal };
  // MT5 guard: `if(rates_total<=InpKPeriod+InpDPeriod+InpSlowing) return(0);`
  if (n <= kPeriod + dPeriod + slowing) return { main, signal };

  const high = new Array<number>(n);
  const low = new Array<number>(n);
  const close = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    high[i] = bars[i]!.high;
    low[i] = bars[i]!.low;
    close[i] = bars[i]!.close;
  }

  // STO_CLOSECLOSE: extremes are taken over CLOSE instead of HIGH/LOW.
  const lowSrc = priceField === STO_PRICE.STO_CLOSECLOSE ? close : low;
  const highSrc = priceField === STO_PRICE.STO_CLOSECLOSE ? close : high;

  // Lowes/Highes over the K window (valid from i>=kPeriod-1).
  const lowes = new Array<number | null>(n).fill(null);
  const highes = new Array<number | null>(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let dmin = Infinity;
    let dmax = -Infinity;
    for (let k = i - kPeriod + 1; k <= i; k++) {
      if (lowSrc[k]! < dmin) dmin = lowSrc[k]!;
      if (highSrc[k]! > dmax) dmax = highSrc[k]!;
    }
    lowes[i] = dmin;
    highes[i] = dmax;
  }

  // %K with slowing, valid from i>=(kPeriod-1)+(slowing-1).
  const firstK = kPeriod - 1 + (slowing - 1);
  for (let i = firstK; i < n; i++) {
    let sumLow = 0.0;
    let sumHigh = 0.0;
    for (let k = i - slowing + 1; k <= i; k++) {
      sumLow += close[k]! - (lowes[k] as number);
      sumHigh += (highes[k] as number) - (lowes[k] as number);
    }
    main[i] = sumHigh === 0.0 ? 100.0 : (sumLow / sumHigh) * 100.0;
  }

  // %D = SMA(Dperiod) of %K. Replicate Stochastic.mq5 EXACTLY (§21): its %D loop
  // starts at index `Dperiod-1` and reads the %K buffer at i-k for k=0..D-1,
  // where warm-up cells hold the buffer's empty value 0.0 (the loop does NOT
  // skip them). So the %D buffer carries 0.0 for i < firstK, then real
  // "warm-up-contaminated" values at firstK..firstSignal-1, then clean values
  // from firstSignal on — and CopyBuffer returns all of them (PLOT_DRAW_BEGIN
  // only hides the early ones on the chart, not from CopyBuffer). Treat a null
  // %K as 0.0 in the sum to match.
  const firstSignal = dPeriod - 1;
  for (let i = firstSignal; i < n; i++) {
    let sum = 0.0;
    for (let k = 0; k < dPeriod; k++) {
      const v = main[i - k];
      sum += v === null ? 0.0 : v;
    }
    signal[i] = sum / dPeriod;
  }

  return { main, signal };
}
