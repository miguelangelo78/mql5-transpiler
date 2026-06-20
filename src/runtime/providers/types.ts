/**
 * The provider boundary — the ONLY broker/market surface the transpiled EA
 * and the MQL5-builtins runtime ever touch. Swapping the implementation
 * swaps live ↔ backtest with zero changes to the transpiled program.
 *
 *   - IClock       — current server time + (engine-driven) timers.
 *   - IMarketFeed  — candle history, ticks, symbol specs. (Indicators are
 *                    computed by OUR runtime from this data, NOT fetched.)
 *   - IBroker      — place/modify/close orders; query positions + account.
 *
 * Implementations: a deterministic Backtest provider (historical replay +
 * simulated matching engine + sim clock) and a Live provider over the TickerAll
 * hosted API (./tickerall/), which reaches any MT4/MT5 broker with just an API
 * key — so a public checkout can run live without any private dependency.
 *
 * Async discipline: ONLY order-placing broker methods are async (they perform
 * real I/O live). Reads — getPosition/positions/account, and every market-feed
 * accessor — are synchronous: in backtest they read local state, and live they
 * read the SDK's locally-cached state / pre-loaded candle history. This is why
 * the IR marks only trade calls `await` (see ../../ir/nodes.ts).
 */

// ─────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────

export type OrderSide = 'buy' | 'sell';

/** A single OHLC bar. `time` is the bar's OPEN time in epoch seconds. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  spread: number;
  realVolume: number;
}

/** Current best bid/ask for a symbol. */
export interface Tick {
  time: number;
  bid: number;
  ask: number;
  last: number;
  volume: number;
}

/** Static-ish specification of a tradable symbol. */
export interface SymbolSpec {
  name: string;
  digits: number;
  point: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  contractSize: number;
  tickSize: number;
  tickValue: number;
}

/** An open position (netting model: at most one per symbol). */
export interface Position {
  ticket: number;
  symbol: string;
  side: OrderSide;
  volume: number;
  openPrice: number;
  openTime: number;
  sl: number;
  tp: number;
  /** Floating P/L in account currency at the current price. */
  profit: number;
  swap: number;
  magic: number;
  comment: string;
}

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  volume: number;
  /** Omit / 0 ⇒ market order. */
  price?: number;
  sl?: number;
  tp?: number;
  deviation?: number;
  magic?: number;
  comment?: string;
}

/** MT5-shaped trade result. `retcode` 10009 = TRADE_RETCODE_DONE. */
export interface TradeResult {
  retcode: number;
  ok: boolean;
  deal: number;
  order: number;
  position: number;
  price: number;
  volume: number;
  comment: string;
}

export interface AccountInfo {
  login: number;
  currency: string;
  leverage: number;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
}

/**
 * Pending-order kinds (language-neutral; the runtime maps MQL5's
 * ENUM_ORDER_TYPE_* constants onto these). `*StopLimit` carries a second price.
 */
export type PendingKind =
  | 'buyLimit' | 'sellLimit'
  | 'buyStop' | 'sellStop'
  | 'buyStopLimit' | 'sellStopLimit';

/** A resting pending order (not yet a position). */
export interface PendingOrder {
  ticket: number;
  symbol: string;
  kind: PendingKind;
  volume: number;
  /** The activation price (limit/stop trigger). */
  price: number;
  /** Second price for stop-limit kinds (the limit placed once the stop triggers). */
  stopLimitPrice?: number;
  sl: number;
  tp: number;
  placedTime: number;
  magic: number;
  comment: string;
}

export interface PendingOrderRequest {
  symbol: string;
  kind: PendingKind;
  volume: number;
  price: number;
  stopLimitPrice?: number;
  sl?: number;
  tp?: number;
  magic?: number;
  comment?: string;
}

/**
 * A single closed-history DEAL record, as seen by MQL5's history pool
 * (HistorySelect / HistoryDealGet*). One deal is one execution leg (an open leg
 * that established/added to a position, or a close leg that reduced/closed it).
 * `time` is the execution time (epoch seconds). `profit` is the realised P/L the
 * deal booked (0 for open legs). This is the provider-boundary shape so the
 * history runtime never depends on the engine's report types — the backtest
 * provider maps its internal deal log onto this.
 */
export interface DealRecord {
  ticket: number;
  /** Order ticket that produced this deal (0 when the provider has none). */
  order: number;
  time: number;
  symbol: string;
  /** Deal direction: the side the execution traded. */
  side: OrderSide;
  /** 'open' established/added to a position; 'close' reduced/closed it. */
  entry: 'open' | 'close';
  volume: number;
  price: number;
  /** Realised P/L booked by this deal (0 for open legs). */
  profit: number;
  commission: number;
  swap: number;
  comment: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Provider interfaces
// ─────────────────────────────────────────────────────────────────────────

export interface IClock {
  /** Current server time, epoch seconds. */
  now(): number;
}

export interface IMarketFeed {
  /**
   * Visible bars for (symbol, timeframe) in CHRONOLOGICAL order
   * (oldest first, newest/current bar last). The runtime applies MT5's
   * as-series indexing on top of this clean array.
   */
  history(symbol: string, timeframe: number): readonly Bar[];
  /** Current tick (bid/ask/last) for `symbol`. */
  tick(symbol: string): Tick;
  /** Symbol specification (digits, point, volume constraints, tick value). */
  symbolInfo(symbol: string): SymbolSpec;
}

export interface IBroker {
  /** Place a market order. Async — real I/O on the live provider. */
  placeMarketOrder(req: OrderRequest): Promise<TradeResult>;
  /** Modify the SL/TP of the netting position on `symbol`. */
  modifyPosition(symbol: string, sl: number, tp: number): Promise<TradeResult>;
  /** Close the netting position on `symbol` (full, or `volume` for partial). */
  closePosition(symbol: string, volume?: number): Promise<TradeResult>;
  /** The netting position currently held on `symbol`, or null. (sync read) */
  getPosition(symbol: string): Position | null;
  /** All open positions. (sync read) */
  positions(): readonly Position[];
  /** Account snapshot. (sync read) */
  account(): AccountInfo;

  // ── Pending orders (OPTIONAL: a provider that doesn't support them omits
  //    these, and CTrade's pending methods report honestly that the egress
  //    can't place pending orders rather than faking success. The backtest
  //    provider implements them; the live provider may add them later.) ──
  /** Place a pending (limit/stop/stop-limit) order. */
  placePendingOrder?(req: PendingOrderRequest): Promise<TradeResult>;
  /** Delete a resting pending order by ticket. */
  deletePendingOrder?(ticket: number): Promise<TradeResult>;
  /** Modify a resting pending order's price/SL/TP. */
  modifyPendingOrder?(ticket: number, price: number, sl: number, tp: number): Promise<TradeResult>;
  /** All resting pending orders. (sync read) */
  pendingOrders?(): readonly PendingOrder[];
  /** A resting pending order by ticket, or null. (sync read) */
  getPendingOrder?(ticket: number): PendingOrder | null;

  // ── Closed deal history (OPTIONAL: a provider that records a deal log
  //    implements this so HistorySelect/HistoryDealsTotal can read it. The
  //    backtest provider implements it from its recorded deals; the live
  //    provider omits it for now and the history runtime honestly reports an
  //    empty window rather than faking one — §21.) ──
  /**
   * Closed deals in CHRONOLOGICAL order (oldest first). The history runtime
   * applies HistorySelect's [from,to] window on top of this clean log.
   */
  dealHistory?(): readonly DealRecord[];
}

/** Everything the engine driver needs, bundled. */
export interface Providers {
  clock: IClock;
  feed: IMarketFeed;
  broker: IBroker;
}
