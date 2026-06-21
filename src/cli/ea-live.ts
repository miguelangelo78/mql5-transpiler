/**
 * `ea:live` CLI — run a transpiled EA LIVE against a broker via TickerAll.
 *
 *   TICKERALL_API_KEY=cf_api_... BROKER_PASSWORD=... \
 *     npm run ea:live -- <YourEA.mq5> --server FBS-Demo --account 106230007 --symbol EURUSD [flags]
 *
 * Secrets (API key + broker password) are read from ENVIRONMENT VARIABLES only,
 * never argv — so they don't leak into your shell history / process list:
 *   TICKERALL_API_KEY   your TickerAll key (free demo tier works)
 *   BROKER_PASSWORD     the broker account password
 *
 * Flags:
 *   --broker <mt4|mt5>   default mt5
 *   --server <NAME>      broker server, e.g. FBS-Demo            (required)
 *   --account <N>        numeric broker login                    (required)
 *   --symbol <NAME>      broker-native symbol, e.g. EURUSD       (required)
 *   --timeframe <TF>     M1|M5|M15|M30|H1|H4|D1 or the id        (default M5)
 *   --duration <sec>     run for this long then stop             (default 60)
 *   --history <N>        bars of history to pre-fetch            (default 500)
 *   --replay-history     backtest the pre-fetched history first  (default off)
 *                        (prints a report), THEN continue live on the SAME EA
 *   --input <Name=Value> set an EA input (repeatable)
 *
 * It transpiles your EA, refuses (with the honesty diagnostics) if it uses an
 * unsupported builtin, then runs it live: OnTick on each market tick, OnTimer on
 * the timer. Trades go to the (demo or real) account. Use a DEMO account first.
 *
 * With --replay-history it first replays the pre-fetched bars as a backtest
 * (Phase 1, simulated fills + a report), then keeps the SAME EA instance running
 * live (Phase 2). One continuous session: OnInit once, OnDeinit once. At the seam
 * the EA's position/account view switches to the real account (paper positions
 * are not carried — see engine/replay-live-driver.ts).
 */

import { resolve } from 'node:path';

import { isMainModule } from './isMain';

import { transpileFile } from './transpile';
import { runLive } from '../engine/live-driver';
import { runReplayThenLive } from '../engine/replay-live-driver';
import { printReport } from '../engine/report-print';
import { createTickerallProviders } from '../runtime/providers/tickerall';
import { formatDiagnostics, hasErrors, countBySeverity } from '../diagnostics';
import { loadEmittedExpert } from '../loadExpert';
import type { Inputs } from '../runtime/runtime';

const TF: Record<string, number> = {
  M1: 1, M5: 5, M15: 15, M30: 30, H1: 16385, H4: 16388, D1: 16408, W1: 32769, MN1: 49153,
};

function parseTimeframe(v: string | undefined): number {
  if (v === undefined) return 5;
  const up = v.toUpperCase();
  if (up in TF) return TF[up]!;
  const n = Number(v);
  return Number.isFinite(n) ? n : 5;
}

function coerce(value: string): number | boolean | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return value !== '' && Number.isFinite(n) ? n : value;
}

interface Args {
  file: string;
  broker: 'mt4' | 'mt5';
  server?: string;
  account?: number;
  symbol?: string;
  timeframe: number;
  durationSec: number;
  history: number;
  inputs: Inputs;
  /** --replay-history: backtest the pre-fetched history first (printing a
   *  report), then continue live on the SAME EA instance. */
  replayHistory: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { file: '', broker: 'mt5', timeframe: 5, durationSec: 60, history: 500, inputs: {}, replayHistory: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag --${key} needs a value`);
      return v;
    };
    switch (key) {
      case 'broker': out.broker = need() === 'mt4' ? 'mt4' : 'mt5'; break;
      case 'server': out.server = need(); break;
      case 'account': out.account = Number(need()); break;
      case 'symbol': out.symbol = need(); break;
      case 'timeframe': out.timeframe = parseTimeframe(need()); break;
      case 'duration': out.durationSec = Number(need()); break;
      case 'history': out.history = Number(need()); break;
      case 'replay-history': out.replayHistory = true; break; // bare flag, no value
      case 'input': {
        const pair = need();
        const eq = pair.indexOf('=');
        if (eq < 0) throw new Error(`--input expects Name=Value, got '${pair}'`);
        out.inputs[pair.slice(0, eq)] = coerce(pair.slice(eq + 1));
        break;
      }
      default: throw new Error(`unknown flag --${key}`);
    }
  }
  out.file = positional[0] ?? '';
  return out;
}

async function main(): Promise<void> {
  const apiKey = process.env.TICKERALL_API_KEY;
  const password = process.env.BROKER_PASSWORD;

  let args: Args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exit(2); }

  const miss: string[] = [];
  if (!apiKey) miss.push('env TICKERALL_API_KEY');
  if (!password) miss.push('env BROKER_PASSWORD');
  if (args.file === '') miss.push('<YourEA.mq5>');
  if (!args.server) miss.push('--server');
  if (args.account === undefined) miss.push('--account');
  if (!args.symbol) miss.push('--symbol');
  if (miss.length > 0) {
    process.stderr.write(
      `Missing required: ${miss.join(', ')}\n` +
      `usage: TICKERALL_API_KEY=... BROKER_PASSWORD=... npm run ea:live -- <EA.mq5> ` +
      `--server <NAME> --account <N> --symbol <NAME> [--broker mt5] [--timeframe M5] [--duration 60]\n`,
    );
    process.exit(2);
  }

  // Transpile + honesty gate (same as `npm run ea`).
  const srcPath = resolve(args.file);
  process.stdout.write(`Transpiling ${srcPath} …\n`);
  const { outPath, diagnostics, name } = transpileFile(srcPath);
  if (diagnostics.length > 0) process.stdout.write(formatDiagnostics(diagnostics) + '\n');
  if (hasErrors(diagnostics)) {
    process.stderr.write(`✗ ${name} uses ${countBySeverity(diagnostics).error} unimplemented builtin(s); not running live.\n`);
    process.exit(1);
  }

  const factory = await loadEmittedExpert(outPath);

  process.stdout.write(
    `✓ ${name} supported. Connecting to ${args.broker.toUpperCase()} ${args.server} ` +
    `account ${args.account} (${args.symbol}) via TickerAll …\n`,
  );

  const live = await createTickerallProviders({
    apiKey: apiKey!,
    broker: args.broker,
    server: args.server!,
    account: args.account!,
    password: password!,
    symbol: args.symbol!,
    timeframe: args.timeframe,
    historyCount: args.history,
  });

  const acc = live.providers.broker.account();
  const inputs = Object.keys(args.inputs).length > 0 ? args.inputs : undefined;

  try {
    if (args.replayHistory) {
      // Hybrid: backtest the pre-fetched history first (same EA instance), print
      // the report, then continue live. The bars + spec come from the live feed
      // that createTickerallProviders already seeded — one fetch, identical data
      // across both phases.
      const history = [...live.providers.feed.history(args.symbol!, args.timeframe)];
      const symbolSpec = live.providers.feed.symbolInfo(args.symbol!);
      process.stdout.write(
        `Connected (accountId ${live.accountId}). Balance ${acc.balance.toFixed(2)} ${acc.currency}, ` +
        `equity ${acc.equity.toFixed(2)}.\n` +
        `Phase 1 — replaying ${history.length} historical bars as a backtest …\n`,
      );
      const { report, live: summary, initFailed } = await runReplayThenLive({
        factory,
        history,
        symbolSpec,
        initialBalance: acc.balance, // paper-run on your real starting balance
        live,
        symbol: args.symbol!,
        timeframe: args.timeframe,
        inputs,
        durationMs: args.durationSec * 1000,
        // Fires only when OnInit succeeded (the driver returns early on
        // INIT_FAILED), so reaching here always means we proceed to live.
        onBacktestComplete: (rep) => {
          printReport(rep, { transpiledPath: outPath });
          process.stdout.write(
            `\nPhase 2 — switching to LIVE on account ${args.account} ` +
            `(positions now reflect the real account; sim positions are not carried). ` +
            `Running OnTick/OnTimer for ${args.durationSec}s …\n`,
          );
        },
      });
      await live.refresh();
      const positions = live.providers.broker.positions();
      process.stdout.write(
        `\n\nDone. ${initFailed ? 'OnInit reported INIT_FAILED — no live run. ' : ''}` +
        `Live ticks ${summary.ticksHandled}/${summary.ticksSeen}, timer fires ${summary.timerFires}. ` +
        `Open positions: ${positions.length}. (Phase-1 backtest net ${report.netProfit.toFixed(2)})\n`,
      );
      for (const p of positions) {
        process.stdout.write(`  ${p.symbol} ${p.side} ${p.volume} @ ${p.openPrice} profit ${p.profit.toFixed(2)}\n`);
      }
    } else {
      process.stdout.write(
        `Connected (accountId ${live.accountId}). Balance ${acc.balance.toFixed(2)} ${acc.currency}, ` +
        `equity ${acc.equity.toFixed(2)}. Running OnTick/OnTimer for ${args.durationSec}s …\n`,
      );
      const summary = await runLive({
        factory,
        live,
        symbol: args.symbol!,
        timeframe: args.timeframe,
        inputs,
        durationMs: args.durationSec * 1000,
        onActivity: (what) => process.stdout.write(what === 'timer' ? '⏱' : '·'),
      });
      await live.refresh();
      const positions = live.providers.broker.positions();
      process.stdout.write(
        `\n\nDone. Ticks ${summary.ticksHandled}/${summary.ticksSeen}, timer fires ${summary.timerFires}. ` +
        `Open positions: ${positions.length}.\n`,
      );
      for (const p of positions) {
        process.stdout.write(`  ${p.symbol} ${p.side} ${p.volume} @ ${p.openPrice} profit ${p.profit.toFixed(2)}\n`);
      }
    }
  } finally {
    await live.disconnect();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`ea:live failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
