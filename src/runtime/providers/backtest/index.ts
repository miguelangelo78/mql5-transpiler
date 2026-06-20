/**
 * Backtest provider — assembles the sim clock, feed, and matching-engine
 * broker into a `BacktestSimulation` the engine driver steps one bar at a
 * time, and produces the `BacktestReport`.
 *
 * ── Stepping protocol ───────────────────────────────────────────────────────
 * `createBacktest` builds the providers with `visibleCount = 0`. Each `step()`
 *   1. advances `visibleCount` by 1 (reveals the next chronological bar);
 *   2. points the clock at the new current bar's open time;
 *   3. marks the broker to the new bar's bid/ask;
 *   4. snapshots an equity-curve point;
 * and returns false once the dataset is exhausted (no more bars to reveal).
 *
 * The invariant (engine/types.ts) holds after every `step()` that returns
 * true: `feed.history()` ends at the just-revealed current bar, and the clock
 * + tick reflect it.
 *
 * ── Fidelity note (rule 21) ─────────────────────────────────────────────────
 * This is the BAR-BASED tier: market orders fill at the current bar's
 * bid/ask. Intrabar SL/TP auto-triggering, real swap/commission, and slippage
 * are a later (tick-accurate) tier and are NOT simulated here — they are left
 * as explicit zeroes / unimplemented rather than approximated. SL/TP set on a
 * position are stored faithfully but not auto-executed by the engine yet.
 */

import type {
  BacktestSimulation,
  BacktestReport,
  RuntimeContext,
} from '../../../engine/types';
import type { Bar, Providers, SymbolSpec } from '../types';
import { generateSyntheticBars, type SyntheticBarsOptions } from '../../../data/synthetic';
import { BacktestClock } from './clock';
import { BacktestFeed } from './feed';
import { BacktestBroker } from './broker';

/** Synthetic-data options minus the fields the config already pins. */
export type SyntheticConfig = Omit<
  SyntheticBarsOptions,
  'symbol' | 'timeframe'
> & Partial<Pick<SyntheticBarsOptions, 'symbol' | 'timeframe'>>;

export interface BacktestConfig {
  symbol: string;
  timeframe: number;
  /**
   * Either an explicit chronological bar array, or synthetic-generator options
   * (the symbol/timeframe are taken from the config if omitted there).
   */
  bars: Bar[] | SyntheticConfig;
  /** Starting account balance. Default 10000. A 0 balance is valid (rule 29). */
  initialBalance?: number;
  /** Spread in points (ask = bar.close + spreadPoints * point). Default 0. */
  spreadPoints?: number;
  /** Symbol specification. A documented default is used when omitted. */
  symbolSpec?: SymbolSpec;
  /** Account metadata (optional). */
  login?: number;
  currency?: string;
  leverage?: number;
}

/** A documented default symbol spec (5-digit FX-like) used when none supplied. */
export function defaultSymbolSpec(symbol: string): SymbolSpec {
  return {
    name: symbol,
    digits: 5,
    point: 0.00001,
    volumeMin: 0.01,
    volumeMax: 100,
    volumeStep: 0.01,
    contractSize: 100000,
    tickSize: 0.00001,
    tickValue: 1,
  };
}

interface RealisedTrade {
  profit: number;
}

class BacktestSimulationImpl implements BacktestSimulation {
  readonly providers: Providers;
  private readonly clock: BacktestClock;
  private readonly feed: BacktestFeed;
  private readonly broker: BacktestBroker;
  private readonly dataset: readonly Bar[];
  private readonly spec: SymbolSpec;
  private readonly spreadPoints: number;
  private readonly initialBalance: number;
  readonly context: RuntimeContext;

  private readonly equityCurve: { time: number; equity: number; balance: number }[] = [];

  constructor(config: BacktestConfig) {
    const symbol = config.symbol;
    const timeframe = config.timeframe;
    this.context = { symbol, timeframe };
    this.spec = config.symbolSpec ?? defaultSymbolSpec(symbol);
    this.spreadPoints = config.spreadPoints ?? 0;
    this.initialBalance = config.initialBalance ?? 10000;

    // Resolve bars: explicit array or synthetic generation.
    this.dataset = Array.isArray(config.bars)
      ? config.bars
      : generateSyntheticBars({
          symbol,
          timeframe,
          bars: config.bars.bars,
          startPrice: config.bars.startPrice,
          startTime: config.bars.startTime,
          seed: config.bars.seed,
          driftPerBar: config.bars.driftPerBar,
          cycleAmplitude: config.bars.cycleAmplitude,
          cyclePeriodBars: config.bars.cyclePeriodBars,
          noise: config.bars.noise,
          wick: config.bars.wick,
          point: config.bars.point ?? this.spec.point,
        });

    this.clock = new BacktestClock(this.dataset.length > 0 ? this.dataset[0].time : 0);
    this.feed = new BacktestFeed({
      symbol,
      timeframe,
      dataset: this.dataset,
      spec: this.spec,
      spreadPoints: this.spreadPoints,
    });
    this.broker = new BacktestBroker({
      symbol,
      spec: this.spec,
      initialBalance: this.initialBalance,
      priceFn: () => {
        const t = this.feed.tick(symbol);
        return { bid: t.bid, ask: t.ask };
      },
      timeFn: () => this.clock.now(),
      login: config.login,
      currency: config.currency,
      leverage: config.leverage,
    });

    this.providers = {
      clock: this.clock,
      feed: this.feed,
      broker: this.broker,
    };
  }

  step(): boolean {
    const next = this.feed.visible() + 1;
    if (next > this.dataset.length) {
      return false; // exhausted
    }
    this.feed.setVisible(next);
    const bar = this.feed.currentBar();
    if (bar !== null) {
      this.clock.set(bar.time);
      const tick = this.feed.tick(this.context.symbol);
      this.broker.mark(tick.bid, tick.ask);
      // Intrabar matching: trigger resting pendings into positions, then check
      // SL/TP on open positions — using this bar's OHLC, in the documented §21
      // order (see BacktestBroker.markBar). This runs BEFORE the equity
      // snapshot so the curve reflects fills/closes booked on this bar, and
      // BEFORE OnTick/OnTimer (the EA sees the post-fill book this bar).
      this.broker.markBar(bar);
      this.equityCurve.push({
        time: bar.time,
        equity: this.broker.getEquity(),
        balance: this.broker.getBalance(),
      });
    }
    return true;
  }

  barIndex(): number {
    // 0-based index of the current newest visible bar.
    return this.feed.visible() - 1;
  }

  totalBars(): number {
    return this.dataset.length;
  }

  report(): BacktestReport {
    const deals = this.broker.deals;
    const barsProcessed = this.feed.visible();
    const finalBalance = this.broker.getBalance();
    const finalEquity = this.broker.getEquity();
    const netProfit = finalBalance - this.initialBalance;

    // Round-trips = closing deals (each close leg realises one trade leg's P/L).
    const closeDeals = deals.filter((d) => d.kind === 'close');
    const totalTrades = closeDeals.length;
    let wins = 0;
    let losses = 0;
    for (const d of closeDeals) {
      if (d.profit > 0) wins++;
      else if (d.profit < 0) losses++;
      // profit === 0 is neither a win nor a loss (break-even) — rule 29:
      // a 0 is real data, not "missing"; we just don't count it either way.
    }
    const decisive = wins + losses;
    const winRate = decisive > 0 ? wins / decisive : 0;

    // Max drawdown from the equity curve (peak-to-trough, absolute currency).
    const maxDrawdown = computeMaxDrawdown(this.equityCurve.map((p) => p.equity));

    return {
      symbol: this.context.symbol,
      timeframe: this.context.timeframe,
      barsProcessed,
      initialBalance: this.initialBalance,
      finalBalance,
      finalEquity,
      netProfit,
      totalDeals: deals.length,
      totalTrades,
      wins,
      losses,
      winRate,
      maxDrawdown,
      deals: [...deals],
      equityCurve: [...this.equityCurve],
    };
  }
}

/** Peak-to-trough max drawdown (absolute, in account currency). */
function computeMaxDrawdown(equity: readonly number[]): number {
  let peak = -Infinity;
  let maxDD = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD === 0 ? 0 : maxDD;
}

export function createBacktest(config: BacktestConfig): BacktestSimulation {
  return new BacktestSimulationImpl(config);
}
