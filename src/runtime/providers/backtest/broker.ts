/**
 * BacktestBroker — a deterministic, offline matching engine + IBroker.
 *
 * ── Position model: NETTING ────────────────────────────────────────────────
 * At most ONE position per symbol (MT5 netting accounts). A market order:
 *   - opens a position if none exists on the symbol;
 *   - if SAME side as the open position → ADDS, with the new open price a
 *     volume-weighted average (VWAP) of old and new legs;
 *   - if OPPOSITE side → REDUCES the position by the incoming volume. If the
 *     incoming volume is < open volume the position shrinks (partial close);
 *     if equal it closes flat; if greater it CLOSES the old position and OPENS
 *     a new one on the opposite side with the remainder (a flip).
 * Every reduce/close leg books realised P/L into `balance`.
 *
 * ── Fill prices ────────────────────────────────────────────────────────────
 * A buy fills at the current ASK, a sell at the current BID (from the feed's
 * current-bar tick). Closing a long sells at BID; closing a short buys at ASK.
 *
 * ── P/L formula (rule 21 — explicit + documented, NOT a heuristic) ──────────
 *   profit = (exitPrice - entryPrice) * dirSign * volume * contractSize
 *   where dirSign = +1 for a long (buy) position, -1 for a short (sell).
 * Result is in the account (deposit) currency, assuming the symbol's quote
 * currency equals the account currency (the PoC's simplification — documented,
 * not hidden). `contractSize` comes from the SymbolSpec. Swap and commission
 * default to 0 and are surfaced as explicit zeroes on each deal so a richer
 * model can fill them later.
 *
 * ── Marking ────────────────────────────────────────────────────────────────
 * `mark(bid, ask)` updates the latest prices so `getPosition().profit` (the
 * FLOATING P/L) and `account().equity = balance + Σ floating P/L` reflect the
 * current bar. The simulation calls it each step.
 */

import type {
  AccountInfo,
  Bar,
  DealRecord,
  IBroker,
  OrderRequest,
  OrderSide,
  PendingKind,
  PendingOrder,
  PendingOrderRequest,
  Position,
  SymbolSpec,
  TradeResult,
} from '../types';
import type { BacktestDeal } from '../../../engine/types';

const RETCODE_DONE = 10009;
const RETCODE_REJECT = 10006;
const VOL_EPS = 1e-8; // volume comparison tolerance (lots quantised ~0.01)

interface InternalPosition {
  ticket: number;
  symbol: string;
  side: OrderSide;
  volume: number;
  openPrice: number;
  openTime: number;
  sl: number;
  tp: number;
  swap: number;
  magic: number;
  comment: string;
}

interface InternalPending {
  ticket: number;
  symbol: string;
  kind: PendingKind;
  volume: number;
  /** Activation price (the limit/stop trigger). */
  price: number;
  /** For stop-limit kinds: the limit price placed once the stop arms. */
  stopLimitPrice?: number;
  /** Stop-limit two-stage state: true once the stop trigger has armed. */
  stopArmed: boolean;
  sl: number;
  tp: number;
  placedTime: number;
  magic: number;
  comment: string;
}

export interface BacktestBrokerArgs {
  symbol: string;
  spec: SymbolSpec;
  initialBalance: number;
  /** Returns the current [bid, ask] for the symbol (from the feed). */
  priceFn: () => { bid: number; ask: number };
  /** Returns the current sim time (from the clock). */
  timeFn: () => number;
  login?: number;
  currency?: string;
  leverage?: number;
}

export class BacktestBroker implements IBroker {
  private readonly symbol: string;
  private readonly spec: SymbolSpec;
  private readonly priceFn: () => { bid: number; ask: number };
  private readonly timeFn: () => number;
  private readonly login: number;
  private readonly currency: string;
  private readonly leverage: number;

  private balance: number;
  private position: InternalPosition | null = null;
  /** Resting pending orders, keyed by ticket (insertion-ordered). */
  private readonly pendings = new Map<number, InternalPending>();
  private nextTicket = 1;
  private nextDeal = 1;

  /** Latest marked prices (for floating P/L). */
  private lastBid = 0;
  private lastAsk = 0;

  /** Chronological deal log (open + close legs). */
  readonly deals: BacktestDeal[] = [];

  constructor(args: BacktestBrokerArgs) {
    this.symbol = args.symbol;
    this.spec = args.spec;
    this.priceFn = args.priceFn;
    this.timeFn = args.timeFn;
    this.login = args.login ?? 1000;
    this.currency = args.currency ?? 'USD';
    this.leverage = args.leverage ?? 100;
    this.balance = args.initialBalance;
  }

  // ── price helpers ──────────────────────────────────────────────────────────

  /** Mark the latest prices so floating P/L + equity reflect the current bar. */
  mark(bid: number, ask: number): void {
    this.lastBid = bid;
    this.lastAsk = ask;
  }

  private dirSign(side: OrderSide): number {
    return side === 'buy' ? 1 : -1;
  }

  /**
   * Realised P/L for closing `volume` of a position opened at `openPrice` on
   * `side`, at `exitPrice`. (rule 21 — the documented formula above.)
   */
  private realisedPL(
    side: OrderSide,
    openPrice: number,
    exitPrice: number,
    volume: number,
  ): number {
    const raw =
      (exitPrice - openPrice) *
      this.dirSign(side) *
      volume *
      this.spec.contractSize;
    // Book in the account-currency precision. MT5 rounds deal profit to the
    // deposit-currency digits; this PoC assumes a 2-decimal currency (USD).
    // Quantising at the source keeps stored deals AND the running balance free
    // of float64 accumulation drift (the SDK's §21 lesson: do money math in a
    // clean fixed-precision domain, not raw float). TODO: make the precision
    // configurable from the account currency when non-2dp currencies are added.
    return Math.round(raw * 100) / 100;
  }

  /** Floating P/L of the open position at the latest marked prices. */
  private floatingPL(): number {
    if (this.position === null) return 0;
    const p = this.position;
    // A long is valued at the price it could be CLOSED at (bid); a short at ask.
    const exit = p.side === 'buy' ? this.lastBid : this.lastAsk;
    return this.realisedPL(p.side, p.openPrice, exit, p.volume);
  }

  // ── deal recording ─────────────────────────────────────────────────────────

  private recordDeal(args: {
    side: OrderSide;
    kind: 'open' | 'close';
    volume: number;
    price: number;
    profit: number;
    comment: string;
  }): number {
    const ticket = this.nextDeal++;
    this.deals.push({
      ticket,
      time: this.timeFn(),
      symbol: this.symbol,
      side: args.side,
      kind: args.kind,
      volume: args.volume,
      price: args.price,
      profit: args.profit,
      commission: 0,
      swap: 0,
      balanceAfter: this.balance,
      comment: args.comment,
    });
    return ticket;
  }

  private doneResult(
    deal: number,
    order: number,
    position: number,
    price: number,
    volume: number,
    comment: string,
  ): TradeResult {
    return {
      retcode: RETCODE_DONE,
      ok: true,
      deal,
      order,
      position,
      price,
      volume,
      comment,
    };
  }

  private rejectResult(comment: string): TradeResult {
    return {
      retcode: RETCODE_REJECT,
      ok: false,
      deal: 0,
      order: 0,
      position: 0,
      price: 0,
      volume: 0,
      comment,
    };
  }

  // ── IBroker: trading ────────────────────────────────────────────────────────

  async placeMarketOrder(req: OrderRequest): Promise<TradeResult> {
    const volume = req.volume;
    if (!(volume > 0)) {
      return this.rejectResult('invalid volume');
    }
    const { bid, ask } = this.priceFn();
    // A buy fills at ask, a sell at bid.
    const fillPrice = req.side === 'buy' ? ask : bid;
    const sl = req.sl ?? 0;
    const tp = req.tp ?? 0;
    const magic = req.magic ?? 0;
    const comment = req.comment ?? '';

    const existing = this.position;

    // No open position → open fresh.
    if (existing === null) {
      return this.openFresh(req.side, volume, fillPrice, sl, tp, magic, comment);
    }

    // Same side → add at VWAP.
    if (existing.side === req.side) {
      const totalVol = existing.volume + volume;
      const vwap =
        (existing.openPrice * existing.volume + fillPrice * volume) / totalVol;
      existing.volume = totalVol;
      existing.openPrice = vwap;
      // SL/TP/comment of an add: keep the position's existing risk levels.
      const dealTicket = this.recordDeal({
        side: req.side,
        kind: 'open',
        volume,
        price: fillPrice,
        profit: 0,
        comment,
      });
      return this.doneResult(
        dealTicket,
        dealTicket,
        existing.ticket,
        fillPrice,
        volume,
        comment,
      );
    }

    // Opposite side → reduce / close / flip.
    // The reducing leg books P/L at the price it exits the OLD position. The
    // old long is closed by selling at bid; old short closed by buying at ask.
    const exitPrice = existing.side === 'buy' ? bid : ask;
    const reduceVol = Math.min(volume, existing.volume);
    const profit = this.realisedPL(
      existing.side,
      existing.openPrice,
      exitPrice,
      reduceVol,
    );
    this.balance += profit;

    const closeDeal = this.recordDeal({
      side: req.side, // the deal direction (the incoming order's side)
      kind: 'close',
      volume: reduceVol,
      price: exitPrice,
      profit,
      comment,
    });

    const remainingOld = existing.volume - reduceVol;
    if (remainingOld > VOL_EPS) {
      // Partial close — old position shrinks, stays same side.
      existing.volume = remainingOld;
      return this.doneResult(
        closeDeal,
        closeDeal,
        existing.ticket,
        exitPrice,
        reduceVol,
        comment,
      );
    }

    // Old position fully closed.
    this.position = null;

    const flipVol = volume - reduceVol;
    if (flipVol > VOL_EPS) {
      // Flip — open a new position on the incoming side with the remainder.
      // The flip leg opens at the incoming order's fill price.
      const openRes = this.openFresh(
        req.side,
        flipVol,
        fillPrice,
        sl,
        tp,
        magic,
        comment,
      );
      // Report the new position; deal ticket of the open leg.
      return openRes;
    }

    // Exact close, no flip.
    return this.doneResult(closeDeal, closeDeal, 0, exitPrice, reduceVol, comment);
  }

  private openFresh(
    side: OrderSide,
    volume: number,
    fillPrice: number,
    sl: number,
    tp: number,
    magic: number,
    comment: string,
  ): TradeResult {
    const ticket = this.nextTicket++;
    this.position = {
      ticket,
      symbol: this.symbol,
      side,
      volume,
      openPrice: fillPrice,
      openTime: this.timeFn(),
      sl,
      tp,
      swap: 0,
      magic,
      comment,
    };
    const dealTicket = this.recordDeal({
      side,
      kind: 'open',
      volume,
      price: fillPrice,
      profit: 0,
      comment,
    });
    return this.doneResult(dealTicket, dealTicket, ticket, fillPrice, volume, comment);
  }

  async closePosition(symbol: string, volume?: number): Promise<TradeResult> {
    const pos = this.position;
    if (pos === null || pos.symbol !== symbol) {
      return this.rejectResult('no position to close');
    }
    const { bid, ask } = this.priceFn();
    // Closing a long sells at bid; closing a short buys at ask.
    const exitPrice = pos.side === 'buy' ? bid : ask;
    // `volume` undefined ⇒ full close. 0 is NOT a valid close volume (rule 29:
    // distinguish absent (full close) from an explicit 0 (nothing to close)).
    let closeVol: number;
    if (volume === undefined) {
      closeVol = pos.volume;
    } else if (volume <= 0) {
      return this.rejectResult('invalid close volume');
    } else {
      closeVol = Math.min(volume, pos.volume);
    }

    const profit = this.realisedPL(pos.side, pos.openPrice, exitPrice, closeVol);
    this.balance += profit;

    // The closing deal's side is the OPPOSITE of the position side.
    const dealSide: OrderSide = pos.side === 'buy' ? 'sell' : 'buy';
    const dealTicket = this.recordDeal({
      side: dealSide,
      kind: 'close',
      volume: closeVol,
      price: exitPrice,
      profit,
      comment: pos.comment,
    });

    const remaining = pos.volume - closeVol;
    if (remaining > VOL_EPS) {
      pos.volume = remaining;
      return this.doneResult(
        dealTicket,
        dealTicket,
        pos.ticket,
        exitPrice,
        closeVol,
        pos.comment,
      );
    }

    const posTicket = pos.ticket;
    const posComment = pos.comment; // capture before clearing — the full-close
    this.position = null; // result must carry the same comment the deal logs.
    return this.doneResult(dealTicket, dealTicket, posTicket, exitPrice, closeVol, posComment);
  }

  async modifyPosition(
    symbol: string,
    sl: number,
    tp: number,
  ): Promise<TradeResult> {
    const pos = this.position;
    if (pos === null || pos.symbol !== symbol) {
      return this.rejectResult('no position to modify');
    }
    pos.sl = sl;
    pos.tp = tp;
    return this.doneResult(0, 0, pos.ticket, pos.openPrice, pos.volume, pos.comment);
  }

  // ── IBroker: pending orders ──────────────────────────────────────────────────
  //
  // A pending order RESTS (assigned a ticket) until a bar's range reaches its
  // activation price; `markBar` (below) is the only thing that triggers it. The
  // book is the netting model's "working orders" — independent of the open
  // position; a pending may rest while a position is open (it just fills into
  // the netting position when triggered, via the same add/reduce/flip path as a
  // market order).

  async placePendingOrder(req: PendingOrderRequest): Promise<TradeResult> {
    if (!(req.volume > 0)) {
      return this.rejectResult('invalid volume');
    }
    if (!(req.price > 0)) {
      return this.rejectResult('invalid pending price');
    }
    // Stop-limit kinds require a second (limit) price.
    const isStopLimit =
      req.kind === 'buyStopLimit' || req.kind === 'sellStopLimit';
    if (isStopLimit && !(typeof req.stopLimitPrice === 'number' && req.stopLimitPrice > 0)) {
      return this.rejectResult('stop-limit requires stopLimitPrice');
    }
    const ticket = this.nextTicket++;
    const pending: InternalPending = {
      ticket,
      symbol: this.symbol,
      kind: req.kind,
      volume: req.volume,
      price: req.price,
      stopLimitPrice: isStopLimit ? req.stopLimitPrice : undefined,
      stopArmed: false,
      sl: req.sl ?? 0,
      tp: req.tp ?? 0,
      placedTime: this.timeFn(),
      magic: req.magic ?? 0,
      comment: req.comment ?? '',
    };
    this.pendings.set(ticket, pending);
    // A placed pending returns its ORDER ticket (MT5: result.order). No deal
    // yet — it hasn't filled. price/volume echo the request.
    return this.doneResult(0, ticket, 0, req.price, req.volume, pending.comment);
  }

  async deletePendingOrder(ticket: number): Promise<TradeResult> {
    const pending = this.pendings.get(ticket);
    if (pending === undefined) {
      return this.rejectResult('no such pending order');
    }
    this.pendings.delete(ticket);
    return this.doneResult(0, ticket, 0, pending.price, pending.volume, pending.comment);
  }

  async modifyPendingOrder(
    ticket: number,
    price: number,
    sl: number,
    tp: number,
  ): Promise<TradeResult> {
    const pending = this.pendings.get(ticket);
    if (pending === undefined) {
      return this.rejectResult('no such pending order');
    }
    // A price of 0 would be meaningless for an activation price; reject it
    // rather than silently storing it (rule 29: 0 is a real value, and here it
    // is an invalid activation price, so we say so explicitly).
    if (!(price > 0)) {
      return this.rejectResult('invalid pending price');
    }
    pending.price = price;
    pending.sl = sl;
    pending.tp = tp;
    return this.doneResult(0, ticket, 0, pending.price, pending.volume, pending.comment);
  }

  // ── Intrabar matching engine (rule 21 — explicit, documented ORDER) ──────────
  //
  // `markBar(bar)` is called by the simulation once per revealed bar, AFTER the
  // tick prices for that bar are marked. Using only the bar's OHLC (the bar
  // tier has no intrabar M1 data), it processes the bar in this fixed order:
  //
  //   1. PENDING ACTIVATION first. A resting pending whose activation price lies
  //      within [bar.low, bar.high] fills AT its activation price (not the bar
  //      close) and converts to a (netting) position carrying its SL/TP. This
  //      precedes SL/TP so an order that opens AND would be stopped within the
  //      same bar is handled in two passes (open here; its SL/TP is then checked
  //      against the SAME bar in step 2 — MT5 likewise can stop a freshly-filled
  //      pending inside its activation bar).
  //        buyLimit  fills when bar.low  <= price   (price at/below the low)
  //        sellLimit fills when bar.high >= price   (price at/above the high)
  //        buyStop   fills when bar.high >= price
  //        sellStop  fills when bar.low  <= price
  //        *StopLimit: the STOP arms when its stop price is reached (buyStopLimit
  //          arms when bar.high >= price; sellStopLimit when bar.low <= price),
  //          THEN a limit at stopLimitPrice fills like the corresponding
  //          buy/sellLimit (possibly only on a LATER bar — two-stage).
  //
  //   2. SL/TP on the open position. Long: SL when bar.low <= SL, TP when
  //      bar.high >= TP. Short: SL when bar.high >= SL, TP when bar.low <= TP.
  //
  //   BOTH-HIT priority (the load-bearing §21 modelling choice): when a single
  //   bar's range contains BOTH the SL and the TP, we assume the SL is hit
  //   FIRST (the conservative / pessimistic assumption). The bar tier has no
  //   intrabar path to know the true order, and this is exactly what MT5's
  //   Strategy Tester does in "Open prices" / "1 minute OHLC" modes without
  //   real M1 ticks: it processes the worse outcome first. We DOCUMENT this
  //   rather than guess the favourable fill.
  //
  // Activation prices and SL/TP use INCLUSIVE comparisons (a bar that exactly
  // touches the level triggers) — touching the price is a fill in MT5.
  markBar(bar: Bar): void {
    this.processPendingActivations(bar);
    this.processStopLossTakeProfit(bar);
  }

  /** Step 1: activate any resting pendings whose trigger lies in the bar. */
  private processPendingActivations(bar: Bar): void {
    // Snapshot the tickets so deletions during iteration are safe, and so a
    // pending placed by a fill (not possible here, but defensive) isn't
    // re-evaluated in the same pass.
    for (const ticket of [...this.pendings.keys()]) {
      const pending = this.pendings.get(ticket);
      if (pending === undefined) continue;

      const isStopLimit =
        pending.kind === 'buyStopLimit' || pending.kind === 'sellStopLimit';

      if (isStopLimit) {
        // Two-stage: arm the stop, then fill the limit (possibly later bars).
        if (!pending.stopArmed) {
          const armed =
            pending.kind === 'buyStopLimit'
              ? bar.high >= pending.price
              : bar.low <= pending.price;
          if (!armed) continue;
          pending.stopArmed = true;
          // After arming, the limit may fill within the SAME bar — fall through.
        }
        // Stop is armed: behave as a limit at stopLimitPrice.
        const limit = pending.stopLimitPrice;
        if (limit === undefined) continue; // guarded at placement; defensive.
        const limitSide: OrderSide =
          pending.kind === 'buyStopLimit' ? 'buy' : 'sell';
        const limitFills =
          limitSide === 'buy' ? bar.low <= limit : bar.high >= limit;
        if (limitFills) {
          this.fillPending(pending, limitSide, limit);
        }
        continue;
      }

      // Plain limit/stop kinds.
      let fills = false;
      let side: OrderSide = 'buy';
      switch (pending.kind) {
        case 'buyLimit':
          side = 'buy';
          fills = bar.low <= pending.price;
          break;
        case 'sellLimit':
          side = 'sell';
          fills = bar.high >= pending.price;
          break;
        case 'buyStop':
          side = 'buy';
          fills = bar.high >= pending.price;
          break;
        case 'sellStop':
          side = 'sell';
          fills = bar.low <= pending.price;
          break;
        default:
          // buy/sellStopLimit handled above; nothing else exists.
          break;
      }
      if (fills) {
        this.fillPending(pending, side, pending.price);
      }
    }
  }

  /**
   * Convert a triggered pending into a (netting) position at `fillPrice`,
   * carrying its SL/TP. Reuses the market open/add/reduce/flip path so the
   * netting model is identical to a market fill; records the open deal.
   */
  private fillPending(
    pending: InternalPending,
    side: OrderSide,
    fillPrice: number,
  ): void {
    this.pendings.delete(pending.ticket);
    // Tag the resulting open deal so the report can show WHY this position
    // opened (a pending activation, not a market order). When the EA supplied
    // its own comment we keep it; otherwise we annotate with the pending kind so
    // a pending fill is self-evident in the trade log. This is observability
    // only — it does NOT affect matching, P/L, or the netting algebra (§21).
    const fillComment =
      pending.comment !== '' ? pending.comment : `[${pending.kind} fill]`;
    this.applyFill(side, pending.volume, fillPrice, pending.sl, pending.tp, pending.magic, fillComment);
  }

  /**
   * Apply a fill of `volume` on `side` at `fillPrice` into the netting position
   * (open / add-VWAP / reduce / close / flip). Shared by pending activations and
   * (intentionally) usable by any future intrabar market path. Books realised
   * P/L on reduce/close legs and records the open/close deals. This mirrors the
   * `placeMarketOrder` netting algorithm but at an arbitrary `fillPrice`
   * (pendings fill at their trigger, not the current tick).
   */
  private applyFill(
    side: OrderSide,
    volume: number,
    fillPrice: number,
    sl: number,
    tp: number,
    magic: number,
    comment: string,
  ): void {
    const existing = this.position;

    if (existing === null) {
      this.openFresh(side, volume, fillPrice, sl, tp, magic, comment);
      return;
    }

    if (existing.side === side) {
      const totalVol = existing.volume + volume;
      existing.openPrice =
        (existing.openPrice * existing.volume + fillPrice * volume) / totalVol;
      existing.volume = totalVol;
      this.recordDeal({ side, kind: 'open', volume, price: fillPrice, profit: 0, comment });
      return;
    }

    // Opposite side → reduce / close / flip, exiting the OLD position at the
    // SAME fillPrice (a pending fill is a single price event).
    const reduceVol = Math.min(volume, existing.volume);
    const profit = this.realisedPL(existing.side, existing.openPrice, fillPrice, reduceVol);
    this.balance += profit;
    this.recordDeal({ side, kind: 'close', volume: reduceVol, price: fillPrice, profit, comment });

    const remainingOld = existing.volume - reduceVol;
    if (remainingOld > VOL_EPS) {
      existing.volume = remainingOld;
      return;
    }
    this.position = null;
    const flipVol = volume - reduceVol;
    if (flipVol > VOL_EPS) {
      this.openFresh(side, flipVol, fillPrice, sl, tp, magic, comment);
    }
  }

  /** Step 2: close the open position if this bar reached its SL or TP. */
  private processStopLossTakeProfit(bar: Bar): void {
    const pos = this.position;
    if (pos === null) return;

    // SL/TP are only active when set (a value of 0 ⇒ "not set" in MT5; rule 29
    // applies but 0 is genuinely MT5's sentinel for an absent stop level — a
    // real price is never 0, so 0 unambiguously means "no level here").
    const hasSl = pos.sl !== 0;
    const hasTp = pos.tp !== 0;

    let slHit: boolean;
    let tpHit: boolean;
    if (pos.side === 'buy') {
      slHit = hasSl && bar.low <= pos.sl;
      tpHit = hasTp && bar.high >= pos.tp;
    } else {
      slHit = hasSl && bar.high >= pos.sl;
      tpHit = hasTp && bar.low <= pos.tp;
    }

    if (!slHit && !tpHit) return;

    // BOTH-HIT priority: SL first (conservative). See markBar's doc block.
    // GAP-AWARE fill: if the bar OPENED already beyond the level, the realistic
    // fill is the gap-open price (worse than SL / better than TP — MT5 fills at
    // the first available price after the gap), not the level itself. Otherwise
    // the level is reached intrabar and fills exactly at the level.
    const closeComment = slHit ? '[sl]' : '[tp]';
    const level = slHit ? pos.sl : pos.tp;
    const gappedPast =
      pos.side === 'buy'
        ? (slHit ? bar.open <= level : bar.open >= level)
        : (slHit ? bar.open >= level : bar.open <= level);
    const exitPrice = gappedPast ? bar.open : level;
    this.closeWholePosition(pos, exitPrice, closeComment);
  }

  /** Close the entire open position at `exitPrice`, booking P/L + a close deal. */
  private closeWholePosition(
    pos: InternalPosition,
    exitPrice: number,
    comment: string,
  ): void {
    const profit = this.realisedPL(pos.side, pos.openPrice, exitPrice, pos.volume);
    this.balance += profit;
    const dealSide: OrderSide = pos.side === 'buy' ? 'sell' : 'buy';
    this.recordDeal({
      side: dealSide,
      kind: 'close',
      volume: pos.volume,
      price: exitPrice,
      profit,
      comment,
    });
    this.position = null;
  }

  // ── IBroker: reads ──────────────────────────────────────────────────────────

  getPosition(symbol: string): Position | null {
    const p = this.position;
    if (p === null || p.symbol !== symbol) return null;
    return this.toPublicPosition(p);
  }

  positions(): readonly Position[] {
    return this.position === null ? [] : [this.toPublicPosition(this.position)];
  }

  pendingOrders(): readonly PendingOrder[] {
    return [...this.pendings.values()].map((p) => this.toPublicPending(p));
  }

  getPendingOrder(ticket: number): PendingOrder | null {
    const p = this.pendings.get(ticket);
    return p === undefined ? null : this.toPublicPending(p);
  }

  /**
   * Closed deal history (IBroker.dealHistory) — map the recorded chronological
   * deal log onto the provider-boundary DealRecord shape so the history runtime
   * (HistorySelect/HistoryDealsTotal) can read it. The log is ALREADY in
   * chronological order (deals are pushed as they execute). `entry` mirrors the
   * deal's open/close kind; `order` is 0 — the backtest deal log does not record
   * a distinct order ticket per deal (§21: report 0 rather than fabricate one).
   */
  dealHistory(): readonly DealRecord[] {
    return this.deals.map((d) => ({
      ticket: d.ticket,
      order: 0,
      time: d.time,
      symbol: d.symbol,
      side: d.side,
      entry: d.kind,
      volume: d.volume,
      price: d.price,
      profit: d.profit,
      commission: d.commission,
      swap: d.swap,
      comment: d.comment,
    }));
  }

  private toPublicPending(p: InternalPending): PendingOrder {
    return {
      ticket: p.ticket,
      symbol: p.symbol,
      kind: p.kind,
      volume: p.volume,
      price: p.price,
      stopLimitPrice: p.stopLimitPrice,
      sl: p.sl,
      tp: p.tp,
      placedTime: p.placedTime,
      magic: p.magic,
      comment: p.comment,
    };
  }

  private toPublicPosition(p: InternalPosition): Position {
    const exit = p.side === 'buy' ? this.lastBid : this.lastAsk;
    const profit = this.realisedPL(p.side, p.openPrice, exit, p.volume);
    return {
      ticket: p.ticket,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      openPrice: p.openPrice,
      openTime: p.openTime,
      sl: p.sl,
      tp: p.tp,
      profit,
      swap: p.swap,
      magic: p.magic,
      comment: p.comment,
    };
  }

  account(): AccountInfo {
    const floating = this.floatingPL();
    const equity = this.balance + floating;
    return {
      login: this.login,
      currency: this.currency,
      leverage: this.leverage,
      balance: this.balance,
      equity,
      // Margin model is out of scope for the PoC — explicit zeroes, not faked.
      margin: 0,
      freeMargin: equity,
    };
  }

  /** Current balance (for the simulation's report). */
  getBalance(): number {
    return this.balance;
  }

  /** Current equity at the latest marked prices (for the report). */
  getEquity(): number {
    return this.balance + this.floatingPL();
  }
}
