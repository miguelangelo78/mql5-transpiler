/**
 * OrderSend — MQL5's low-level trade entry, over the IBroker boundary.
 *
 * In MQL5 `bool OrderSend(MqlTradeRequest& request, MqlTradeResult& result)` is
 * the synchronous primitive every higher-level trade call (and CTrade) is built
 * on. On our async providers it becomes `await rt.OrderSend(req, res)`: it
 * dispatches on `request.action`, performs the matching broker op, FILLS the
 * `result` struct IN PLACE (exactly like the MT5 builtin mutates its by-ref
 * out-param), and returns `result.retcode === TRADE_RETCODE_DONE`.
 *
 * Emission ABI: the backend emits `await rt.OrderSend(req, res)` (classified
 * provider='broker', isAsync=true). The runtime method forwards to `orderSend`
 * with its `this.broker`.
 *
 * §21 honesty:
 *   - Pending ops (PENDING/MODIFY/REMOVE) route to the OPTIONAL IBroker pending
 *     methods. On an egress that doesn't implement them, we set a clear failure
 *     retcode (TRADE_RETCODE_INVALID) — never fake success.
 *   - CLOSE_BY has no IBroker primitive yet → honest reject, not a silent no-op.
 *   - `result.bid`/`result.ask` are NOT carried by the provider boundary; we
 *     leave them at 0 rather than fabricating prices.
 */

import type { IBroker, OrderSide, PendingKind, TradeResult } from './providers/types';
import type { MqlTradeRequest, MqlTradeResult } from './mqlStructs';

// ── ENUM_TRADE_REQUEST_ACTIONS (canonical, documented MQL5 values) ──
// OrderSend dispatches on these LOCALLY (internal-only: nothing goes on a wire),
// so the engine is correct for any self-consistent assignment — but we use the
// canonical MT5 values so a transpiled EA that sets `req.action = TRADE_ACTION_*`
// (resolved from constants.ts) matches. The integrator MUST add the same values
// to constants.ts (see handoff).
const TRADE_ACTION_DEAL = 1; // place a market order (immediate execution)
const TRADE_ACTION_PENDING = 5; // place a pending order
const TRADE_ACTION_SLTP = 6; // modify an open position's SL/TP
const TRADE_ACTION_MODIFY = 7; // modify a pending order's params
const TRADE_ACTION_REMOVE = 8; // delete a pending order
const TRADE_ACTION_CLOSE_BY = 10; // close a position by an opposite one

// ── ENUM_ORDER_TYPE (known-correct MQL5 values; mirror constants.ts) ──
const ORDER_TYPE_BUY = 0;
const ORDER_TYPE_SELL = 1;
const ORDER_TYPE_BUY_LIMIT = 2;
const ORDER_TYPE_SELL_LIMIT = 3;
const ORDER_TYPE_BUY_STOP = 4;
const ORDER_TYPE_SELL_STOP = 5;
const ORDER_TYPE_BUY_STOP_LIMIT = 6;
const ORDER_TYPE_SELL_STOP_LIMIT = 7;

const TRADE_RETCODE_DONE = 10009;
// MT5 TRADE_RETCODE_INVALID — the request is rejected as not serviceable here.
const TRADE_RETCODE_INVALID = 10013;

/** Map a market ORDER_TYPE_BUY/SELL to the broker side. null for any other. */
function marketSide(type: number): OrderSide | null {
  if (type === ORDER_TYPE_BUY) return 'buy';
  if (type === ORDER_TYPE_SELL) return 'sell';
  return null;
}

/** Map a pending ORDER_TYPE_* to a PendingKind. null for non-pending types. */
function pendingKind(type: number): PendingKind | null {
  switch (type) {
    case ORDER_TYPE_BUY_LIMIT:
      return 'buyLimit';
    case ORDER_TYPE_SELL_LIMIT:
      return 'sellLimit';
    case ORDER_TYPE_BUY_STOP:
      return 'buyStop';
    case ORDER_TYPE_SELL_STOP:
      return 'sellStop';
    case ORDER_TYPE_BUY_STOP_LIMIT:
      return 'buyStopLimit';
    case ORDER_TYPE_SELL_STOP_LIMIT:
      return 'sellStopLimit';
    default:
      return null;
  }
}

/** Copy a provider TradeResult onto the MQL5 MqlTradeResult, in place. */
function fillResult(result: MqlTradeResult, res: TradeResult): void {
  result.retcode = res.retcode;
  result.deal = res.deal;
  result.order = res.order;
  result.volume = res.volume;
  result.price = res.price;
  result.comment = res.comment;
  // bid/ask/request_id/retcode_external are not carried by the provider
  // boundary; leave them at their zero-init values rather than fabricating (§21).
}

/** Set `result` to a local rejection with the given retcode + comment (no I/O). */
function reject(result: MqlTradeResult, retcode: number, comment: string): boolean {
  result.retcode = retcode;
  result.deal = 0;
  result.order = 0;
  result.volume = 0;
  result.price = 0;
  result.comment = comment;
  return false;
}

/**
 * Execute an OrderSend over the broker. Mutates `result` in place; returns true
 * iff the operation succeeded (retcode === TRADE_RETCODE_DONE).
 */
export async function orderSend(
  broker: IBroker,
  request: MqlTradeRequest,
  result: MqlTradeResult,
): Promise<boolean> {
  switch (request.action) {
    case TRADE_ACTION_DEAL: {
      const side = marketSide(request.type);
      if (side === null) {
        return reject(
          result,
          TRADE_RETCODE_INVALID,
          `OrderSend: TRADE_ACTION_DEAL requires type ORDER_TYPE_BUY/SELL, got ${request.type}`,
        );
      }
      const res = await broker.placeMarketOrder({
        symbol: request.symbol,
        side,
        volume: request.volume,
        // price 0 ⇒ market (per OrderRequest doc). Pass through whatever the
        // request carries; the provider treats 0/undefined as "market".
        price: request.price,
        sl: request.sl,
        tp: request.tp,
        deviation: request.deviation,
        magic: request.magic,
        comment: request.comment,
      });
      fillResult(result, res);
      return result.retcode === TRADE_RETCODE_DONE;
    }

    case TRADE_ACTION_PENDING: {
      const kind = pendingKind(request.type);
      if (kind === null) {
        return reject(
          result,
          TRADE_RETCODE_INVALID,
          `OrderSend: TRADE_ACTION_PENDING requires a pending ORDER_TYPE_*, got ${request.type}`,
        );
      }
      const place = broker.placePendingOrder;
      if (typeof place !== 'function') {
        return reject(
          result,
          TRADE_RETCODE_INVALID,
          'OrderSend: this egress cannot place pending orders',
        );
      }
      const res = await place.call(broker, {
        symbol: request.symbol,
        kind,
        volume: request.volume,
        price: request.price,
        // stop-limit kinds carry a second (limit) price in `stoplimit`.
        stopLimitPrice:
          kind === 'buyStopLimit' || kind === 'sellStopLimit'
            ? request.stoplimit
            : undefined,
        sl: request.sl,
        tp: request.tp,
        magic: request.magic,
        comment: request.comment,
      });
      fillResult(result, res);
      return result.retcode === TRADE_RETCODE_DONE;
    }

    case TRADE_ACTION_SLTP: {
      // Modify the SL/TP of the position on `symbol`. (MT5 keys on `position`
      // ticket; the netting boundary modifies by symbol — symbol is the
      // load-bearing operand here.)
      const res = await broker.modifyPosition(request.symbol, request.sl, request.tp);
      fillResult(result, res);
      return result.retcode === TRADE_RETCODE_DONE;
    }

    case TRADE_ACTION_MODIFY: {
      const modify = broker.modifyPendingOrder;
      if (typeof modify !== 'function') {
        return reject(
          result,
          TRADE_RETCODE_INVALID,
          'OrderSend: this egress cannot modify pending orders',
        );
      }
      const res = await modify.call(
        broker,
        request.order,
        request.price,
        request.sl,
        request.tp,
      );
      fillResult(result, res);
      return result.retcode === TRADE_RETCODE_DONE;
    }

    case TRADE_ACTION_REMOVE: {
      const del = broker.deletePendingOrder;
      if (typeof del !== 'function') {
        return reject(
          result,
          TRADE_RETCODE_INVALID,
          'OrderSend: this egress cannot delete pending orders',
        );
      }
      const res = await del.call(broker, request.order);
      fillResult(result, res);
      return result.retcode === TRADE_RETCODE_DONE;
    }

    case TRADE_ACTION_CLOSE_BY: {
      // No closeBy primitive on the IBroker boundary. Reject honestly rather
      // than silently dropping the request (§21).
      return reject(
        result,
        TRADE_RETCODE_INVALID,
        'OrderSend: TRADE_ACTION_CLOSE_BY is not supported by this egress',
      );
    }

    default:
      return reject(
        result,
        TRADE_RETCODE_INVALID,
        `OrderSend: unsupported action ${request.action}`,
      );
  }
}
