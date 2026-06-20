/**
 * iCustom — calling a SOURCE custom indicator (.mq5) and reading its buffers.
 *
 * MT5 model (identical to the native-indicator registry, ./registry.ts):
 *   handle = iCustom(symbol, timeframe, "Name", ...params)   → non-negative int
 *   CopyBuffer(handle, bufferNum, startPos, count, dest)      → reads buffer N
 *
 * What `iCustom` does that a native `iMA` does not: instead of computing a
 * known indicator formula, it RUNS the user's own custom indicator. The custom
 * indicator is itself an MQL5 program (`OnInit` + `OnCalculate`); we transpile
 * it with the SAME frontend+backend the EA uses, then execute its `OnCalculate`
 * over the feed's bars to fill its output buffers (see ../../icustom/compile.ts).
 *
 * This file owns the HANDLE REGISTRY + the CopyBuffer projection — the exact
 * as-series / warm-up semantics of ./registry.ts.copyBuffer, kept byte-for-byte
 * identical so a custom-indicator handle behaves indistinguishably from a native
 * one:
 *   - `startPos`/`count` index in MT5's AS-SERIES direction (0 = newest bar).
 *   - CopyBuffer copies only positions that HAVE a value, stopping at the first
 *     warm-up hole — so a window reaching into warm-up returns FEWER than `count`
 *     (this is what makes the SimpleMA sample match native iMA(MODE_SMA) exactly).
 *   - `dest` ordering honours the dest array's AS-SERIES flag.
 *
 * Warm-up modelling (§21 / §29): a custom indicator's buffer holds whatever its
 * OnCalculate wrote. We treat each chronological buffer slot as its LITERAL
 * value — a 0.0 is a real value (§29), NOT silently treated as "no value". The
 * ONLY value mapped to "no value" (null) is MT5's own no-value sentinel
 * EMPTY_VALUE (== DBL_MAX), which is exactly what a faithful MT5 indicator writes
 * into warm-up bars (via PLOT_EMPTY_VALUE). This keeps CopyBuffer's "return fewer
 * on warm-up" behaviour MT5-faithful without GUESSING that a 0 means warm-up.
 *
 * Fidelity boundary (honest scope — §21): this is SOURCE-custom-indicator
 * support. A `.ex5` (compiled, no source) cannot be transpiled and is out of
 * scope; the compiler reports that loudly rather than faking a handle.
 */

import type { IMarketFeed } from '../providers/types';
import type { ArraySeriesRegistry } from '../arrays';
import type { RuntimeContext } from '../../engine/types';
import {
  compileCustomIndicator,
  runCustomIndicator,
  type CompiledCustomIndicator,
  type CustomIndicatorParam,
} from '../../icustom/compile';

const INVALID_HANDLE = -1;

/** MT5 EMPTY_VALUE — the no-value sentinel an indicator buffer reports. */
const EMPTY_VALUE = Number.MAX_VALUE;

/**
 * Default base for custom-indicator handle numbers. The native IndicatorRegistry
 * (./registry.ts) mints handles from 0 upward; routing CopyBuffer / Release by
 * `owns(handle)` already disambiguates by map membership, but giving custom
 * handles a DISJOINT numeric range removes any ambiguity entirely (so e.g.
 * `IndicatorRelease(h)` is unambiguous even if both registries are consulted in
 * sequence). The integrator can pass `allocHandle = () => CUSTOM_HANDLE_BASE + n`
 * (a private monotonic `n`) for a collision-free, no-shared-counter wiring; or
 * share a single counter with the native registry — either is correct.
 */
const CUSTOM_HANDLE_BASE = 1_000_000;

/** A registered iCustom handle. */
interface CustomHandleSpec {
  symbol: string;
  timeframe: number;
  /** Indicator name (resolves to <indicatorsDir>/<name>.mq5). */
  name: string;
  /** The trailing iCustom parameters (become the indicator's `input`s, in order). */
  params: CustomIndicatorParam[];
}

/**
 * The chronological computed series for ONE buffer of a custom indicator.
 * Length === bars.length; `null` at positions the indicator reported no value
 * (EMPTY_VALUE). Mirrors ./types.ts IndicatorSeries.
 */
type CustomSeries = (number | null)[];

/**
 * Registry for iCustom handles. Standalone (does not extend the native
 * IndicatorRegistry) so it can be wired alongside it: the integrator routes
 * `rt.iCustom(...)` here, and `rt.CopyBuffer(handle, ...)` here when the handle
 * was minted by `iCustom` (see the handoff notes). Handle numbers are taken from
 * an injected allocator so they never collide with native-indicator handles.
 */
export class CustomIndicatorRegistry {
  private handles = new Map<number, CustomHandleSpec>();

  /**
   * Cache of compiled indicators keyed by resolved name. Compiling (transpile +
   * dynamic import) is the expensive step; the COMPUTE (running OnCalculate) is
   * redone per CopyBuffer because the feed's visible bars advance each step.
   */
  private compiled = new Map<string, CompiledCustomIndicator>();

  /**
   * @param feed         the market feed (source of the bars OnCalculate runs over).
   * @param series       the as-series registry (dest ordering for CopyBuffer).
   * @param ctx          the bound chart context (symbol/timeframe) the indicator runs in.
   * @param allocHandle  mints a fresh handle int (injected so it can share a
   *                     monotonic counter with the native registry → no collisions).
   * @param indicatorsDir directory custom indicators resolve against (default
   *                      handled by compile.ts: `examples/indicators`).
   */
  constructor(
    private readonly feed: IMarketFeed,
    private readonly series: ArraySeriesRegistry,
    private readonly ctx: RuntimeContext,
    private readonly allocHandle: () => number,
    private readonly indicatorsDir?: string,
  ) {}

  /**
   * iCustom(symbol, timeframe, name, ...params).
   *
   * Resolves + COMPILES the named indicator eagerly (so a missing source / a
   * `.ex5` / a compile error surfaces here, exactly as MT5 returns INVALID_HANDLE
   * when it cannot load the indicator — §21: we do not mint a handle we cannot
   * back). Returns >= 0 on success, INVALID_HANDLE (-1) on any failure.
   */
  iCustom(
    symbol: string,
    timeframe: number,
    name: string,
    ...params: CustomIndicatorParam[]
  ): number {
    if (typeof name !== 'string' || name.length === 0) return INVALID_HANDLE;
    try {
      this.ensureCompiled(name);
    } catch (e) {
      // MT5: a custom indicator that fails to load → INVALID_HANDLE (the EA's
      // `handle == INVALID_HANDLE` guard then fires). The compile error itself
      // is surfaced via `lastError()` for callers/tests that want the detail.
      this.lastErr = e instanceof Error ? e.message : String(e);
      return INVALID_HANDLE;
    }
    const handle = this.allocHandle();
    this.handles.set(handle, { symbol, timeframe, name, params });
    return handle;
  }

  /** True if `handle` was minted by THIS registry (an iCustom handle). */
  owns(handle: number): boolean {
    return this.handles.has(handle);
  }

  /** Free a handle. Returns true if it existed (mirrors IndicatorRelease). */
  release(handle: number): boolean {
    return this.handles.delete(handle);
  }

  /** Test helper: is this handle live? */
  has(handle: number): boolean {
    return this.handles.has(handle);
  }

  // ── error reporting (honest detail behind the INVALID_HANDLE) ──
  private lastErr = '';
  /** The reason the most recent failing iCustom() returned INVALID_HANDLE. */
  lastError(): string {
    return this.lastErr;
  }

  /**
   * CopyBuffer for a custom-indicator handle. Identical projection to
   * ./registry.ts.copyBuffer — see the file header. Returns the number actually
   * copied and resizes `dest` to that length.
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
    if (n === 0) {
      dest.length = 0;
      return 0;
    }

    // MT5 as-series position p maps to chronological index (n-1-p). Collect the
    // newest→older run of available (non-null) values, stopping at the first
    // warm-up hole (CopyBuffer cannot return a window with holes).
    const collectedNewestFirst: number[] = [];
    for (let p = startPos; p < startPos + count; p++) {
      const chrono = n - 1 - p;
      if (chrono < 0) break; // further back than data exists
      const v = series[chrono];
      if (v === null || v === undefined) break; // warm-up → stop
      collectedNewestFirst.push(v);
    }

    const copied = collectedNewestFirst.length;
    if (copied === 0) {
      dest.length = 0;
      return 0;
    }

    const asSeries = this.series.isAsSeries(dest);
    dest.length = copied;
    if (asSeries) {
      for (let i = 0; i < copied; i++) dest[i] = collectedNewestFirst[i]!;
    } else {
      for (let i = 0; i < copied; i++)
        dest[i] = collectedNewestFirst[copied - 1 - i]!;
    }
    return copied;
  }

  // ── internals ──

  /** Compile (transpile + import) the named indicator if not already cached. */
  private ensureCompiled(name: string): CompiledCustomIndicator {
    const existing = this.compiled.get(name);
    if (existing) return existing;
    const c = compileCustomIndicator(name, { indicatorsDir: this.indicatorsDir });
    this.compiled.set(name, c);
    return c;
  }

  /**
   * Run the custom indicator for `handle` over the feed's CURRENT bars and
   * return buffer `bufferNum` as a chronological series (null at EMPTY_VALUE
   * positions). Recomputed each call: the backtest advances the visible bars
   * between CopyBuffer calls, so a cached series would go stale.
   */
  private computeSeries(handle: number, bufferNum: number): CustomSeries {
    const spec = this.handles.get(handle);
    if (!spec) throw new Error(`CopyBuffer: invalid handle ${handle}`);
    const compiled = this.ensureCompiled(spec.name);

    const bars = this.feed.history(spec.symbol, spec.timeframe);
    const result = runCustomIndicator(compiled, {
      feed: this.feed,
      ctx: { symbol: spec.symbol, timeframe: spec.timeframe },
      params: spec.params,
      bars,
    });

    const buffers = result.buffers;
    if (bufferNum < 0 || bufferNum >= buffers.length) {
      throw new Error(
        `CopyBuffer: custom indicator '${spec.name}' exposes buffers ` +
          `0..${buffers.length - 1} (requested ${bufferNum})`,
      );
    }
    const raw = buffers[bufferNum]!;

    // Map the literal buffer to a series: EMPTY_VALUE → null (no value); every
    // other number (including 0 — §29) is a real value kept as-is. Non-finite
    // slots the indicator never wrote (undefined holes) are also no-value.
    const out: CustomSeries = new Array(raw.length).fill(null);
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      if (v === undefined || v === null) continue;
      if (!Number.isFinite(v)) continue; // NaN/±Inf are not plottable values
      if (v === EMPTY_VALUE) continue; // MT5's no-value sentinel
      out[i] = v;
    }
    return out;
  }
}

export { INVALID_HANDLE, EMPTY_VALUE, CUSTOM_HANDLE_BASE };
