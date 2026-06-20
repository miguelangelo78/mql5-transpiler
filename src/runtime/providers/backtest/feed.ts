/**
 * BacktestFeed — the sim market feed.
 *
 * Holds the full dataset plus a `visibleCount`. Only the first `visibleCount`
 * bars are visible; the last visible bar IS the current bar. This is the
 * single source of progressive market visibility — the runtime computes
 * indicators from `history()` and the broker marks positions to the current
 * tick.
 *
 * The dataset is single-symbol/single-timeframe (the bound chart context).
 * `history()` ignores its arguments beyond a sanity check and returns the
 * visible slice; this mirrors how a backtest is scoped to one (symbol,
 * timeframe) pair.
 */

import type { Bar, IMarketFeed, SymbolSpec, Tick } from '../types';

export class BacktestFeed implements IMarketFeed {
  readonly symbol: string;
  readonly timeframe: number;
  private readonly dataset: readonly Bar[];
  private readonly spec: SymbolSpec;
  /** Spread in points applied to ask (ask = close + spreadPoints * point). */
  private readonly spreadPoints: number;
  /** Number of bars currently visible (1..dataset.length). 0 ⇒ nothing yet. */
  private visibleCount = 0;

  constructor(args: {
    symbol: string;
    timeframe: number;
    dataset: readonly Bar[];
    spec: SymbolSpec;
    spreadPoints: number;
  }) {
    this.symbol = args.symbol;
    this.timeframe = args.timeframe;
    this.dataset = args.dataset;
    this.spec = args.spec;
    this.spreadPoints = args.spreadPoints;
  }

  /** Total bars in the dataset. */
  total(): number {
    return this.dataset.length;
  }

  /** How many bars are currently visible. */
  visible(): number {
    return this.visibleCount;
  }

  /** Set the visible-bar count (driven by the simulation). Clamped to dataset. */
  setVisible(count: number): void {
    if (count < 0) count = 0;
    if (count > this.dataset.length) count = this.dataset.length;
    this.visibleCount = count;
  }

  /** The current newest visible bar, or null if none visible yet. */
  currentBar(): Bar | null {
    if (this.visibleCount <= 0) return null;
    return this.dataset[this.visibleCount - 1];
  }

  // ── IMarketFeed ──────────────────────────────────────────────────────────

  history(_symbol: string, _timeframe: number): readonly Bar[] {
    // Chronological: oldest first, current/newest last.
    return this.dataset.slice(0, this.visibleCount);
  }

  tick(_symbol: string): Tick {
    const bar = this.currentBar();
    if (bar === null) {
      // No bar visible yet — produce a degenerate but well-formed tick at 0.
      // (The simulation steps before OnTick, so this is rarely observed.)
      return { time: 0, bid: 0, ask: 0, last: 0, volume: 0 };
    }
    const bid = bar.close;
    const ask = bar.close + this.spreadPoints * this.spec.point;
    return {
      time: bar.time,
      bid,
      ask,
      last: bar.close,
      volume: bar.tickVolume,
    };
  }

  symbolInfo(_symbol: string): SymbolSpec {
    return this.spec;
  }
}
