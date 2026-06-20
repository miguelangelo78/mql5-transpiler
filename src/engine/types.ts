/**
 * Engine ↔ backtest-provider ↔ report contract.
 *
 * Pins the seams the driver, the backtest providers, and the verification
 * harness all share:
 *   - RuntimeContext    — what `createRuntime` needs to bind (symbol,timeframe).
 *   - BacktestSimulation — the stepping protocol the driver drives.
 *   - BacktestReport    — the trade-for-trade + equity output the PoC prints.
 *
 * The concrete backtest config / synthetic-data options are owned by the
 * backtest provider module; only these consumer-facing shapes are pinned here.
 */

import type { Providers, OrderSide } from '../runtime/providers/types';

/** The bound (symbol, timeframe) chart context an expert runs against. */
export interface RuntimeContext {
  symbol: string;
  timeframe: number;
}

/**
 * A deterministic backtest the driver advances one bar at a time.
 *
 * Invariant after `step()` returns true: `providers.feed.history(sym,tf)`
 * includes the newly-opened current bar as its last element, and
 * `providers.clock.now()` / `feed.tick(sym)` reflect that bar.
 */
export interface BacktestSimulation {
  providers: Providers;
  /** Advance to the next bar. Returns false when the dataset is exhausted. */
  step(): boolean;
  /** Index (0-based, chronological) of the current newest visible bar. */
  barIndex(): number;
  /** Total bars in the dataset. */
  totalBars(): number;
  /** Snapshot the report at the current point (call after the loop for final). */
  report(): BacktestReport;
}

/** One executed deal (open or close leg), in chronological order. */
export interface BacktestDeal {
  ticket: number;
  time: number;
  symbol: string;
  side: OrderSide;
  /** 'open' established/added to a position; 'close' reduced/closed it. */
  kind: 'open' | 'close';
  volume: number;
  price: number;
  /** Realised P/L booked by this deal (close legs); 0 for opens. */
  profit: number;
  commission: number;
  swap: number;
  /** Account balance immediately after this deal. */
  balanceAfter: number;
  comment: string;
}

export interface BacktestReport {
  symbol: string;
  timeframe: number;
  barsProcessed: number;
  initialBalance: number;
  finalBalance: number;
  finalEquity: number;
  netProfit: number;
  totalDeals: number;
  totalTrades: number; // round-trips (closed positions)
  wins: number;
  losses: number;
  winRate: number;
  maxDrawdown: number;
  deals: BacktestDeal[];
  equityCurve: { time: number; equity: number; balance: number }[];
}
