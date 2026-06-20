/**
 * TickerallFeed — IMarketFeed over the TickerAll candle + tick stream.
 *
 * KEY DESIGN (sync-over-async): our IMarketFeed is SYNCHRONOUS, but TickerAll
 * fetches candles over REST and pushes ticks over a WebSocket. So this feed is a
 * CACHE: the factory pre-fetches candle history + symbol specs, then the live
 * tick stream keeps a rolling forming-bar updated, so `history()` / `tick()` /
 * `symbolInfo()` return synchronously from memory.
 *
 * Bound to a single (symbol, timeframe) chart context (MQL5's bound-chart
 * model). `history()` throws for any other timeframe rather than silently
 * serving a different one (§21).
 */

import type { Bar, IMarketFeed, SymbolSpec, Tick } from '../types';
import { tfSeconds } from './mapping';

/** A bar whose open-time bucket starts at `floor(ts / periodSec) * periodSec`. */
function barOpenTime(tsSec: number, periodSec: number): number {
  return Math.floor(tsSec / periodSec) * periodSec;
}

export class TickerallFeed implements IMarketFeed {
  private readonly bars = new Map<string, Bar[]>();
  private readonly specs = new Map<string, SymbolSpec>();
  private readonly ticks = new Map<string, Tick>();
  private readonly periodSec: number;

  constructor(
    private readonly boundSymbol: string,
    readonly timeframe: number,
  ) {
    this.periodSec = tfSeconds(timeframe);
  }

  /** Seed the candle history (chronological, oldest first). */
  seedBars(symbol: string, bars: Bar[]): void {
    this.bars.set(symbol, bars.slice());
  }

  setSpec(spec: SymbolSpec): void {
    this.specs.set(spec.name, spec);
  }

  /** A live tick: update the latest quote + the forming bar (replace, not
   *  mutate, so a previously-returned history() snapshot stays stable). */
  onTick(symbol: string, bid: number, ask: number, tsSec: number): void {
    this.ticks.set(symbol, { time: tsSec, bid, ask, last: bid, volume: 0 });

    const series = this.bars.get(symbol);
    if (series === undefined) return;
    const openTime = barOpenTime(tsSec, this.periodSec);
    const current = series.length > 0 ? series[series.length - 1] : undefined;

    if (current !== undefined && current.time === openTime) {
      series[series.length - 1] = {
        ...current,
        high: Math.max(current.high, bid),
        low: Math.min(current.low, bid),
        close: bid,
        tickVolume: current.tickVolume + 1,
      };
      return;
    }
    if (current !== undefined && openTime < current.time) return; // stale tick
    // New bar period — append a fresh forming bar.
    series.push({
      time: openTime,
      open: bid,
      high: bid,
      low: bid,
      close: bid,
      tickVolume: 1,
      spread: Math.max(0, ask - bid),
      realVolume: 0,
    });
  }

  // ── IMarketFeed ──────────────────────────────────────────────────────────

  history(symbol: string, timeframe: number): readonly Bar[] {
    if (timeframe !== this.timeframe) {
      throw new Error(
        `TickerallFeed.history: requested timeframe ${timeframe} but this feed ` +
          `is bound to ${this.timeframe}. The live provider tracks a single ` +
          `(symbol, timeframe) chart context per MQL5's bound-chart model.`,
      );
    }
    const series = this.bars.get(symbol);
    return series === undefined ? [] : series.slice();
  }

  tick(symbol: string): Tick {
    const t = this.ticks.get(symbol);
    if (t !== undefined) return t;
    // No tick yet — synthesize from the latest bar close so the EA still reads
    // a price (honest: bid=ask=close until a real tick lands).
    const series = this.bars.get(symbol);
    const last = series && series.length > 0 ? series[series.length - 1]! : undefined;
    const price = last ? last.close : 0;
    return { time: last ? last.time : 0, bid: price, ask: price, last: price, volume: 0 };
  }

  symbolInfo(symbol: string): SymbolSpec {
    const s = this.specs.get(symbol);
    if (s !== undefined) return s;
    // Unknown symbol — FX-sensible default so a read doesn't crash (§21: clearly
    // a fallback, not a fabricated broker-authoritative spec).
    return {
      name: symbol,
      digits: 5,
      point: 1e-5,
      volumeMin: 0.01,
      volumeMax: 100,
      volumeStep: 0.01,
      contractSize: 100000,
      tickSize: 1e-5,
      tickValue: 1,
    };
  }

  get bound(): string {
    return this.boundSymbol;
  }
}
