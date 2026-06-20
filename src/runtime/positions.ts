/**
 * MQL5 position-selection state + property accessors.
 *
 * MT5 has an IMPLICIT "selected position" cursor. `PositionSelect(symbol)` /
 * `PositionSelectByTicket(ticket)` set that cursor (returning bool for found);
 * `PositionGetInteger/Double/String(property)` then read a field off the
 * currently-selected position. `PositionsTotal` / `PositionGetSymbol(index)`
 * iterate the open positions (and PositionGetSymbol ALSO selects that position,
 * matching MT5).
 *
 * The netting model (providers/types.ts) holds at most one position per symbol.
 *
 * Property selectors are looked up by the VERIFIED MQL_CONST ids (constants.ts,
 * confirmed against the MT5 compiler). We dispatch on those ids so the
 * transpiled program's `PositionGetInteger(rt.POSITION_TYPE)` resolves the
 * right field.
 */

import type { IBroker, Position } from './providers/types';
import type { MqlConst } from './constants';

export class PositionState {
  private selected: Position | null = null;

  constructor(
    private readonly broker: IBroker,
    private readonly C: MqlConst,
  ) {}

  /** PositionSelect — select the netting position on `symbol`. */
  select(symbol: string): boolean {
    const pos = this.broker.getPosition(symbol);
    this.selected = pos; // null clears selection on miss (MT5 keeps prior, but
    // a failed select must report false; reads after a false select are UB in
    // MQL5 — we clear to fail loudly rather than read a stale position).
    return pos !== null;
  }

  /** PositionSelectByTicket — select by ticket across all open positions. */
  selectByTicket(ticket: number): boolean {
    const pos = this.broker.positions().find((p) => p.ticket === ticket) ?? null;
    this.selected = pos;
    return pos !== null;
  }

  /** PositionsTotal — number of open positions. */
  total(): number {
    return this.broker.positions().length;
  }

  /**
   * PositionGetSymbol(index) — symbol of the position at `index`, AND selects
   * it (MT5 does select-by-index here so subsequent PositionGet* work).
   * Returns "" on out-of-range.
   */
  getSymbol(index: number): string {
    const all = this.broker.positions();
    if (index < 0 || index >= all.length) return '';
    const pos = all[index]!;
    this.selected = pos;
    return pos.symbol;
  }

  /** PositionGetInteger(property) — read an integer field of the selection. */
  getInteger(property: number): number {
    const p = this.selected;
    if (!p) return 0;
    const C = this.C;
    switch (property) {
      case C.POSITION_TICKET:
        return p.ticket;
      case C.POSITION_TYPE:
        // ENUM_POSITION_TYPE: BUY=0, SELL=1 (matches Position.side).
        return p.side === 'buy' ? C.POSITION_TYPE_BUY : C.POSITION_TYPE_SELL;
      case C.POSITION_MAGIC:
        return p.magic;
      case C.POSITION_TIME:
        return p.openTime;
      case C.POSITION_IDENTIFIER:
        // No separate identifier in the provider model; MT5's identifier equals
        // the position ticket for single-fill positions. Return the ticket.
        return p.ticket;
      default:
        throw new Error(
          `PositionGetInteger: unsupported property id ${property}`,
        );
    }
  }

  /** PositionGetDouble(property) — read a double field of the selection. */
  getDouble(property: number): number {
    const p = this.selected;
    if (!p) return 0;
    const C = this.C;
    switch (property) {
      case C.POSITION_VOLUME:
        return p.volume;
      case C.POSITION_PRICE_OPEN:
        return p.openPrice;
      case C.POSITION_SL:
        return p.sl;
      case C.POSITION_TP:
        return p.tp;
      case C.POSITION_PROFIT:
        return p.profit;
      case C.POSITION_SWAP:
        return p.swap;
      case C.POSITION_PRICE_CURRENT:
        // Current price isn't carried on Position; the broker would supply it
        // live. The provider model exposes open price + floating profit but not
        // the mark price. Rule 21: don't fabricate it — surface as unsupported.
        throw new Error(
          'PositionGetDouble(POSITION_PRICE_CURRENT): not exposed by the ' +
            'provider boundary; needs feed.tick — wire via SymbolInfoTick.',
        );
      default:
        throw new Error(
          `PositionGetDouble: unsupported property id ${property}`,
        );
    }
  }

  /** PositionGetString(property) — read a string field of the selection. */
  getString(property: number): string {
    const p = this.selected;
    if (!p) return '';
    const C = this.C;
    switch (property) {
      case C.POSITION_SYMBOL:
        return p.symbol;
      case C.POSITION_COMMENT:
        return p.comment;
      default:
        throw new Error(
          `PositionGetString: unsupported property id ${property}`,
        );
    }
  }

  /** Test/engine helper: the currently selected position (or null). */
  current(): Position | null {
    return this.selected;
  }
}
