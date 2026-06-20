/**
 * CPositionInfo — the MT5 Standard-Library position-info wrapper (subset).
 *
 * MetaQuotes' `CPositionInfo` (Include/Trade/PositionInfo.mqh) is a thin OO
 * facade over MQL5's implicit selected-position state + the PositionGet*
 * builtins:
 *
 *   SelectByTicket(ticket) → PositionSelectByTicket(ticket)
 *   Select(symbol)         → PositionSelect(symbol)
 *   Symbol()/PositionType()/Volume()/PriceOpen()/StopLoss()/TakeProfit()/
 *   Profit()/Magic()/Comment()/Ticket()
 *                          → PositionGetString/Integer/Double(<PROPERTY>)
 *
 * §21 fidelity: this wrapper performs NO calculation of its own — every accessor
 * delegates to the runtime builtin that already replicates MT5's behaviour over
 * the provider boundary. So the wrapper inherits the runtime's exactness (and
 * its honest limitations) verbatim; it adds only the OO sugar MQL5 programs use.
 *
 * Construction (emission ABI): `new rt.CPositionInfo(rt)` — a bare MQL5
 * declaration `CPositionInfo pos;` is a value object, default-constructed with
 * the runtime so its accessors reach the selected-position state. (Matches how
 * CTrade is constructed `new rt.CTrade(rt)`.)
 *
 * MT5 select semantics: Select / SelectByTicket set the implicit selected
 * position (returning bool for found). The accessors then read off that
 * selection, EXACTLY like calling PositionGet* directly after a PositionSelect.
 * (CPositionInfo in MetaQuotes additionally caches fields into m_* on a
 * StoreState/CheckState pair; we read live each call, which is observationally
 * identical for the common Select-then-read usage and avoids a stale cache.)
 */

import type { Runtime } from '../runtime';

export class CPositionInfo {
  constructor(private readonly rt: Runtime) {}

  /** Select the position with `ticket` (across all open positions). bool found. */
  SelectByTicket(ticket: number): boolean {
    return this.rt.PositionSelectByTicket(ticket);
  }

  /** Select the netting position on `symbol`. bool found. */
  Select(symbol: string): boolean {
    return this.rt.PositionSelect(symbol);
  }

  // ── property accessors (read the currently-selected position) ──

  /** POSITION_SYMBOL. */
  Symbol(): string {
    return this.rt.PositionGetString(this.rt.POSITION_SYMBOL);
  }
  /** POSITION_TYPE (ENUM_POSITION_TYPE: 0=BUY, 1=SELL). */
  PositionType(): number {
    return this.rt.PositionGetInteger(this.rt.POSITION_TYPE);
  }
  /** POSITION_VOLUME (lots). */
  Volume(): number {
    return this.rt.PositionGetDouble(this.rt.POSITION_VOLUME);
  }
  /** POSITION_PRICE_OPEN. */
  PriceOpen(): number {
    return this.rt.PositionGetDouble(this.rt.POSITION_PRICE_OPEN);
  }
  /** POSITION_SL (Stop-Loss; 0 = none — §29, a real value). */
  StopLoss(): number {
    return this.rt.PositionGetDouble(this.rt.POSITION_SL);
  }
  /** POSITION_TP (Take-Profit; 0 = none — §29). */
  TakeProfit(): number {
    return this.rt.PositionGetDouble(this.rt.POSITION_TP);
  }
  /** POSITION_PROFIT (floating P/L in account currency). */
  Profit(): number {
    return this.rt.PositionGetDouble(this.rt.POSITION_PROFIT);
  }
  /** POSITION_SWAP (accumulated swap). */
  Swap(): number {
    return this.rt.PositionGetDouble(this.rt.POSITION_SWAP);
  }
  /** POSITION_MAGIC (the EA magic number stamped on the position). */
  Magic(): number {
    return this.rt.PositionGetInteger(this.rt.POSITION_MAGIC);
  }
  /** POSITION_COMMENT. */
  Comment(): string {
    return this.rt.PositionGetString(this.rt.POSITION_COMMENT);
  }
  /** POSITION_TICKET (the selected position's ticket). */
  Ticket(): number {
    return this.rt.PositionGetInteger(this.rt.POSITION_TICKET);
  }
  /** POSITION_TIME (open time, epoch seconds). */
  Time(): number {
    return this.rt.PositionGetInteger(this.rt.POSITION_TIME);
  }
}
