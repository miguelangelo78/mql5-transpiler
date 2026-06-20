/**
 * CTrade — the MT5 Standard-Library trading wrapper (subset).
 *
 * Maps onto the broker provider:
 *   Buy/Sell        → broker.placeMarketOrder({side, volume, ...})
 *   PositionClose   → broker.closePosition(symbol)
 *   PositionModify  → broker.modifyPosition(symbol, sl, tp)
 *
 * Trade methods are async (broker I/O). Setters are sync config. After every
 * trade op the last TradeResult is stored for Result*() accessors, exactly as
 * CTrade caches `m_result` in MT5.
 *
 * Construction (emission ABI): `new rt.CTrade(rt)`. We take the Runtime so the
 * default symbol (`_Symbol`) and broker are reachable.
 */

import type { ICTrade } from './runtime';
import type { Runtime } from './runtime';
import type { IBroker, TradeResult, PendingKind } from './providers/types';

const TRADE_RETCODE_DONE = 10009;
// MT5 TRADE_RETCODE_INVALID — the request is rejected as not supported here.
// Used when the egress can't place/delete pending orders: we surface a clear
// failure rather than faking success (§21).
const TRADE_RETCODE_INVALID = 10013;

/** A neutral "no result yet" TradeResult. */
function emptyResult(): TradeResult {
  return {
    retcode: 0,
    ok: false,
    deal: 0,
    order: 0,
    position: 0,
    price: 0,
    volume: 0,
    comment: '',
  };
}

/**
 * The result reported when the egress can't service a pending-order op (the
 * optional IBroker method is undefined). retcode=INVALID, ok=false → CTrade
 * returns false and Result*() reflect the failure (§21: no faked success).
 */
function unsupportedResult(): TradeResult {
  return {
    retcode: TRADE_RETCODE_INVALID,
    ok: false,
    deal: 0,
    order: 0,
    position: 0,
    price: 0,
    volume: 0,
    comment: 'pending orders not supported by this egress',
  };
}

/** MT5 ENUM_ORDER_TYPE — the two market types PositionOpen accepts. */
const ORDER_TYPE_BUY = 0;
const ORDER_TYPE_SELL = 1;

export class CTrade implements ICTrade {
  private broker: IBroker;
  private defaultSymbol: string;
  private last: TradeResult = emptyResult();

  // config (CTrade m_*)
  private magic = 0;
  private deviation = 0;
  private filling = 0;
  private logLevel = 0;
  // ENUM_ACCOUNT_MARGIN_MODE / async-mode config. Stored so RequestMagic() and
  // the *BySymbol/SetMarginMode/SetAsyncMode setters round-trip; they have no
  // effect on the deterministic backtest matching engine (documented).
  private marginMode = 0;
  private asyncMode = false;

  constructor(rt: Runtime) {
    this.broker = rt.broker;
    this.defaultSymbol = rt._Symbol;
  }

  // ── configuration (sync) ──
  SetExpertMagicNumber(magic: number): void {
    this.magic = magic;
  }
  SetDeviationInPoints(points: number): void {
    this.deviation = points;
  }
  SetTypeFilling(filling: number): void {
    this.filling = filling;
  }
  LogLevel(level: number): void {
    this.logLevel = level;
  }
  /**
   * Set the fill policy from the symbol's allowed filling modes. The provider
   * boundary doesn't expose per-symbol filling flags, so we record the request
   * symbol's existence implicitly: this is config that the backtest matching
   * engine ignores (it fills deterministically). Returns true (the call is
   * accepted) — it never affects backtest fills, which is documented honestly
   * rather than pretending to pick a broker-specific filling mode. (§21)
   */
  SetTypeFillingBySymbol(_symbol: string): boolean {
    // No per-symbol filling info on the boundary → leave `filling` as-is and
    // accept the call. Effect is a no-op on the backtest engine (documented).
    return true;
  }
  /** Set the account margin mode (NETTING/HEDGING/EXCHANGE). Stored; no effect
   *  on the netting backtest engine (documented). */
  SetMarginMode(mode?: number): void {
    // MT5's SetMarginMode() takes no arg and reads ACCOUNT_MARGIN_MODE; some
    // overloads pass it explicitly. Store whatever we get (§29: 0 is valid).
    this.marginMode = mode ?? this.marginMode;
  }
  /** Enable/disable async order sending. Stored; the backtest engine resolves
   *  every order synchronously regardless, so this is config only (documented). */
  SetAsyncMode(async: boolean): void {
    this.asyncMode = async;
  }

  // ── trading (async) ──
  async Buy(
    volume: number,
    symbol?: string,
    price?: number,
    sl?: number,
    tp?: number,
    comment?: string,
  ): Promise<boolean> {
    const res = await this.broker.placeMarketOrder({
      symbol: symbol ?? this.defaultSymbol,
      side: 'buy',
      volume,
      // price 0/undefined ⇒ market (per OrderRequest doc).
      price: price,
      sl: sl,
      tp: tp,
      deviation: this.deviation,
      magic: this.magic,
      comment: comment,
    });
    this.last = res;
    return this.ok(res);
  }

  async Sell(
    volume: number,
    symbol?: string,
    price?: number,
    sl?: number,
    tp?: number,
    comment?: string,
  ): Promise<boolean> {
    const res = await this.broker.placeMarketOrder({
      symbol: symbol ?? this.defaultSymbol,
      side: 'sell',
      volume,
      price: price,
      sl: sl,
      tp: tp,
      deviation: this.deviation,
      magic: this.magic,
      comment: comment,
    });
    this.last = res;
    return this.ok(res);
  }

  /**
   * PositionOpen — open a market position of `orderType` (ORDER_TYPE_BUY/SELL).
   * MT5's signature: PositionOpen(symbol, order_type, volume, price, sl, tp,
   * comment). Maps the order type to a side and routes to placeMarketOrder.
   * Rejects (returns false, no I/O) on a non-market order type rather than
   * guessing a side (§21).
   */
  async PositionOpen(
    symbol: string,
    orderType: number,
    volume: number,
    price?: number,
    sl?: number,
    tp?: number,
    comment?: string,
  ): Promise<boolean> {
    let side: 'buy' | 'sell';
    if (orderType === ORDER_TYPE_BUY) side = 'buy';
    else if (orderType === ORDER_TYPE_SELL) side = 'sell';
    else {
      // Not a market order type → PositionOpen can't service it; fail honestly.
      this.last = {
        ...emptyResult(),
        retcode: TRADE_RETCODE_INVALID,
        comment: `PositionOpen: order type ${orderType} is not ORDER_TYPE_BUY/SELL`,
      };
      return false;
    }
    const res = await this.broker.placeMarketOrder({
      symbol: symbol === '' ? this.defaultSymbol : symbol,
      side,
      volume,
      price,
      sl,
      tp,
      deviation: this.deviation,
      magic: this.magic,
      comment,
    });
    this.last = res;
    return this.ok(res);
  }

  async PositionClose(
    symbolOrTicket: string | number,
    _deviation?: number,
  ): Promise<boolean> {
    // The netting provider closes by symbol. A ticket arg must be resolved to
    // its symbol via the open positions; if absent, fail (don't guess).
    let symbol: string | null = null;
    if (typeof symbolOrTicket === 'string') {
      symbol = symbolOrTicket;
    } else {
      const pos = this.broker
        .positions()
        .find((p) => p.ticket === symbolOrTicket);
      symbol = pos ? pos.symbol : null;
    }
    if (symbol === null) {
      this.last = emptyResult();
      return false;
    }
    const res = await this.broker.closePosition(symbol);
    this.last = res;
    return this.ok(res);
  }

  async PositionModify(
    symbolOrTicket: string | number,
    sl: number,
    tp: number,
  ): Promise<boolean> {
    let symbol: string | null = null;
    if (typeof symbolOrTicket === 'string') {
      symbol = symbolOrTicket;
    } else {
      const pos = this.broker
        .positions()
        .find((p) => p.ticket === symbolOrTicket);
      symbol = pos ? pos.symbol : null;
    }
    if (symbol === null) {
      this.last = emptyResult();
      return false;
    }
    const res = await this.broker.modifyPosition(symbol, sl, tp);
    this.last = res;
    return this.ok(res);
  }

  // ── pending orders (async) ──
  //
  // HONEST GUARD (§21): placePendingOrder / deletePendingOrder are OPTIONAL on
  // IBroker. If the egress doesn't implement them we set a clear failure result
  // (retcode TRADE_RETCODE_INVALID, ok=false) and return false — we NEVER fake
  // success on an egress that cannot place pending orders. The backtest provider
  // implements them; a live egress that hasn't yet wired pending orders fails
  // loudly instead of silently dropping the order.

  /** Place a BUY LIMIT (rest below price; fills when ask falls to `price`). */
  BuyLimit(
    volume: number,
    price: number,
    symbol?: string,
    sl?: number,
    tp?: number,
    comment?: string,
  ): Promise<boolean> {
    return this.placePending('buyLimit', volume, price, symbol, sl, tp, comment);
  }
  /** Place a SELL LIMIT (rest above price; fills when bid rises to `price`). */
  SellLimit(
    volume: number,
    price: number,
    symbol?: string,
    sl?: number,
    tp?: number,
    comment?: string,
  ): Promise<boolean> {
    return this.placePending('sellLimit', volume, price, symbol, sl, tp, comment);
  }
  /** Place a BUY STOP (rest above price; fills when ask rises to `price`). */
  BuyStop(
    volume: number,
    price: number,
    symbol?: string,
    sl?: number,
    tp?: number,
    comment?: string,
  ): Promise<boolean> {
    return this.placePending('buyStop', volume, price, symbol, sl, tp, comment);
  }
  /** Place a SELL STOP (rest below price; fills when bid falls to `price`). */
  SellStop(
    volume: number,
    price: number,
    symbol?: string,
    sl?: number,
    tp?: number,
    comment?: string,
  ): Promise<boolean> {
    return this.placePending('sellStop', volume, price, symbol, sl, tp, comment);
  }

  /** Delete a resting pending order by ticket. */
  async OrderDelete(ticket: number): Promise<boolean> {
    const del = this.broker.deletePendingOrder;
    if (typeof del !== 'function') {
      this.last = unsupportedResult();
      return false;
    }
    const res = await del.call(this.broker, ticket);
    this.last = res;
    return this.ok(res);
  }

  /**
   * OrderModify — modify a RESTING pending order's price/SL/TP by ticket.
   * MT5's signature: OrderModify(ticket, price, sl, tp, type_time, expiration,
   * stoplimit). We modify price/sl/tp via the optional broker.modifyPendingOrder
   * (the type_time/expiration/stoplimit operands aren't carried by the boundary;
   * they're accepted and ignored on the backtest engine, documented). §21 honest
   * guard: fail loudly (retcode 10013) on an egress lacking pending modification.
   */
  async OrderModify(
    ticket: number,
    price: number,
    sl: number,
    tp: number,
    _typeTime?: number,
    _expiration?: number,
    _stoplimit?: number,
  ): Promise<boolean> {
    const modify = this.broker.modifyPendingOrder;
    if (typeof modify !== 'function') {
      this.last = unsupportedResult();
      return false;
    }
    const res = await modify.call(this.broker, ticket, price, sl, tp);
    this.last = res;
    return this.ok(res);
  }

  /** Shared placement path for all four pending kinds + the §21 honest guard. */
  private async placePending(
    kind: PendingKind,
    volume: number,
    price: number,
    symbol: string | undefined,
    sl: number | undefined,
    tp: number | undefined,
    comment: string | undefined,
  ): Promise<boolean> {
    const place = this.broker.placePendingOrder;
    if (typeof place !== 'function') {
      this.last = unsupportedResult();
      return false;
    }
    const res = await place.call(this.broker, {
      symbol: symbol ?? this.defaultSymbol,
      kind,
      volume,
      price,
      sl,
      tp,
      magic: this.magic,
      comment,
    });
    this.last = res;
    return this.ok(res);
  }

  // ── last-result accessors (sync) ──
  ResultRetcode(): number {
    return this.last.retcode;
  }
  ResultRetcodeDescription(): string {
    return retcodeDescription(this.last.retcode);
  }
  ResultDeal(): number {
    return this.last.deal;
  }
  ResultOrder(): number {
    return this.last.order;
  }
  ResultVolume(): number {
    return this.last.volume;
  }
  ResultPrice(): number {
    return this.last.price;
  }
  /**
   * ResultBid/ResultAsk — MT5's m_result.bid/ask. The provider boundary's
   * TradeResult does NOT carry the requote bid/ask, so these are not available
   * here; we return 0 (the MqlTradeResult zero-init) rather than fabricating a
   * price (§21). Documented as not-carried; if the live boundary later supplies
   * them, surface them here.
   */
  ResultBid(): number {
    return 0;
  }
  ResultAsk(): number {
    return 0;
  }
  /** The broker comment on the last result. */
  ResultComment(): string {
    return this.last.comment;
  }
  /**
   * CheckResultRetcode — MT5 caches a separate m_check_result for OrderCheck.
   * CTrade has not run a check (no OrderCheck path on this class yet), so we
   * report the last TRADE result's retcode, which is the closest honest value
   * the boundary carries. (Documented; a real OrderCheck cache can refine this.)
   */
  CheckResultRetcode(): number {
    return this.last.retcode;
  }
  /** The magic number currently configured (MT5 caches m_request.magic). */
  RequestMagic(): number {
    return this.magic;
  }

  /**
   * Whether a result counts as success. CTrade treats DONE (and the
   * DONE_PARTIAL/PLACED family) as success; we key on the provider's `ok`
   * flag if set, else on retcode === DONE. (Both are honoured so a backtest
   * provider that only sets `ok` and a live one that only sets retcode both
   * work.)
   */
  private ok(res: TradeResult): boolean {
    return res.ok || res.retcode === TRADE_RETCODE_DONE;
  }
}

/** Minimal retcode → text. Extend as more retcodes are needed. */
function retcodeDescription(code: number): string {
  switch (code) {
    case 10009:
      return 'TRADE_RETCODE_DONE';
    case 10004:
      return 'TRADE_RETCODE_REQUOTE';
    case 10006:
      return 'TRADE_RETCODE_REJECT';
    case 10013:
      return 'TRADE_RETCODE_INVALID';
    case 0:
      return '';
    default:
      return `TRADE_RETCODE_${code}`;
  }
}
