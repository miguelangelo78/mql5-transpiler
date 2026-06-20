/**
 * Indicator runtime — handle registry + per-indicator computation.
 *
 * MT5 model: `iMA(...)` etc. register a *handle* (an opaque non-negative int).
 * `CopyBuffer(handle, buffer, startPos, count, dest)` then pulls the computed
 * series for that handle. The series is computed by OUR runtime from the feed's
 * candle history (providers never compute indicators — see providers/types.ts).
 *
 * Fidelity (global CLAUDE.md §21): the series math must equal MT5's EXACTLY.
 * Each indicator implements `compute(bars)` returning a CHRONOLOGICAL array
 * aligned 1:1 with `bars` (index i = bar i), where positions with no value
 * (warm-up) are `null`. CopyBuffer maps MT5's as-series positions onto this.
 *
 * iMA (all four ENUM_MA_METHOD smoothings), iRSI and iATR are implemented
 * MT5-EXACT against MetaQuotes' own reference sources (see sma.ts / ma.ts /
 * rsi.ts / atr.ts headers). Each registers a handle here; CopyBuffer pulls the
 * computed series. Anything not implemented THROWS rather than being faked —
 * an approximation dressed as MT5's real smoothing would silently diverge.
 */

import type { Bar } from '../providers/types';

/** MT5 ENUM_APPLIED_PRICE numeric ids (see constants.ts; known-correct). */
export const APPLIED = {
  PRICE_CLOSE: 1,
  PRICE_OPEN: 2,
  PRICE_HIGH: 3,
  PRICE_LOW: 4,
  PRICE_MEDIAN: 5,
  PRICE_TYPICAL: 6,
  PRICE_WEIGHTED: 7,
} as const;

/** MT5 ENUM_MA_METHOD numeric ids. */
export const MA_METHOD = {
  MODE_SMA: 0,
  MODE_EMA: 1,
  MODE_SMMA: 2,
  MODE_LWMA: 3,
} as const;

/**
 * Map a bar to its applied price exactly as MT5 does.
 * (MEDIAN = (H+L)/2, TYPICAL = (H+L+C)/3, WEIGHTED = (H+L+2C)/4.)
 */
export function appliedPrice(bar: Bar, applied: number): number {
  switch (applied) {
    case APPLIED.PRICE_CLOSE:
      return bar.close;
    case APPLIED.PRICE_OPEN:
      return bar.open;
    case APPLIED.PRICE_HIGH:
      return bar.high;
    case APPLIED.PRICE_LOW:
      return bar.low;
    case APPLIED.PRICE_MEDIAN:
      return (bar.high + bar.low) / 2.0;
    case APPLIED.PRICE_TYPICAL:
      return (bar.high + bar.low + bar.close) / 3.0;
    case APPLIED.PRICE_WEIGHTED:
      return (bar.high + bar.low + 2.0 * bar.close) / 4.0;
    default:
      throw new Error(`appliedPrice: unknown ENUM_APPLIED_PRICE id ${applied}`);
  }
}

/** A registered indicator handle spec. */
export interface IMAHandleSpec {
  kind: 'iMA';
  symbol: string;
  timeframe: number;
  period: number;
  /**
   * MT5 ma_shift — horizontal shift of the MA line forward in time by N bars.
   * (NOT the CopyBuffer startPos.) value[i] uses the SMA computed at bar i-shift.
   */
  shift: number;
  method: number;
  appliedPrice: number;
}

/** A registered iRSI handle spec. */
export interface IRSIHandleSpec {
  kind: 'iRSI';
  symbol: string;
  timeframe: number;
  period: number;
  appliedPrice: number;
}

/** A registered iATR handle spec. (ATR ignores applied price — reads OHLC.) */
export interface IATRHandleSpec {
  kind: 'iATR';
  symbol: string;
  timeframe: number;
  period: number;
}

/** A registered iBands handle spec. Buffers: 0=BASE,1=UPPER,2=LOWER. */
export interface IBandsHandleSpec {
  kind: 'iBands';
  symbol: string;
  timeframe: number;
  period: number;
  /** MT5 ma_shift — horizontal forward shift of all three band buffers. */
  shift: number;
  deviation: number;
  appliedPrice: number;
}

/** A registered iMACD handle spec. Buffers: 0=MAIN,1=SIGNAL. */
export interface IMACDHandleSpec {
  kind: 'iMACD';
  symbol: string;
  timeframe: number;
  fastEMA: number;
  slowEMA: number;
  signalSMA: number;
  appliedPrice: number;
}

/** A registered iStochastic handle spec. Buffers: 0=MAIN(%K),1=SIGNAL(%D). */
export interface IStochasticHandleSpec {
  kind: 'iStochastic';
  symbol: string;
  timeframe: number;
  kPeriod: number;
  dPeriod: number;
  slowing: number;
  /** ENUM_MA_METHOD — accepted but the MT5 indicator always uses SMA for %D. */
  maMethod: number;
  /** ENUM_STO_PRICE — STO_LOWHIGH(0) | STO_CLOSECLOSE(1). */
  priceField: number;
}

/** A registered iADX handle spec. Buffers: 0=MAIN(ADX),1=PLUSDI,2=MINUSDI. */
export interface IADXHandleSpec {
  kind: 'iADX';
  symbol: string;
  timeframe: number;
  period: number;
}

/** A registered iCCI handle spec. Single buffer (0=MAIN). */
export interface ICCIHandleSpec {
  kind: 'iCCI';
  symbol: string;
  timeframe: number;
  period: number;
  appliedPrice: number;
}

/** A registered iMomentum handle spec. Single buffer (0=MAIN). */
export interface IMomentumHandleSpec {
  kind: 'iMomentum';
  symbol: string;
  timeframe: number;
  period: number;
  appliedPrice: number;
}

export type HandleSpec =
  | IMAHandleSpec
  | IRSIHandleSpec
  | IATRHandleSpec
  | IBandsHandleSpec
  | IMACDHandleSpec
  | IStochasticHandleSpec
  | IADXHandleSpec
  | ICCIHandleSpec
  | IMomentumHandleSpec;

/**
 * The chronological computed series for an indicator's buffer.
 * Length === bars.length; `null` at warm-up positions (MT5 has no value there).
 */
export type IndicatorSeries = (number | null)[];
