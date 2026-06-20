/**
 * TickerAll live egress — the public, hosted broker connection.
 *
 * `createTickerallProviders(config)` connects a broker account through the
 * TickerAll REST + WebSocket API (@tickerall/sdk, public on npm), pre-fetches
 * candle history + symbol specs + open positions, subscribes to the live tick /
 * position / account streams, and returns the `Providers` bundle the engine
 * runs an EA against — plus `refresh()` (re-pull positions/account/pending/
 * history) and `disconnect()`.
 *
 * The SAME transpiled EA runs here as in backtest: it only ever touches
 * IBroker / IMarketFeed / IClock. This is broker-egress #2 (hosted); it needs a
 * TickerAll API key + broker credentials, and nothing private — so a public
 * checkout can run live with a free TickerAll demo account.
 */

import { Tickerall } from '@tickerall/sdk';
import type { TickEvent, PositionEvent, AccountEvent } from '@tickerall/sdk';

import type { Providers } from '../types';
import { TickerallClock } from './clock';
import { TickerallFeed } from './feed';
import { TickerallBroker } from './broker';
import {
  tfToSdk,
  candleToBar,
  sdkSpecToSpec,
  sdkPositionToPosition,
  sdkAccountToAccount,
  sdkPendingToPending,
  historyTradeToDeal,
  toEpochSeconds,
} from './mapping';

export interface TickerallProviderConfig {
  /** TickerAll API key (cf_api_… / cf_live_…). */
  apiKey: string;
  /** 'mt4' | 'mt5'. */
  broker: 'mt4' | 'mt5';
  /** Broker server name, e.g. 'FBS-Demo'. */
  server: string;
  /** Numeric broker login. */
  account: number;
  /** Broker password (sent once; TickerAll never persists it). */
  password: string;
  /** The (broker-native) symbol the EA is bound to, e.g. 'EURUSD'. */
  symbol: string;
  /** MT5 ENUM_TIMEFRAMES id (1=M1, 5=M5, 15=M15, …). */
  timeframe: number;
  /** Bars of history to pre-fetch (default 500). */
  historyCount?: number;
  /** Override the REST base URL (staging / self-hosted). */
  baseUrl?: string;
  /** Override the WebSocket stream URL. */
  streamUrl?: string;
  /** Inject a pre-built / mock Tickerall client (testing). Defaults to a new one. */
  client?: Tickerall;
}

export interface TickerallProviders {
  accountId: string;
  providers: Providers;
  /** Register a callback fired (with the symbol) after each live tick updates
   *  the feed cache — the live driver uses this to fire the EA's OnTick. */
  onTick(cb: (symbol: string) => void): void;
  /** Re-pull positions / account / pending orders / closed-trade history. */
  refresh(): Promise<void>;
  /** Close the stream and end the broker session. */
  disconnect(): Promise<void>;
}

export async function createTickerallProviders(
  config: TickerallProviderConfig,
): Promise<TickerallProviders> {
  const client = config.client ?? new Tickerall({
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.streamUrl !== undefined ? { streamUrl: config.streamUrl } : {}),
  });

  // 1. Connect the broker account.
  const session = await client.sessions.start({
    broker: config.broker,
    server: config.server,
    account: config.account,
    password: config.password,
  });
  const accountId = session.accountId;

  const clock = new TickerallClock();
  const feed = new TickerallFeed(config.symbol, config.timeframe);
  const broker = new TickerallBroker(client, accountId);

  // 2. Symbol specs (so symbolInfo() answers from broker data, not defaults).
  try {
    const specs = await client.accounts.symbolSpecs(accountId);
    for (const s of specs) feed.setSpec(sdkSpecToSpec(s));
  } catch {
    // best-effort — feed falls back to FX-sensible defaults
  }

  // 3. Candle history → seed the feed.
  const candles = await client.candles.get(accountId, {
    symbol: config.symbol,
    count: config.historyCount ?? 500,
    timeframe: tfToSdk(config.timeframe),
  });
  feed.seedBars(config.symbol, candles.map(candleToBar));

  // 4. Open positions + account snapshot + pending orders + history.
  const refresh = async (): Promise<void> => {
    const detail = await client.accounts.get(accountId);
    if (detail.status === 'online') {
      broker.setPositions(detail.positions.map(sdkPositionToPosition));
      if (detail.account !== null) {
        broker.setAccount(sdkAccountToAccount(detail.account, detail.accountNumber));
      }
    }
    const pending = await client.orders.listPending(accountId).catch(() => []);
    broker.setPending(pending.map(sdkPendingToPending));
    const trades = await client.history
      .get(accountId, { symbol: config.symbol })
      .catch(() => []);
    broker.setDeals(trades.map(historyTradeToDeal));
  };
  await refresh();

  // 5. Live streams → keep the caches fresh.
  const stream = await client.stream.connect();
  await stream.subscribeTicks(accountId, [config.symbol]);
  await stream.subscribePositions(accountId);
  await stream.subscribeAccount(accountId);

  const tickListeners: Array<(symbol: string) => void> = [];
  stream.on('tick', (e: TickEvent) => {
    feed.onTick(e.symbol, e.bid, e.ask, toEpochSeconds(e.timestamp));
    for (const cb of tickListeners) cb(e.symbol);
  });
  stream.on('position', (e: PositionEvent) => {
    const p = sdkPositionToPosition(e.position);
    if (e.event === 'position-closed') broker.removePosition(p.ticket);
    else broker.upsertPosition(p);
  });
  stream.on('account', (e: AccountEvent) => {
    broker.patchAccountBalance(e.snapshot.balance);
  });

  const disconnect = async (): Promise<void> => {
    try { await stream.close(); } catch { /* ignore */ }
    try { await client.sessions.end(accountId); } catch { /* ignore */ }
  };

  const onTick = (cb: (symbol: string) => void): void => { tickListeners.push(cb); };

  return { accountId, providers: { clock, feed, broker }, onTick, refresh, disconnect };
}
