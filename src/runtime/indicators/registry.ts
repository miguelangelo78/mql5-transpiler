/**
 * Indicator handle registry — implements iMA / CopyBuffer / IndicatorRelease.
 *
 * MT5 semantics replicated:
 *  - iMA(...) returns a non-negative int handle (INVALID_HANDLE === -1 on bad
 *    args). The handle is stable for the lifetime of the EA until released.
 *  - CopyBuffer(handle, buffer, startPos, count, dest):
 *      * `startPos`/`count` index in MT5's AS-SERIES timeseries direction:
 *        position 0 = the CURRENT (newest) bar, increasing back in time.
 *      * It copies values from the indicator buffer. Warm-up positions have no
 *        value; CopyBuffer only returns positions that HAVE a value, so when
 *        the requested window reaches into warm-up it returns fewer than
 *        `count` (that's exactly why the sample EA tests `< 3`).
 *      * `dest` ordering honours the dest array's AS-SERIES flag:
 *          - as-series  → dest[0] = newest (same order as the MT5 positions);
 *          - non-series → dest[0] = oldest of the copied window, dest[last] =
 *            newest. (MT5 reverses into a plain array.)
 *      * Returns the number of elements actually copied.
 *
 * The registry needs the feed (to get candle history) and the as-series
 * registry (to know dest ordering). Both are injected.
 */

import type { IMarketFeed, Bar } from '../providers/types';
import type { ArraySeriesRegistry } from '../arrays';
import { computeSMA } from './sma';
import { computeEMA, computeSMMA, computeLWMA } from './ma';
import { computeRSI } from './rsi';
import { computeATR } from './atr';
import { computeBands } from './bands';
import { computeMACD } from './macd';
import { computeStochastic } from './stochastic';
import { computeADX } from './adx';
import { computeCCI } from './cci';
import { computeMomentum } from './momentum';
import { MA_METHOD, type HandleSpec, type IndicatorSeries } from './types';

const INVALID_HANDLE = -1;

export class IndicatorRegistry {
  private handles = new Map<number, HandleSpec>();
  private nextHandle = 0;

  constructor(
    private readonly feed: IMarketFeed,
    private readonly series: ArraySeriesRegistry,
  ) {}

  /** Register an iMA handle. Returns >=0, or INVALID_HANDLE on bad args. */
  iMA(
    symbol: string,
    timeframe: number,
    period: number,
    shift: number,
    method: number,
    appliedPrice: number,
  ): number {
    // MT5 returns INVALID_HANDLE for non-positive period.
    if (!Number.isFinite(period) || period <= 0) return INVALID_HANDLE;
    if (!Number.isFinite(shift) || shift < 0) return INVALID_HANDLE;
    // method / appliedPrice are validated lazily at compute time (we only
    // implement SMA for the PoC; other methods throw clearly when copied).
    const handle = this.nextHandle++;
    this.handles.set(handle, {
      kind: 'iMA',
      symbol,
      timeframe,
      period,
      shift,
      method,
      appliedPrice,
    });
    return handle;
  }

  /** Register an iRSI handle. Returns >=0, or INVALID_HANDLE on bad args. */
  iRSI(
    symbol: string,
    timeframe: number,
    period: number,
    appliedPrice: number,
  ): number {
    // MT5 substitutes 14 for period<1 (see RSI.mq5 OnInit), but iRSI() itself
    // returns a handle for any positive period; we register as given and let
    // computeRSI honour period<1 == no value. To match iMA's contract we treat
    // a non-finite/<1 period as a bad handle.
    if (!Number.isFinite(period) || period < 1) return INVALID_HANDLE;
    const handle = this.nextHandle++;
    this.handles.set(handle, {
      kind: 'iRSI',
      symbol,
      timeframe,
      period,
      appliedPrice,
    });
    return handle;
  }

  /** Register an iATR handle. Returns >=0, or INVALID_HANDLE on bad args. */
  iATR(symbol: string, timeframe: number, period: number): number {
    if (!Number.isFinite(period) || period <= 0) return INVALID_HANDLE;
    const handle = this.nextHandle++;
    this.handles.set(handle, { kind: 'iATR', symbol, timeframe, period });
    return handle;
  }

  /**
   * Register an iBands handle. Buffers: 0=BASE(middle),1=UPPER,2=LOWER.
   * MQL5: iBands(symbol,timeframe,bandsPeriod,bandsShift,deviation,appliedPrice).
   */
  iBands(
    symbol: string,
    timeframe: number,
    period: number,
    shift: number,
    deviation: number,
    appliedPrice: number,
  ): number {
    if (!Number.isFinite(period) || period <= 0) return INVALID_HANDLE;
    if (!Number.isFinite(shift) || shift < 0) return INVALID_HANDLE;
    const handle = this.nextHandle++;
    this.handles.set(handle, {
      kind: 'iBands',
      symbol,
      timeframe,
      period,
      shift,
      deviation,
      appliedPrice,
    });
    return handle;
  }

  /**
   * Register an iMACD handle. Buffers: 0=MAIN,1=SIGNAL.
   * MQL5: iMACD(symbol,timeframe,fastEmaPeriod,slowEmaPeriod,signalPeriod,price).
   */
  iMACD(
    symbol: string,
    timeframe: number,
    fastEMA: number,
    slowEMA: number,
    signalSMA: number,
    appliedPrice: number,
  ): number {
    if (!Number.isFinite(fastEMA) || fastEMA <= 0) return INVALID_HANDLE;
    if (!Number.isFinite(slowEMA) || slowEMA <= 0) return INVALID_HANDLE;
    if (!Number.isFinite(signalSMA) || signalSMA <= 0) return INVALID_HANDLE;
    const handle = this.nextHandle++;
    this.handles.set(handle, {
      kind: 'iMACD',
      symbol,
      timeframe,
      fastEMA,
      slowEMA,
      signalSMA,
      appliedPrice,
    });
    return handle;
  }

  /**
   * Register an iStochastic handle. Buffers: 0=MAIN(%K),1=SIGNAL(%D).
   * MQL5: iStochastic(symbol,timeframe,Kperiod,Dperiod,slowing,maMethod,priceField).
   */
  iStochastic(
    symbol: string,
    timeframe: number,
    kPeriod: number,
    dPeriod: number,
    slowing: number,
    maMethod: number,
    priceField: number,
  ): number {
    if (!Number.isFinite(kPeriod) || kPeriod <= 0) return INVALID_HANDLE;
    if (!Number.isFinite(dPeriod) || dPeriod <= 0) return INVALID_HANDLE;
    if (!Number.isFinite(slowing) || slowing <= 0) return INVALID_HANDLE;
    const handle = this.nextHandle++;
    this.handles.set(handle, {
      kind: 'iStochastic',
      symbol,
      timeframe,
      kPeriod,
      dPeriod,
      slowing,
      maMethod,
      priceField,
    });
    return handle;
  }

  /**
   * Register an iADX handle. Buffers: 0=MAIN(ADX),1=PLUSDI,2=MINUSDI.
   * MQL5: iADX(symbol,timeframe,adxPeriod).
   */
  iADX(symbol: string, timeframe: number, period: number): number {
    if (!Number.isFinite(period) || period <= 0) return INVALID_HANDLE;
    const handle = this.nextHandle++;
    this.handles.set(handle, { kind: 'iADX', symbol, timeframe, period });
    return handle;
  }

  /**
   * Register an iCCI handle. Single buffer (0=MAIN).
   * MQL5: iCCI(symbol,timeframe,cciPeriod,appliedPrice).
   */
  iCCI(
    symbol: string,
    timeframe: number,
    period: number,
    appliedPrice: number,
  ): number {
    if (!Number.isFinite(period) || period <= 0) return INVALID_HANDLE;
    const handle = this.nextHandle++;
    this.handles.set(handle, {
      kind: 'iCCI',
      symbol,
      timeframe,
      period,
      appliedPrice,
    });
    return handle;
  }

  /**
   * Register an iMomentum handle. Single buffer (0=MAIN).
   * MQL5: iMomentum(symbol,timeframe,momPeriod,appliedPrice).
   */
  iMomentum(
    symbol: string,
    timeframe: number,
    period: number,
    appliedPrice: number,
  ): number {
    if (!Number.isFinite(period) || period <= 0) return INVALID_HANDLE;
    const handle = this.nextHandle++;
    this.handles.set(handle, {
      kind: 'iMomentum',
      symbol,
      timeframe,
      period,
      appliedPrice,
    });
    return handle;
  }

  /** Free a handle. Returns true if it existed. */
  release(handle: number): boolean {
    return this.handles.delete(handle);
  }

  /**
   * Compute the buffer's chronological series for a handle.
   * `bufferNum` selects the output buffer. Single-buffer indicators (iMA/iRSI/
   * iATR/iCCI/iMomentum) expose only buffer 0. Multi-buffer indicators expose
   * their plotted buffers in MT5's SetIndexBuffer order:
   *   iBands  → 0=BASE(middle), 1=UPPER, 2=LOWER
   *   iMACD   → 0=MAIN, 1=SIGNAL
   *   iStoch  → 0=MAIN(%K), 1=SIGNAL(%D)
   *   iADX    → 0=MAIN(ADX), 1=PLUSDI(+DI), 2=MINUSDI(-DI)
   * (INDICATOR_CALCULATIONS buffers are NOT CopyBuffer-readable — MT5 hides them.)
   */
  private computeSeries(handle: number, bufferNum: number): IndicatorSeries {
    const spec = this.handles.get(handle);
    if (!spec) throw new Error(`CopyBuffer: invalid handle ${handle}`);
    const bars = this.feed.history(spec.symbol, spec.timeframe);

    // Single-buffer indicators: only buffer 0 is readable.
    const onlyBuffer0 = (): void => {
      if (bufferNum !== 0) {
        throw new Error(
          `CopyBuffer: this indicator exposes only buffer 0 (requested ${bufferNum})`,
        );
      }
    };

    switch (spec.kind) {
      case 'iMA':
        onlyBuffer0();
        switch (spec.method) {
          case MA_METHOD.MODE_SMA:
            return computeSMA(bars, spec.period, spec.appliedPrice, spec.shift);
          case MA_METHOD.MODE_EMA:
            return computeEMA(bars, spec.period, spec.appliedPrice, spec.shift);
          case MA_METHOD.MODE_SMMA:
            return computeSMMA(bars, spec.period, spec.appliedPrice, spec.shift);
          case MA_METHOD.MODE_LWMA:
            return computeLWMA(bars, spec.period, spec.appliedPrice, spec.shift);
          default:
            // Rule 21: don't fake an unknown smoothing — surface it loudly.
            throw new Error(
              `iMA: unknown ENUM_MA_METHOD id ${spec.method}; not faking it.`,
            );
        }
      case 'iRSI':
        onlyBuffer0();
        return computeRSI(bars, spec.period, spec.appliedPrice);
      case 'iATR':
        onlyBuffer0();
        return computeATR(bars, spec.period);
      case 'iCCI':
        onlyBuffer0();
        return computeCCI(bars, spec.period, spec.appliedPrice);
      case 'iMomentum':
        onlyBuffer0();
        return computeMomentum(bars, spec.period, spec.appliedPrice);
      case 'iBands': {
        const b = computeBands(
          bars,
          spec.period,
          spec.deviation,
          spec.appliedPrice,
          spec.shift,
        );
        switch (bufferNum) {
          case 0:
            return b.base;
          case 1:
            return b.upper;
          case 2:
            return b.lower;
          default:
            throw new Error(
              `CopyBuffer: iBands exposes buffers 0..2 (requested ${bufferNum})`,
            );
        }
      }
      case 'iMACD': {
        const m = computeMACD(
          bars,
          spec.fastEMA,
          spec.slowEMA,
          spec.signalSMA,
          spec.appliedPrice,
        );
        switch (bufferNum) {
          case 0:
            return m.main;
          case 1:
            return m.signal;
          default:
            throw new Error(
              `CopyBuffer: iMACD exposes buffers 0..1 (requested ${bufferNum})`,
            );
        }
      }
      case 'iStochastic': {
        const s = computeStochastic(
          bars,
          spec.kPeriod,
          spec.dPeriod,
          spec.slowing,
          spec.priceField,
        );
        switch (bufferNum) {
          case 0:
            return s.main;
          case 1:
            return s.signal;
          default:
            throw new Error(
              `CopyBuffer: iStochastic exposes buffers 0..1 (requested ${bufferNum})`,
            );
        }
      }
      case 'iADX': {
        const a = computeADX(bars, spec.period);
        switch (bufferNum) {
          case 0:
            return a.main;
          case 1:
            return a.plusDI;
          case 2:
            return a.minusDI;
          default:
            throw new Error(
              `CopyBuffer: iADX exposes buffers 0..2 (requested ${bufferNum})`,
            );
        }
      }
      default:
        throw new Error(`CopyBuffer: unsupported indicator kind`);
    }
  }

  /**
   * CopyBuffer — see file header. Returns count actually copied; writes into
   * `dest`, sizing it to the copied length (MT5 resizes dynamic arrays).
   */
  copyBuffer(
    handle: number,
    bufferNum: number,
    startPos: number,
    count: number,
    dest: number[],
  ): number {
    if (count <= 0 || startPos < 0) return 0;
    const series = this.computeSeries(handle, bufferNum); // chronological
    const n = series.length;
    if (n === 0) return 0;

    // MT5 as-series position p maps to chronological index (n-1-p).
    // Requested positions: startPos .. startPos+count-1 (newest→older).
    // Collect the values that EXIST (non-null), in newest→older order, but
    // stop at the first position that has no value (warm-up) — MT5 cannot
    // return a partial-with-holes window; it returns the contiguous run of
    // available newest values that satisfies the request, else fewer.
    const collectedNewestFirst: number[] = [];
    for (let p = startPos; p < startPos + count; p++) {
      const chrono = n - 1 - p;
      if (chrono < 0) break; // requested further back than data exists
      const v = series[chrono];
      if (v === null || v === undefined) break; // hit warm-up → stop
      collectedNewestFirst.push(v);
    }

    const copied = collectedNewestFirst.length;
    if (copied === 0) {
      dest.length = 0;
      return 0;
    }

    // Honour dest as-series ordering.
    const asSeries = this.series.isAsSeries(dest);
    dest.length = copied;
    if (asSeries) {
      // dest[0] = newest (same as collected order)
      for (let i = 0; i < copied; i++) dest[i] = collectedNewestFirst[i]!;
    } else {
      // dest[0] = oldest of the window, dest[last] = newest
      for (let i = 0; i < copied; i++)
        dest[i] = collectedNewestFirst[copied - 1 - i]!;
    }
    return copied;
  }

  /** Test helper: is this handle live? */
  has(handle: number): boolean {
    return this.handles.has(handle);
  }
}

export { INVALID_HANDLE };
export type { Bar };
