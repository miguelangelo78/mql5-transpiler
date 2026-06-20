/**
 * MQL5 trade-API structs as plain runtime classes.
 *
 * MQL5's low-level trade API (`OrderSend`, `OrderCheck`) passes data through
 * value structs: `MqlTradeRequest`, `MqlTradeResult`, `MqlTradeCheckResult`,
 * `MqlTradeTransaction`. In MQL5 a bare declaration `MqlTradeRequest req;`
 * zero-initialises every field; the backend emits that as
 * `const req = new rt.MqlTradeRequest();` (NO `rt` arg, unlike CTrade) and then
 * field assignment / reads are plain TS property access (`req.action = X`,
 * `res.retcode`). So these are plain classes whose constructor zero/empty-inits
 * every MQL5 field, with FIELD NAMES EXACTLY MATCHING MT5 (lower-case /
 * underscore as MT5 declares them) — the emitter copies the field names through
 * verbatim, so any divergence here would silently break a transpiled EA.
 *
 * Field references (MT5 MqlTradeRequest / MqlTradeResult / MqlTradeCheckResult /
 * MqlTradeTransaction documentation). Numeric fields default to 0, strings to ''
 * — §29: 0 is a legitimate value, these are MT5's documented "freshly declared
 * struct" defaults, not a sentinel.
 */

/**
 * MqlTradeRequest — the trade request structure passed to OrderSend/OrderCheck.
 * The caller fills the relevant fields (action + the per-action operands) before
 * sending; OrderSend dispatches on `action`.
 */
export class MqlTradeRequest {
  /** ENUM_TRADE_REQUEST_ACTIONS — the trade operation type (TRADE_ACTION_*). */
  action = 0;
  /** Expert Advisor id (magic number) stamped on the resulting order/position. */
  magic = 0;
  /** Order ticket — the pending order to act on (MODIFY/REMOVE). */
  order = 0;
  /** Trade symbol. */
  symbol = '';
  /** Requested volume in lots. */
  volume = 0;
  /** Price (market: deal price / pending: activation price). */
  price = 0;
  /** Stop-limit order's second (limit) price, armed once the stop triggers. */
  stoplimit = 0;
  /** Stop-Loss price. */
  sl = 0;
  /** Take-Profit price. */
  tp = 0;
  /** Maximum acceptable deviation from `price`, in points. */
  deviation = 0;
  /** ENUM_ORDER_TYPE — the order type (ORDER_TYPE_*). */
  type = 0;
  /** ENUM_ORDER_TYPE_FILLING — the fill policy. */
  type_filling = 0;
  /** ENUM_ORDER_TYPE_TIME — the order lifetime policy. */
  type_time = 0;
  /** Pending-order expiration time (datetime, epoch seconds). */
  expiration = 0;
  /** Order comment. */
  comment = '';
  /** Position ticket (used when modifying/closing a specific position). */
  position = 0;
  /** Opposite position ticket for a CLOSE_BY operation. */
  position_by = 0;
}

/**
 * MqlTradeResult — the result structure OrderSend/OrderCheck mutate IN PLACE.
 * `retcode` 10009 = TRADE_RETCODE_DONE. (`bid`/`ask` are part of MT5's struct
 * but are not carried across the provider boundary; OrderSend leaves them at 0 —
 * see orderSend.ts — rather than fabricating prices, §21.)
 */
export class MqlTradeResult {
  /** Operation return code (TRADE_RETCODE_*; 10009 = DONE). */
  retcode = 0;
  /** Deal ticket, if a deal was performed. */
  deal = 0;
  /** Order ticket, if an order was placed. */
  order = 0;
  /** Deal volume confirmed by the broker. */
  volume = 0;
  /** Deal price confirmed by the broker. */
  price = 0;
  /** Current bid (not carried by the provider boundary; stays 0). */
  bid = 0;
  /** Current ask (not carried by the provider boundary; stays 0). */
  ask = 0;
  /** Broker comment on the operation. */
  comment = '';
  /** Request id set by the terminal when sending. */
  request_id = 0;
  /** External-system return code. */
  retcode_external = 0;
}

/**
 * MqlTradeCheckResult — the result of OrderCheck (a request validation that
 * never sends). Carries the margin/balance projection MT5 computes for the
 * request. Zero-initialised; OrderCheck fills `retcode` (and, where the boundary
 * permits, the projections).
 */
export class MqlTradeCheckResult {
  /** Return code of the check (TRADE_RETCODE_*). */
  retcode = 0;
  /** Account balance after the deal would execute. */
  balance = 0;
  /** Account equity after the deal would execute. */
  equity = 0;
  /** Floating profit after the deal. */
  profit = 0;
  /** Margin required for the deal. */
  margin = 0;
  /** Free margin remaining after the deal. */
  margin_free = 0;
  /** Margin level after the deal, in percent. */
  margin_level = 0;
  /** Check comment. */
  comment = '';
}

/**
 * MqlTradeTransaction — a trade-transaction event payload (delivered to
 * OnTradeTransaction). Zero-initialised; the engine fills it when it dispatches
 * a transaction. FIELD NAMES match MT5's struct.
 */
export class MqlTradeTransaction {
  /** Deal ticket. */
  deal = 0;
  /** Order ticket. */
  order = 0;
  /** Trade symbol. */
  symbol = '';
  /** ENUM_TRADE_TRANSACTION_TYPE — the transaction type. */
  type = 0;
  /** ENUM_ORDER_TYPE — the order type. */
  order_type = 0;
  /** ENUM_ORDER_STATE — the order state. */
  order_state = 0;
  /** ENUM_DEAL_TYPE — the deal type. */
  deal_type = 0;
  /** ENUM_ORDER_TYPE_TIME — the order lifetime type. */
  time_type = 0;
  /** Pending-order expiration time. */
  time_expiration = 0;
  /** Price. */
  price = 0;
  /** Stop-limit order's trigger price. */
  price_trigger = 0;
  /** Stop-Loss price. */
  price_sl = 0;
  /** Take-Profit price. */
  price_tp = 0;
  /** Volume in lots. */
  volume = 0;
  /** Position ticket. */
  position = 0;
  /** Opposite position ticket (CLOSE_BY). */
  position_by = 0;
}
