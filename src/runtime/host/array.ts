/**
 * MQL5 Array* host helpers (the ones NOT already in ../arrays.ts) — pure,
 * MT5-exact semantics (global CLAUDE.md §21).
 *
 *   ArrayCopy(dst, src, dst_start, src_start, count)
 *   ArrayMaximum(array, start, count)  → INDEX of the maximum element
 *   ArrayMinimum(array, start, count)  → INDEX of the minimum element
 *   ArraySort(array)                   → ascending, in place
 *
 * AS-SERIES contract (load-bearing): `ArrayMaximum`/`ArrayMinimum` operate and
 * return positions in the ARRAY'S CURRENT INDEXING DIRECTION. MT5 tracks the
 * as-series flag per array object (mirrored by ../arrays.ts ArraySeriesRegistry).
 * These functions are pure, so the runtime passes the array's current flag in
 * (`asSeries` param) — it calls `this.seriesReg.isAsSeries(arr)` and forwards
 * the result, exactly as CopyBuffer reads the flag. With as-series TRUE, logical
 * index 0 is the LAST physical element; we scan logical positions and return a
 * logical index so `array[returned]` is the max/min in the program's view.
 *
 * `ArrayCopy` and `ArraySort` operate on the PHYSICAL storage (MT5's as-series
 * only affects indexing presentation, and these two are storage operations:
 * ArraySort sorts the underlying data ascending; ArrayCopy moves raw elements).
 */

/** WHOLE_ARRAY sentinel used by MT5 for "to the end" (count defaults). */
const WHOLE_ARRAY = -1;

/**
 * ArrayCopy(dst, src, dst_start=0, src_start=0, count=WHOLE_ARRAY) — copy
 * `count` elements from `src` (beginning at `src_start`) into `dst` (beginning
 * at `dst_start`). Returns the number of elements copied (MT5 returns the count,
 * 0 on error). `dst` is grown if needed (MT5 resizes a dynamic destination).
 *
 * MT5: count<0 or omitted (WHOLE_ARRAY) → copy to the end of `src`. src_start
 * past the end → 0 copied. Self-copy on the same array is supported by MT5; we
 * snapshot the source slice first so overlapping ranges are safe.
 */
export function ArrayCopy(
  dst: unknown[],
  src: readonly unknown[],
  dstStart: number = 0,
  srcStart: number = 0,
  count: number = WHOLE_ARRAY,
): number {
  if (!Array.isArray(dst) || !Array.isArray(src)) return 0;

  const ds = Math.max(0, Math.trunc(dstStart));
  const ss = Math.max(0, Math.trunc(srcStart));
  if (ss >= src.length) return 0;

  let cnt: number;
  if (count === undefined || count < 0) cnt = src.length - ss;
  else cnt = Math.trunc(count);
  cnt = Math.min(cnt, src.length - ss);
  if (cnt <= 0) return 0;

  // Snapshot the source slice (handles dst===src overlap safely).
  const slice = (src as unknown[]).slice(ss, ss + cnt);
  for (let i = 0; i < cnt; i++) {
    (dst as unknown[])[ds + i] = slice[i];
  }
  return cnt;
}

/**
 * ArrayMaximum(array, start=0, count=WHOLE_ARRAY[, asSeries]) — return the INDEX
 * (in the array's current indexing direction) of the largest element in the
 * window [start, start+count). MT5 returns -1 only on an empty/invalid request.
 *
 * The window's `start` and the returned index are LOGICAL positions: when
 * `asSeries` is true, logical i maps to physical `len-1-i`.
 */
export function ArrayMaximum(
  array: readonly number[],
  start: number = 0,
  count: number = WHOLE_ARRAY,
  asSeries: boolean = false,
): number {
  return extremumIndex(array, start, count, asSeries, true);
}

/**
 * ArrayMinimum(array, start=0, count=WHOLE_ARRAY[, asSeries]) — INDEX of the
 * smallest element in the window (see ArrayMaximum).
 */
export function ArrayMinimum(
  array: readonly number[],
  start: number = 0,
  count: number = WHOLE_ARRAY,
  asSeries: boolean = false,
): number {
  return extremumIndex(array, start, count, asSeries, false);
}

function extremumIndex(
  array: readonly number[],
  start: number,
  count: number,
  asSeries: boolean,
  wantMax: boolean,
): number {
  if (!Array.isArray(array) || array.length === 0) return -1;
  const len = array.length;

  const s = Math.max(0, Math.trunc(start));
  if (s >= len) return -1;

  let cnt: number;
  if (count === undefined || count < 0) cnt = len - s;
  else cnt = Math.trunc(count);
  cnt = Math.min(cnt, len - s);
  if (cnt <= 0) return -1;

  // Physical index for a logical position, honouring as-series direction.
  const phys = (logical: number): number => (asSeries ? len - 1 - logical : logical);

  let bestLogical = s;
  let bestVal = array[phys(s)] as number;
  for (let i = s + 1; i < s + cnt; i++) {
    const v = array[phys(i)] as number;
    // MT5 returns the FIRST extremum encountered when scanning in index order
    // (strict > / < keeps the earliest on ties), matching its reference impl.
    if (wantMax ? v > bestVal : v < bestVal) {
      bestVal = v;
      bestLogical = i;
    }
  }
  return bestLogical;
}

/**
 * ArraySort(array) — sort the array's PHYSICAL storage in ASCENDING order, in
 * place. MT5's ArraySort sorts ascending (and, for an as-series array, the
 * smallest value ends up at logical index len-1 because as-series reverses the
 * presentation — but the STORAGE is ascending either way, which is what callers
 * index against via the flag). Returns true (MT5 returns success bool).
 *
 * Numeric ascending compare (NOT JS default lexicographic) — load-bearing: JS
 * `[].sort()` would order [2,10,1] as [1,10,2]. We sort numerically.
 */
export function ArraySort(array: number[]): boolean {
  if (!Array.isArray(array)) return false;
  array.sort((a, b) => (a as number) - (b as number));
  return true;
}
