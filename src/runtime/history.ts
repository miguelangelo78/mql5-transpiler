/**
 * MQL5 trade-history (closed deals) selection state + accessors.
 *
 * MT5's history pool is a SELECTED WINDOW: `HistorySelect(from, to)` loads all
 * deals (and orders) whose time falls in `[from, to]` into an implicit cursor;
 * `HistoryDealsTotal()` then returns how many deals are in that window;
 * `HistoryDealGetTicket(index)` / `HistoryDealGet*` read the indexed deal.
 *
 * Window semantics (§21 — replicate MT5 exactly): the bounds are INCLUSIVE on
 * both ends — a deal whose execution time equals `from` or `to` is in the
 * window. The selection is a SNAPSHOT taken at HistorySelect time: it reads the
 * broker's deal log once and freezes the filtered list, so later deals don't
 * change an already-selected window until the EA re-selects (this matches MT5,
 * where HistoryDealsTotal reflects the last HistorySelect, not live state).
 *
 * Honesty (§21): an egress that does NOT record a deal log (IBroker.dealHistory
 * is absent — e.g. the live provider for now) yields an EMPTY window. We do NOT
 * fabricate history; HistoryDealsTotal honestly returns 0 there. The backtest
 * provider implements dealHistory() from its recorded deals.
 *
 * ── Deal-property selector ids (§21) ────────────────────────────────────────
 * The HISTORY_DEAL_* selector ids are NOT in constants.ts (not owned here). Like
 * the POSITION_ and ORDER_ selector ids they are INTERNAL-ONLY dispatch keys (the getters
 * switch on a NAMED enum; nothing is sent on a wire), so any self-consistent,
 * collision-free assignment is correct for the PoC. The integrator maps the MQL
 * `DEAL_*` constant NAMES onto the `DealProp` enum below.
 *
 * The MAPPING (MQL DEAL_* name → local id), documented for the integrator:
 *   integers: DEAL_TICKET, DEAL_ORDER, DEAL_TIME, DEAL_TYPE, DEAL_ENTRY
 *   doubles:  DEAL_VOLUME, DEAL_PRICE, DEAL_PROFIT, DEAL_COMMISSION, DEAL_SWAP
 *   strings:  DEAL_SYMBOL, DEAL_COMMENT
 *
 * ENUM_DEAL_TYPE / ENUM_DEAL_ENTRY (§21 — known-correct documented values):
 *   DEAL_TYPE_BUY=0, DEAL_TYPE_SELL=1.
 *   DEAL_ENTRY_IN=0 (open leg), DEAL_ENTRY_OUT=1 (close leg).
 */

import type { IBroker, DealRecord } from './providers/types';

/**
 * Local selector ids for deal properties. INTERNAL ONLY (see file header) —
 * collision-free across integer/double/string kinds. The integrator points the
 * MQL `DEAL_*` constant NAMES at these numbers.
 */
export enum DealProp {
  // integers
  DEAL_TICKET = 1,
  DEAL_ORDER = 2,
  DEAL_TIME = 3,
  DEAL_TYPE = 4,
  DEAL_ENTRY = 5,
  // doubles
  DEAL_VOLUME = 20,
  DEAL_PRICE = 21,
  DEAL_PROFIT = 22,
  DEAL_COMMISSION = 23,
  DEAL_SWAP = 24,
  // strings
  DEAL_SYMBOL = 40,
  DEAL_COMMENT = 41,
}

/** ENUM_DEAL_TYPE (§21 known-correct): buy=0, sell=1. */
const DEAL_TYPE_BUY = 0;
const DEAL_TYPE_SELL = 1;
/** ENUM_DEAL_ENTRY (§21 known-correct): IN (open)=0, OUT (close)=1. */
const DEAL_ENTRY_IN = 0;
const DEAL_ENTRY_OUT = 1;

/**
 * The history-selection state. Holds the currently-selected window of deals
 * (the snapshot taken at HistorySelect time).
 */
export class HistoryState {
  /** The deals selected by the last HistorySelect, in chronological order. */
  private selectedDeals: DealRecord[] = [];

  constructor(private readonly broker: IBroker) {}

  /** Whether the egress records a deal log at all (§21 honesty). */
  private supportsHistory(): boolean {
    return typeof this.broker.dealHistory === 'function';
  }

  private allDeals(): readonly DealRecord[] {
    return this.supportsHistory() ? this.broker.dealHistory!() : [];
  }

  /**
   * HistorySelect(from, to) — select deals whose time ∈ [from, to] INCLUSIVE.
   * Returns true (MT5 returns false only on an internal error; a window with no
   * deals is a SUCCESSFUL select of an empty set — §29: an empty result is not a
   * failure). Snapshots the filtered list so the window is stable until re-select.
   */
  select(from: number, to: number): boolean {
    // Guard a reversed window honestly: MT5 treats from>to as an empty window
    // rather than an error (it simply selects nothing). We mirror that.
    this.selectedDeals = this.allDeals().filter(
      (d) => d.time >= from && d.time <= to,
    );
    return true;
  }

  /** HistoryDealsTotal() — number of deals in the selected window. */
  dealsTotal(): number {
    return this.selectedDeals.length;
  }

  /**
   * HistoryDealGetTicket(index) — ticket of the deal at `index` in the selected
   * window, or 0 on out-of-range (MT5 returns 0 = invalid ticket). NOTE: not yet
   * in the intrinsic table — exposed for the integrator to wire when the name is
   * added; the runtime glue calls it.
   */
  dealGetTicket(index: number): number {
    if (index < 0 || index >= this.selectedDeals.length) return 0;
    return this.selectedDeals[index]!.ticket;
  }

  /**
   * Resolve a deal by ITS TICKET (MT5's HistoryDealGetInteger(ticket, prop) keys
   * by deal ticket, not window index). Returns null if not in the selected
   * window. The getters below accept a ticket to mirror MT5's signature exactly.
   */
  private byTicket(ticket: number): DealRecord | null {
    return this.selectedDeals.find((d) => d.ticket === ticket) ?? null;
  }

  /** HistoryDealGetInteger(ticket, property). 0 when the deal isn't selected. */
  dealGetInteger(ticket: number, property: number): number {
    const d = this.byTicket(ticket);
    if (d === null) return 0;
    switch (property) {
      case DealProp.DEAL_TICKET:
        return d.ticket;
      case DealProp.DEAL_ORDER:
        return d.order;
      case DealProp.DEAL_TIME:
        return d.time;
      case DealProp.DEAL_TYPE:
        return d.side === 'buy' ? DEAL_TYPE_BUY : DEAL_TYPE_SELL;
      case DealProp.DEAL_ENTRY:
        return d.entry === 'open' ? DEAL_ENTRY_IN : DEAL_ENTRY_OUT;
      default:
        throw new Error(`HistoryDealGetInteger: unsupported property id ${property}`);
    }
  }

  /** HistoryDealGetDouble(ticket, property). 0 when the deal isn't selected. */
  dealGetDouble(ticket: number, property: number): number {
    const d = this.byTicket(ticket);
    if (d === null) return 0;
    switch (property) {
      case DealProp.DEAL_VOLUME:
        return d.volume;
      case DealProp.DEAL_PRICE:
        return d.price;
      case DealProp.DEAL_PROFIT:
        return d.profit;
      case DealProp.DEAL_COMMISSION:
        return d.commission;
      case DealProp.DEAL_SWAP:
        return d.swap;
      default:
        throw new Error(`HistoryDealGetDouble: unsupported property id ${property}`);
    }
  }

  /** HistoryDealGetString(ticket, property). '' when the deal isn't selected. */
  dealGetString(ticket: number, property: number): string {
    const d = this.byTicket(ticket);
    if (d === null) return '';
    switch (property) {
      case DealProp.DEAL_SYMBOL:
        return d.symbol;
      case DealProp.DEAL_COMMENT:
        return d.comment;
      default:
        throw new Error(`HistoryDealGetString: unsupported property id ${property}`);
    }
  }

  /** Test/engine helper: the currently selected deal window (chronological). */
  selected(): readonly DealRecord[] {
    return this.selectedDeals;
  }
}
