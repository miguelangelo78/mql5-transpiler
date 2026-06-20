/**
 * Average Directional Movement Index — MT5-EXACT (global CLAUDE.md §21).
 *
 * Ground truth: MetaTrader 5's own `MQL5/Indicators/Examples/ADX.mq5`
 * (`Copyright 2000-2026, MetaQuotes Ltd.`) — the indicator iADX actually runs.
 *
 * SetIndexBuffer ORDER (ADX.mq5 OnInit, load-bearing buffer numbering):
 *   buffer 0 = ExtADXBuffer (MAIN  = ADX)
 *   buffer 1 = ExtPDIBuffer (+DI)
 *   buffer 2 = ExtNDIBuffer (-DI)
 *   buffer 3 = ExtPDBuffer  (INDICATOR_CALCULATIONS — raw +DM/TR)
 *   buffer 4 = ExtNDBuffer  (INDICATOR_CALCULATIONS — raw -DM/TR)
 *   buffer 5 = ExtTmpBuffer (INDICATOR_CALCULATIONS — DX)
 *
 * ⚠️ LOAD-BEARING §21: MT5's ADX smooths +DI / -DI / ADX with `ExponentialMA`
 * (k = 2/(period+1)), NOT Wilder's SMMA (k = 1/period). The example calls
 * `ExponentialMA(i,period,prev,price)` = price[i]*k + prev*(1-k). The seed is
 * the EXPLICIT 0.0 at index 0 (OnCalculate sets ExtPDIBuffer[0]=ExtNDIBuffer[0]=
 * ExtADXBuffer[0]=0.0), and the recurrence runs from index 1. There is NO
 * SMA-of-first-period seed; the EMA grows from 0. (A textbook Wilder ADX differs.)
 *
 * Per-bar directional movement (ADX.mq5, i>=1):
 *   tmp_pos = high[i]-high[i-1];  if <0 → 0
 *   tmp_neg = low[i-1]-low[i];    if <0 → 0
 *   if tmp_pos > tmp_neg:  tmp_neg = 0
 *   elif tmp_pos < tmp_neg: tmp_pos = 0
 *   else (equal):          tmp_pos = tmp_neg = 0
 *   tr = max(|high-low|, |high-prevClose|, |low-prevClose|)
 *   PD[i] = tr!=0 ? 100*tmp_pos/tr : 0
 *   ND[i] = tr!=0 ? 100*tmp_neg/tr : 0
 *   PDI[i] = ExponentialMA(i,period,PDI[i-1],PD)   // EMA of PD
 *   NDI[i] = ExponentialMA(i,period,NDI[i-1],ND)   // EMA of ND
 *   DX     = (PDI+NDI)!=0 ? 100*|PDI-NDI|/(PDI+NDI) : 0
 *   ADX[i] = ExponentialMA(i,period,ADX[i-1],Tmp)  // EMA of DX
 *
 * Buffer contents: index 0 = 0.0 for all three plotted buffers (explicit), then
 * a value at every bar from index 1. We surface the raw buffer (matching what
 * CopyBuffer returns) — no nulls; the plot's PLOT_DRAW_BEGIN (period / 2*period)
 * is a cosmetic and does not blank the buffer cells.
 *
 * iADX uses period only (no applied price — reads OHLC).
 */

import type { Bar } from '../providers/types';
import type { IndicatorSeries } from './types';

export interface AdxBuffers {
  main: IndicatorSeries; // buffer 0 — ADX
  plusDI: IndicatorSeries; // buffer 1 — +DI
  minusDI: IndicatorSeries; // buffer 2 — -DI
}

export function computeADX(
  bars: readonly Bar[],
  period: number,
): AdxBuffers {
  const n = bars.length;
  const main: IndicatorSeries = new Array(n).fill(null);
  const plusDI: IndicatorSeries = new Array(n).fill(null);
  const minusDI: IndicatorSeries = new Array(n).fill(null);
  // MT5 guard: `if(rates_total<ExtADXPeriod) return(0);`
  if (period <= 0 || n === 0 || n < period) return { main, plusDI, minusDI };

  const k = 2.0 / (period + 1.0); // ExponentialMA smoothing factor.

  // Explicit zero seeds at index 0 (ADX.mq5 first-calc branch).
  let pdiPrev = 0.0;
  let ndiPrev = 0.0;
  let adxPrev = 0.0;
  main[0] = 0.0;
  plusDI[0] = 0.0;
  minusDI[0] = 0.0;

  for (let i = 1; i < n; i++) {
    const highP = bars[i]!.high;
    const prevHigh = bars[i - 1]!.high;
    const lowP = bars[i]!.low;
    const prevLow = bars[i - 1]!.low;
    const prevClose = bars[i - 1]!.close;

    let tmpPos = highP - prevHigh;
    let tmpNeg = prevLow - lowP;
    if (tmpPos < 0.0) tmpPos = 0.0;
    if (tmpNeg < 0.0) tmpNeg = 0.0;
    if (tmpPos > tmpNeg) {
      tmpNeg = 0.0;
    } else if (tmpPos < tmpNeg) {
      tmpPos = 0.0;
    } else {
      tmpPos = 0.0;
      tmpNeg = 0.0;
    }

    const tr = Math.max(
      Math.max(Math.abs(highP - lowP), Math.abs(highP - prevClose)),
      Math.abs(lowP - prevClose),
    );
    let pd: number;
    let nd: number;
    if (tr !== 0.0) {
      pd = (100.0 * tmpPos) / tr;
      nd = (100.0 * tmpNeg) / tr;
    } else {
      pd = 0.0;
      nd = 0.0;
    }

    // EMA-smooth +DI / -DI (ExponentialMA, prev seeded at 0).
    const pdi = pd * k + pdiPrev * (1.0 - k);
    const ndi = nd * k + ndiPrev * (1.0 - k);
    pdiPrev = pdi;
    ndiPrev = ndi;

    let dx: number;
    const denom = pdi + ndi;
    if (denom !== 0.0) {
      dx = 100.0 * Math.abs((pdi - ndi) / denom);
    } else {
      dx = 0.0;
    }

    const adx = dx * k + adxPrev * (1.0 - k);
    adxPrev = adx;

    plusDI[i] = pdi;
    minusDI[i] = ndi;
    main[i] = adx;
  }

  return { main, plusDI, minusDI };
}
