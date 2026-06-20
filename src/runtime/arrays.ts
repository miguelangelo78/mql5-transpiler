/**
 * MQL5 array builtins + the AS-SERIES registry.
 *
 * MT5 tracks the "as-series" flag PER ARRAY OBJECT (it's a property of the
 * array, not a value). We mirror that with a WeakSet keyed by array identity:
 * `ArraySetAsSeries(arr, true)` marks the exact array object; the flag travels
 * with the reference and is read back by `ArrayGetAsSeries(arr)` and by
 * CopyBuffer/Copy* when deciding dest ordering.
 *
 * Note: in MQL5, as-series only affects the INDEXING DIRECTION presented to the
 * program; the underlying storage order is unchanged. Our model keeps `dest`
 * stored in the order the Copy* call writes it (newest-first when as-series),
 * which is what the transpiled program then indexes with `[0]`,`[1]`,… — so
 * `fast[0]` is the newest value exactly as in MT5.
 */

export class ArraySeriesRegistry {
  private flags = new WeakSet<object>();

  /** ArraySetAsSeries — returns true (MT5 returns success). */
  setAsSeries(arr: unknown[], flag: boolean): boolean {
    if (arr === null || arr === undefined) return false;
    if (flag) this.flags.add(arr as object);
    else this.flags.delete(arr as object);
    return true;
  }

  /** ArrayGetAsSeries — current flag for this exact array object. */
  isAsSeries(arr: unknown[]): boolean {
    if (arr === null || arr === undefined) return false;
    return this.flags.has(arr as object);
  }
}

/**
 * ArrayResize — grow/shrink a dynamic array to `newSize`. New numeric slots are
 * filled with 0 (MT5 leaves them uninitialised, but 0 is the safe deterministic
 * choice for the PoC's numeric buffers). Returns the new size, or -1 on error.
 * `reserve` is accepted for signature parity (capacity hint) and ignored.
 */
export function arrayResize(
  arr: unknown[],
  newSize: number,
  _reserve?: number,
): number {
  if (!Array.isArray(arr) || newSize < 0 || !Number.isFinite(newSize)) {
    return -1;
  }
  const target = Math.trunc(newSize);
  if (target < arr.length) {
    arr.length = target;
  } else {
    for (let i = arr.length; i < target; i++) {
      (arr as unknown[])[i] = 0;
    }
  }
  return arr.length;
}

/** ArraySize — element count. */
export function arraySize(arr: unknown[]): number {
  return Array.isArray(arr) ? arr.length : 0;
}

/**
 * ArrayFill — set `count` elements starting at `start` to `value`.
 * (MT5 ArrayFill operates on numeric arrays.)
 */
export function arrayFill(
  arr: number[],
  start: number,
  count: number,
  value: number,
): void {
  if (!Array.isArray(arr)) return;
  const s = Math.max(0, Math.trunc(start));
  const c = Math.trunc(count);
  for (let i = 0; i < c; i++) arr[s + i] = value;
}

/**
 * ArrayInitialize — set EVERY element to `value`; returns the count set.
 * (MT5: initialises the whole array and returns the number of elements.)
 */
export function arrayInitialize(arr: number[], value: number): number {
  if (!Array.isArray(arr)) return 0;
  for (let i = 0; i < arr.length; i++) arr[i] = value;
  return arr.length;
}
