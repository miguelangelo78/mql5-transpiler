/**
 * TickerallBroker — IBroker over the TickerAll REST API + cached reads.
 *
 * Writes (placeMarketOrder / placePendingOrder / close / modify / pending CRUD)
 * are async REST calls. Reads (getPosition / positions / account / pendingOrders
 * / dealHistory) are SYNCHRONOUS from an in-memory cache the factory seeds and
 * the WebSocket stream keeps fresh (see ./index.ts). This matches the provider
 * boundary's async discipline (only order placement is async).
 *
 * §21 honesty: an unsupported op (stop-limit pending) returns a clear reject
 * TradeResult rather than faking success; a thrown SDK error is mapped to a
 * reject, never swallowed into a fake "done".
 */

import { randomUUID } from 'node:crypto';
import type { Tickerall, PlaceOrderResult } from '@tickerall/sdk';

import type {
  IBroker,
  OrderRequest,
  PendingOrderRequest,
  TradeResult,
  Position,
  PendingOrder,
  AccountInfo,
  DealRecord,
} from '../types';
import { pendingKindToSdk, sideToSdk } from './mapping';

const DONE = 10009; // TRADE_RETCODE_DONE
const REJECT = 10006; // TRADE_RETCODE_REJECT

export class TickerallBroker implements IBroker {
  private positionList: Position[] = [];
  private pendingList: PendingOrder[] = [];
  private deals: DealRecord[] = [];
  private accountSnapshot: AccountInfo | null = null;

  constructor(
    private readonly client: Tickerall,
    private readonly accountId: string,
  ) {}

  // ── cache writers (seeded by the factory; refreshed from the WS stream) ────
  setPositions(positions: Position[]): void { this.positionList = positions; }
  upsertPosition(p: Position): void {
    const i = this.positionList.findIndex((x) => x.ticket === p.ticket);
    if (i >= 0) this.positionList[i] = p;
    else this.positionList.push(p);
  }
  removePosition(ticket: number): void {
    this.positionList = this.positionList.filter((x) => x.ticket !== ticket);
  }
  setPending(pending: PendingOrder[]): void { this.pendingList = pending; }
  setDeals(deals: DealRecord[]): void { this.deals = deals; }
  setAccount(a: AccountInfo): void { this.accountSnapshot = a; }
  patchAccountBalance(balance: number): void {
    if (this.accountSnapshot !== null) this.accountSnapshot.balance = balance;
  }

  private resolveTicket(symbol: string): number | null {
    const p = this.positionList.find((x) => x.symbol === symbol);
    return p ? p.ticket : null;
  }

  private okResult(r: PlaceOrderResult): TradeResult {
    return {
      retcode: DONE,
      ok: true,
      deal: 0,
      order: r.ticket,
      position: r.status === 'open' ? r.ticket : 0,
      price: r.price ?? 0,
      volume: r.volume,
      comment: r.comment ?? '',
    };
  }

  private reject(message: string): TradeResult {
    return { retcode: REJECT, ok: false, deal: 0, order: 0, position: 0, price: 0, volume: 0, comment: message };
  }

  // ── IBroker: writes (async — real REST I/O) ────────────────────────────────

  async placeMarketOrder(req: OrderRequest): Promise<TradeResult> {
    try {
      const r = await this.client.orders.place(
        this.accountId,
        {
          type: 'market',
          symbol: req.symbol,
          side: sideToSdk(req.side),
          volume: req.volume,
          ...(req.sl !== undefined ? { stopLoss: req.sl } : {}),
          ...(req.tp !== undefined ? { takeProfit: req.tp } : {}),
          ...(req.comment !== undefined ? { comment: req.comment } : {}),
        },
        { idempotencyKey: randomUUID() },
      );
      return this.okResult(r);
    } catch (e) {
      return this.reject(e instanceof Error ? e.message : String(e));
    }
  }

  async placePendingOrder(req: PendingOrderRequest): Promise<TradeResult> {
    const mapped = pendingKindToSdk(req.kind);
    if (mapped === null) {
      return this.reject(`TickerAll does not support pending kind '${req.kind}' (no stop-limit)`);
    }
    try {
      const r = await this.client.orders.place(
        this.accountId,
        {
          type: mapped.type,
          symbol: req.symbol,
          side: mapped.side,
          volume: req.volume,
          price: req.price,
          ...(req.sl !== undefined ? { stopLoss: req.sl } : {}),
          ...(req.tp !== undefined ? { takeProfit: req.tp } : {}),
          ...(req.comment !== undefined ? { comment: req.comment } : {}),
        },
        { idempotencyKey: randomUUID() },
      );
      return this.okResult(r);
    } catch (e) {
      return this.reject(e instanceof Error ? e.message : String(e));
    }
  }

  async deletePendingOrder(ticket: number): Promise<TradeResult> {
    try {
      const r = await this.client.orders.cancelPending(this.accountId, ticket, { idempotencyKey: randomUUID() });
      return { retcode: DONE, ok: true, deal: 0, order: r.ticket, position: 0, price: 0, volume: 0, comment: '' };
    } catch (e) {
      return this.reject(e instanceof Error ? e.message : String(e));
    }
  }

  async modifyPendingOrder(ticket: number, price: number, sl: number, tp: number): Promise<TradeResult> {
    try {
      const r = await this.client.orders.modifyPending(
        this.accountId, ticket, { price, stopLoss: sl, takeProfit: tp }, { idempotencyKey: randomUUID() },
      );
      return { retcode: DONE, ok: true, deal: 0, order: r.ticket, position: 0, price: r.price, volume: 0, comment: '' };
    } catch (e) {
      return this.reject(e instanceof Error ? e.message : String(e));
    }
  }

  async modifyPosition(symbol: string, sl: number, tp: number): Promise<TradeResult> {
    const ticket = this.resolveTicket(symbol);
    if (ticket === null) return this.reject(`no position on ${symbol} to modify`);
    try {
      const r = await this.client.positions.modify(
        this.accountId, ticket, { stopLoss: sl, takeProfit: tp }, { idempotencyKey: randomUUID() },
      );
      return { retcode: DONE, ok: true, deal: 0, order: 0, position: r.ticket, price: 0, volume: r.volume, comment: '' };
    } catch (e) {
      return this.reject(e instanceof Error ? e.message : String(e));
    }
  }

  async closePosition(symbol: string, volume?: number): Promise<TradeResult> {
    const ticket = this.resolveTicket(symbol);
    if (ticket === null) return this.reject(`no position on ${symbol} to close`);
    try {
      const r = await this.client.positions.close(
        this.accountId, ticket,
        volume !== undefined ? { volume } : {},
        { idempotencyKey: randomUUID() },
      );
      return { retcode: DONE, ok: true, deal: 0, order: 0, position: r.ticket, price: 0, volume: r.volume, comment: '' };
    } catch (e) {
      return this.reject(e instanceof Error ? e.message : String(e));
    }
  }

  // ── IBroker: reads (sync from cache) ───────────────────────────────────────

  getPosition(symbol: string): Position | null {
    return this.positionList.find((x) => x.symbol === symbol) ?? null;
  }
  positions(): readonly Position[] { return this.positionList; }
  pendingOrders(): readonly PendingOrder[] { return this.pendingList; }
  getPendingOrder(ticket: number): PendingOrder | null {
    return this.pendingList.find((x) => x.ticket === ticket) ?? null;
  }
  dealHistory(): readonly DealRecord[] { return this.deals; }

  account(): AccountInfo {
    return (
      this.accountSnapshot ?? {
        login: 0, currency: 'USD', leverage: 0, balance: 0, equity: 0, margin: 0, freeMargin: 0,
      }
    );
  }
}
