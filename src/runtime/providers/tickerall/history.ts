/**
 * Fetch REAL historical candles from TickerAll for an offline backtest.
 *
 * A backtest "on real data" should source its bars from the actual broker feed —
 * exactly the candles the live path streams, and exactly what MT5's Strategy
 * Tester replays from the terminal's downloaded history — NOT from a hand-exported
 * file. So this connects the broker account, pulls `count` candles + the symbol
 * spec through the SAME @tickerall/sdk calls + mappings the live provider uses
 * (`candles.get` → `candleToBar`, `symbolSpecs` → `sdkSpecToSpec`), ends the
 * session, and hands back a plain `Bar[]` + `SymbolSpec`. The deterministic
 * backtest engine then replays those bars — the transpiled EA is byte-identical
 * to the one that runs live; only the data source changed.
 *
 * Secrets (API key, broker password) come from the CALLER (env vars), never argv.
 */

import { Tickerall } from '@tickerall/sdk';

import type { Bar, SymbolSpec } from '../types';
import { tfToSdk, candleToBar, sdkSpecToSpec } from './mapping';

export interface FetchHistoryConfig {
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
  /** The broker-native symbol, e.g. 'EURUSD' / 'BTCUSD'. */
  symbol: string;
  /** MT5 ENUM_TIMEFRAMES id (1=M1, 5=M5, …, 16408=D1). */
  timeframe: number;
  /** Bars of history to fetch (default 500). */
  count?: number;
  /** Override the REST base URL (staging / self-hosted). */
  baseUrl?: string;
  /** Override the WebSocket stream URL. */
  streamUrl?: string;
  /** Inject a pre-built / mock Tickerall client (testing). Defaults to a new one. */
  client?: Tickerall;
  /** Observability hook fired when the client transparently re-arms a cooled
   *  account. Defaults to a stderr note. */
  onRearm?: (accountId: string) => void;
}

export interface FetchedHistory {
  /** Real broker bars, chronological (oldest first). */
  bars: Bar[];
  /** Broker symbol spec (digits/point/contractSize/tickValue), when available. */
  spec?: SymbolSpec;
  /** The TickerAll session/account id used for the fetch. */
  accountId: string;
}

/**
 * Connect → pull candles + spec → end session. Returns the bars + spec for a
 * backtest. The session is always ended (even on error) so the account is not
 * left armed.
 */
export async function fetchHistoryBars(config: FetchHistoryConfig): Promise<FetchedHistory> {
  const client =
    config.client ??
    new Tickerall({
      apiKey: config.apiKey,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      ...(config.streamUrl !== undefined ? { streamUrl: config.streamUrl } : {}),
      onRearm:
        config.onRearm ??
        ((id) => {
          process.stderr.write(`[tickerall] re-armed cooled account ${id}\n`);
        }),
    });

  // keepAlive (not start) so a slow multi-page candle fetch survives the account
  // cooling mid-pull — the client transparently re-arms on BROKER_ACCOUNT_NOT_HOT.
  const session = await client.sessions.keepAlive({
    broker: config.broker,
    server: config.server,
    account: config.account,
    password: config.password,
  });
  const accountId = session.accountId;

  try {
    // Symbol spec (best-effort — the backtest falls back to FX-sensible defaults).
    let spec: SymbolSpec | undefined;
    try {
      const specs = await client.accounts.symbolSpecs(accountId);
      const match = specs.find((s) => s.name === config.symbol);
      if (match) spec = sdkSpecToSpec(match);
    } catch {
      // leave spec undefined
    }

    const candles = await client.candles.get(accountId, {
      symbol: config.symbol,
      count: config.count ?? 500,
      timeframe: tfToSdk(config.timeframe),
    });
    const bars = candles.map(candleToBar).sort((a, b) => a.time - b.time);

    return { bars, spec, accountId };
  } finally {
    try {
      await client.sessions.end(accountId);
    } catch {
      // best-effort teardown
    }
  }
}
