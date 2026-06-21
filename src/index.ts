/**
 * mql5-transpiler — public API.
 *
 * Transpile MQL5 source to a runnable program and execute it on a pluggable
 * engine: deterministic backtest (synthetic or real broker history), live
 * trading, or a hybrid replay-then-live — all behind one `IBroker`/`IMarketFeed`/
 * `IClock` provider boundary. This barrel is the surface other tools build on
 * (e.g. a terminal UI); the CLI entry points live under `src/cli/`.
 *
 * Quick start (consumer):
 *
 *   import { transpileFile, loadEmittedExpert, runBacktest } from 'mql5-transpiler';
 *   const { outPath, diagnostics } = transpileFile('MyEA.mq5');
 *   const factory = await loadEmittedExpert(outPath);
 *   const report = await runBacktest({ factory, config });
 */

// ── Transpile + load ────────────────────────────────────────────────────────
export { transpileFile } from './cli/transpile';
export { loadExpertFromCode, loadEmittedExpert } from './loadExpert';

// ── Engines ─────────────────────────────────────────────────────────────────
export { runBacktest } from './engine/driver';
export type { RunBacktestOptions } from './engine/driver';
export { runEmittedModule } from './cli/backtest';
export type { RunModuleOptions } from './cli/backtest';
export { runLive } from './engine/live-driver';
export type { RunLiveOptions, LiveRunSummary } from './engine/live-driver';
export { runReplayThenLive } from './engine/replay-live-driver';
export type { RunReplayThenLiveOptions, ReplayThenLiveSummary } from './engine/replay-live-driver';
export { printReport } from './engine/report-print';

// ── Providers (swap live ↔ backtest behind the same boundary) ────────────────
export { createBacktest } from './runtime/providers/backtest/index';
export type { BacktestConfig, SyntheticConfig } from './runtime/providers/backtest/index';
export { createTickerallProviders } from './runtime/providers/tickerall';
export type { TickerallProviderConfig, TickerallProviders } from './runtime/providers/tickerall';
export { fetchHistoryBars } from './runtime/providers/tickerall/history';
export type { FetchHistoryConfig, FetchedHistory } from './runtime/providers/tickerall/history';
export {
  tfToSdk,
  tfSeconds,
  candleToBar,
  sdkSpecToSpec,
  sdkPositionToPosition,
} from './runtime/providers/tickerall/mapping';

// ── Runtime + MT5-faithful indicators ────────────────────────────────────────
export { createRuntime } from './runtime';
export { computeSMA } from './runtime/indicators/sma';
export { computeEMA } from './runtime/indicators/ma';

// ── The honesty layer (what an EA needs vs what's implemented) ────────────────
export { RUNTIME_COVERAGE, checkCoverage } from './runtime/coverage';
export { formatDiagnostics, hasErrors, countBySeverity } from './diagnostics';

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  Bar,
  Tick,
  SymbolSpec,
  Position,
  OrderSide,
  OrderRequest,
  TradeResult,
  AccountInfo,
  PendingKind,
  PendingOrder,
  PendingOrderRequest,
  DealRecord,
  IClock,
  IMarketFeed,
  IBroker,
  Providers,
} from './runtime/providers/types';
export type { BacktestReport, RuntimeContext, BacktestSimulation } from './engine/types';
export type { ExpertFactory, ExpertInstance, Inputs, Runtime } from './runtime/runtime';
