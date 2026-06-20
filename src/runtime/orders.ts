/**
 * MQL5 pending-order pool + position-ticket iteration state + property accessors.
 *
 * MT5 has an IMPLICIT "selected order" cursor for the PENDING-order pool, exactly
 * mirroring the position cursor (see ./positions.ts). The trading-pool functions:
 *
 *   OrdersTotal()                  → number of resting pending orders.
 *   OrderGetTicket(index)          → ticket of the pending order at `index`, AND
 *                                    selects it (MT5 selects-by-index here, so a
 *                                    subsequent OrderGet* reads that order). This
 *                                    matches PositionGetSymbol's select-on-index.
 *   OrderSelect(ticket)            → select a pending order by ticket; bool found.
 *   OrderGetInteger/Double/String  → read a field off the selected pending order
 *                                    by the ORDER_* selector id.
 *
 * And the position-pool iterator the EA uses alongside PositionsTotal:
 *
 *   PositionGetTicket(index)       → ticket of the open position at `index`. (MT5
 *                                    also SELECTS that position; but the selected-
 *                                    position cursor lives in PositionState, so we
 *                                    delegate the select+ticket there — see the
 *                                    runtime glue. This module only owns the
 *                                    pending-order cursor; PositionGetTicket is a
 *                                    thin read over broker.positions().)
 *
 * ── Selector ids (§21 honesty) ──────────────────────────────────────────────
 * The ORDER_* selector ids are NOT in constants.ts (which this module does not
 * own). They are INTERNAL-ONLY dispatch keys — OrderGetInteger/Double/String
 * switch on a NAMED enum, nothing is sent on a wire — so any self-consistent,
 * collision-free assignment is correct for the PoC, exactly as the existing
 * POSITION_ and ACCOUNT_ selector ids are (constants.ts file header). The
 * integrator maps the MQL `ORDER_*` constant NAMES onto these ids when wiring
 * the runtime; the enum below is the single place those mappings live until the
 * ground-truth values are observed (see constants.ts).
 *
 * The MAPPING the runtime exposes (MQL ORDER_* name → local id) — documented so
 * the integrator can wire constants.ts entries pointing at these:
 *
 *   integers:  ORDER_TICKET, ORDER_TIME_SETUP, ORDER_TYPE, ORDER_MAGIC,
 *              ORDER_STATE, ORDER_TYPE_TIME, ORDER_POSITION_ID
 *   doubles:   ORDER_VOLUME_INITIAL, ORDER_VOLUME_CURRENT, ORDER_PRICE_OPEN,
 *              ORDER_SL, ORDER_TP, ORDER_PRICE_STOPLIMIT, ORDER_PRICE_CURRENT
 *   strings:   ORDER_SYMBOL, ORDER_COMMENT
 *
 * ── ENUM_ORDER_TYPE mapping (§21, known-correct values) ─────────────────────
 * OrderGetInteger(ORDER_TYPE) must return the MQL5 ENUM_ORDER_TYPE value. The
 * provider's PendingKind is language-neutral; we map it to the documented
 * ENUM_ORDER_TYPE_* integers (constants.ts: BUY_LIMIT=2 … SELL_STOP_LIMIT=7) so
 * the EA's `OrderGetInteger(ORDER_TYPE)==ORDER_TYPE_BUY_LIMIT` resolves
 * correctly. Those values ARE ground-truth-known (constants.ts marks the
 * ENUM_ORDER_TYPE block "known-correct"), so we replicate them here rather than
 * inventing a separate numbering.
 */

import type { IBroker, PendingOrder, PendingKind } from './providers/types';

/**
 * Local selector ids for the pending-order properties. INTERNAL ONLY (see file
 * header) — collision-free across all three property kinds so a single switch
 * couldn't confuse an integer id for a double/string id. The integrator points
 * the MQL `ORDER_*` constant NAMES at these numbers.
 */
export enum OrderProp {
  // integers
  ORDER_TICKET = 1,
  ORDER_TIME_SETUP = 2,
  ORDER_TYPE = 3,
  ORDER_MAGIC = 4,
  ORDER_STATE = 5,
  ORDER_TYPE_TIME = 6,
  ORDER_POSITION_ID = 7,
  // doubles
  ORDER_VOLUME_INITIAL = 20,
  ORDER_VOLUME_CURRENT = 21,
  ORDER_PRICE_OPEN = 22,
  ORDER_SL = 23,
  ORDER_TP = 24,
  ORDER_PRICE_STOPLIMIT = 25,
  ORDER_PRICE_CURRENT = 26,
  // strings
  ORDER_SYMBOL = 40,
  ORDER_COMMENT = 41,
}

/**
 * ENUM_ORDER_TYPE values (§21 — these are the constants.ts known-correct
 * documented values, replicated so OrderGetInteger(ORDER_TYPE) matches the EA's
 * comparisons against ORDER_TYPE_BUY_LIMIT etc.).
 */
const ORDER_TYPE_BY_KIND: Record<PendingKind, number> = {
  buyLimit: 2, // ORDER_TYPE_BUY_LIMIT
  sellLimit: 3, // ORDER_TYPE_SELL_LIMIT
  buyStop: 4, // ORDER_TYPE_BUY_STOP
  sellStop: 5, // ORDER_TYPE_SELL_STOP
  buyStopLimit: 6, // ORDER_TYPE_BUY_STOP_LIMIT
  sellStopLimit: 7, // ORDER_TYPE_SELL_STOP_LIMIT
};

/** ENUM_ORDER_STATE: a resting pending order is ORDER_STATE_PLACED. */
const ORDER_STATE_PLACED = 1;
/** ENUM_ORDER_TYPE_TIME: PoC pendings are GTC (good-till-cancelled). */
const ORDER_TIME_GTC = 0;

/**
 * The pending-order selection state. Mirrors PositionState's selected-cursor
 * design exactly (./positions.ts): a cursor set by OrderGetTicket(index) /
 * OrderSelect(ticket); reads dispatch on the selected order.
 */
export class OrderState {
  private selected: PendingOrder | null = null;

  constructor(private readonly broker: IBroker) {}

  /** Whether the egress exposes the pending-order pool at all (§21 honesty). */
  private supportsPending(): boolean {
    return typeof this.broker.pendingOrders === 'function';
  }

  /** The resting pending orders, or [] if the egress lacks pending support. */
  private allPending(): readonly PendingOrder[] {
    return this.supportsPending() ? this.broker.pendingOrders!() : [];
  }

  /**
   * OrdersTotal() — number of resting pending orders. (MT5's OrdersTotal counts
   * the TRADING pool = pending orders, NOT open positions; PositionsTotal counts
   * positions.) An egress without pending support honestly reports 0.
   */
  total(): number {
    return this.allPending().length;
  }

  /**
   * OrderGetTicket(index) — ticket of the pending order at `index`, AND selects
   * it (MT5 selects-by-index so a following OrderGet* reads it). Returns 0 on
   * out-of-range (MT5 returns 0 = an invalid ticket; the caller checks for it).
   */
  getTicket(index: number): number {
    const all = this.allPending();
    if (index < 0 || index >= all.length) {
      this.selected = null;
      return 0;
    }
    const ord = all[index]!;
    this.selected = ord;
    return ord.ticket;
  }

  /** OrderSelect(ticket) — select a pending order by ticket; bool found. */
  select(ticket: number): boolean {
    const ord = this.allPending().find((o) => o.ticket === ticket) ?? null;
    this.selected = ord;
    return ord !== null;
  }

  /** OrderGetInteger(property) — read an integer field of the selection. */
  getInteger(property: number): number {
    const o = this.selected;
    if (o === null) return 0;
    switch (property) {
      case OrderProp.ORDER_TICKET:
        return o.ticket;
      case OrderProp.ORDER_TIME_SETUP:
        return o.placedTime;
      case OrderProp.ORDER_TYPE:
        return ORDER_TYPE_BY_KIND[o.kind];
      case OrderProp.ORDER_MAGIC:
        return o.magic;
      case OrderProp.ORDER_STATE:
        return ORDER_STATE_PLACED;
      case OrderProp.ORDER_TYPE_TIME:
        return ORDER_TIME_GTC;
      case OrderProp.ORDER_POSITION_ID:
        // A resting pending order has not produced a position yet (MT5 reports 0
        // until it fills). §29: 0 here is the real "no position id" value.
        return 0;
      default:
        throw new Error(`OrderGetInteger: unsupported property id ${property}`);
    }
  }

  /** OrderGetDouble(property) — read a double field of the selection. */
  getDouble(property: number): number {
    const o = this.selected;
    if (o === null) return 0;
    switch (property) {
      case OrderProp.ORDER_VOLUME_INITIAL:
      case OrderProp.ORDER_VOLUME_CURRENT:
        // No partial fills on a resting pending; initial == current volume.
        return o.volume;
      case OrderProp.ORDER_PRICE_OPEN:
        return o.price;
      case OrderProp.ORDER_SL:
        return o.sl;
      case OrderProp.ORDER_TP:
        return o.tp;
      case OrderProp.ORDER_PRICE_STOPLIMIT:
        // §29: 0 is a VALID "no stop-limit second price" — a non-stop-limit
        // pending genuinely has none. Distinguish absent (undefined) from a real
        // 0 by returning 0 only when the field is absent; a stop-limit always
        // carries a positive price here.
        return o.stopLimitPrice ?? 0;
      case OrderProp.ORDER_PRICE_CURRENT:
        // The current market price of the order's symbol is not carried on the
        // PendingOrder shape; the provider boundary exposes it via the feed, not
        // the order. §21: don't fabricate it — surface as unsupported so a richer
        // wiring (feed.tick) is added deliberately rather than guessed.
        throw new Error(
          'OrderGetDouble(ORDER_PRICE_CURRENT): not carried on the pending-order ' +
            'shape; needs feed.tick — wire via SymbolInfoTick.',
        );
      default:
        throw new Error(`OrderGetDouble: unsupported property id ${property}`);
    }
  }

  /** OrderGetString(property) — read a string field of the selection. */
  getString(property: number): string {
    const o = this.selected;
    if (o === null) return '';
    switch (property) {
      case OrderProp.ORDER_SYMBOL:
        return o.symbol;
      case OrderProp.ORDER_COMMENT:
        return o.comment;
      default:
        throw new Error(`OrderGetString: unsupported property id ${property}`);
    }
  }

  /** Test/engine helper: the currently selected pending order (or null). */
  current(): PendingOrder | null {
    return this.selected;
  }
}

/**
 * PositionGetTicket(index) — ticket of the open position at `index`, or 0 on
 * out-of-range. MT5 ALSO selects that position; the selected-position cursor is
 * owned by PositionState (./positions.ts), so the runtime glue threads the
 * select there (PositionState.getSymbol already select-by-index; this helper is
 * the ticket-returning sibling). Kept as a free helper so the runtime can call
 * it without giving OrderState a position cursor it doesn't own.
 */
export function positionGetTicket(broker: IBroker, index: number): number {
  const all = broker.positions();
  if (index < 0 || index >= all.length) return 0;
  return all[index]!.ticket;
}
