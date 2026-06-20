/**
 * Timeseries accessors — iBars / iHighest / iLowest / iVolume — MT5-EXACT
 * (global CLAUDE.md §21).
 *
 * These are NOT handle-based indicators; they read the feed's candle history
 * directly and return a scalar, mirroring MQL5's timeseries functions.
 *
 * AS-SERIES indexing (load-bearing): MQL5 timeseries are AS-SERIES — position 0
 * is the CURRENT (newest) bar, increasing back in time. The feed stores bars
 * CHRONOLOGICALLY (oldest→newest), so as-series position p maps to chronological
 * index (n-1-p).
 *
 * ── iBars(symbol, timeframe) → int ──
 *   Number of bars available for (symbol, timeframe). MQL5: `int iBars(symbol,tf)`.
 *   (Same value as Bars(symbol,timeframe).)
 *
 * ── iVolume(symbol, timeframe, shift) → long ──
 *   TICK volume of the bar at as-series `shift`. MQL5 returns tick volume (the
 *   `Volume[]` timeseries / COPY of CopyTickVolume). shift 0 = current bar.
 *   Out-of-range shift → 0 (MQL5 returns 0 when the bar does not exist).
 *
 * ── iHighest(symbol, timeframe, type, count, start) → int ──
 * ── iLowest (symbol, timeframe, type, count, start) → int ──
 *   Returns the AS-SERIES INDEX of the highest/lowest value of the `type` series
 *   over `count` bars beginning at as-series position `start` (0 = current).
 *   `type` is ENUM_SERIESMODE:
 *     MODE_OPEN=0, MODE_LOW=1, MODE_HIGH=2, MODE_CLOSE=3,
 *     MODE_VOLUME=4 (tick volume), MODE_REAL_VOLUME=5.
 *   `count` of WHOLE_ARRAY (0) means "all bars from `start` to the oldest".
 *   On the FIRST equal extreme MQL5 keeps the FIRST occurrence scanned from
 *   `start` toward older bars (i.e. the smallest as-series index that holds the
 *   extreme). Returns -1 on bad args / empty history.
 *
 *   ⚠️ §21 NOTE on the extreme series for HIGH/LOW: MQL5's iHighest with
 *   MODE_HIGH scans the HIGH series; MODE_LOW scans the LOW series; iLowest
 *   likewise. The function name picks max-vs-min; the `type` picks WHICH series.
 *   (So iHighest(...,MODE_LOW,...) returns the index of the highest LOW.)
 */

import type { Bar } from '../providers/types';

/** MQL5 ENUM_SERIESMODE numeric ids (canonical MQL5 values). */
export const SERIES_MODE = {
  MODE_OPEN: 0,
  MODE_LOW: 1,
  MODE_HIGH: 2,
  MODE_CLOSE: 3,
  MODE_VOLUME: 4, // tick volume
  MODE_REAL_VOLUME: 5,
} as const;

/** MQL5 WHOLE_ARRAY sentinel for `count`. */
export const WHOLE_ARRAY = 0;

/** iBars — bar count for (symbol, timeframe). */
export function iBars(bars: readonly Bar[]): number {
  return bars.length;
}

/** iVolume — tick volume at as-series `shift`; 0 when out of range. */
export function iVolume(bars: readonly Bar[], shift: number): number {
  const n = bars.length;
  if (!Number.isFinite(shift) || shift < 0 || shift >= n) return 0;
  const chrono = n - 1 - shift;
  return bars[chrono]!.tickVolume;
}

/** Pick the `type` series value of a bar (ENUM_SERIESMODE). */
function seriesValue(bar: Bar, type: number): number {
  switch (type) {
    case SERIES_MODE.MODE_OPEN:
      return bar.open;
    case SERIES_MODE.MODE_LOW:
      return bar.low;
    case SERIES_MODE.MODE_HIGH:
      return bar.high;
    case SERIES_MODE.MODE_CLOSE:
      return bar.close;
    case SERIES_MODE.MODE_VOLUME:
      return bar.tickVolume;
    case SERIES_MODE.MODE_REAL_VOLUME:
      return bar.realVolume;
    default:
      // §21: don't fake an unknown ENUM_SERIESMODE — surface it.
      throw new Error(`iHighest/iLowest: unknown ENUM_SERIESMODE id ${type}`);
  }
}

/**
 * Resolve the as-series window [start .. start+count-1], clamped to available
 * bars. Returns the inclusive as-series bounds, or null if the window is empty
 * / args are invalid. count===WHOLE_ARRAY (0) means "to the oldest bar".
 */
function window(
  n: number,
  count: number,
  start: number,
): { lo: number; hi: number } | null {
  if (n === 0) return null;
  if (!Number.isFinite(start) || start < 0) return null;
  if (start >= n) return null;
  // count<=0 (WHOLE_ARRAY) → scan from start to the oldest available bar.
  let last: number;
  if (count <= 0) {
    last = n - 1;
  } else {
    last = start + count - 1;
    if (last > n - 1) last = n - 1;
  }
  return { lo: start, hi: last };
}

/**
 * iHighest — as-series index of the MAX of the `type` series over the window.
 * On ties, returns the FIRST (smallest as-series index, scanning newest→older).
 */
export function iHighest(
  bars: readonly Bar[],
  type: number,
  count: number,
  start: number,
): number {
  const n = bars.length;
  const w = window(n, count, start);
  if (!w) return -1;
  let bestPos = -1;
  let bestVal = -Infinity;
  for (let p = w.lo; p <= w.hi; p++) {
    const chrono = n - 1 - p;
    const v = seriesValue(bars[chrono]!, type);
    // strict > keeps the first (smallest as-series index) on ties.
    if (v > bestVal) {
      bestVal = v;
      bestPos = p;
    }
  }
  return bestPos;
}

/**
 * iLowest — as-series index of the MIN of the `type` series over the window.
 * On ties, returns the FIRST (smallest as-series index, scanning newest→older).
 */
export function iLowest(
  bars: readonly Bar[],
  type: number,
  count: number,
  start: number,
): number {
  const n = bars.length;
  const w = window(n, count, start);
  if (!w) return -1;
  let bestPos = -1;
  let bestVal = Infinity;
  for (let p = w.lo; p <= w.hi; p++) {
    const chrono = n - 1 - p;
    const v = seriesValue(bars[chrono]!, type);
    if (v < bestVal) {
      bestVal = v;
      bestPos = p;
    }
  }
  return bestPos;
}
