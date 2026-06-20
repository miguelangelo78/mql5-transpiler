/**
 * `ea` CLI — the one-command way to run ANY MQL5 EA end-to-end.
 *
 *   npm run ea -- <path/to/YourEA.mq5> [flags]
 *
 * It transpiles your .mq5 to TypeScript, reports exactly what (if anything) it
 * can't support yet (the honesty layer), and — if the EA is fully supported —
 * backtests it on deterministic synthetic data and prints a trade-for-trade
 * report. No hand-written glue.
 *
 * Flags (all optional; sensible defaults):
 *   --symbol <NAME>      symbol name              (default EURUSD)
 *   --timeframe <N>      MT5 ENUM_TIMEFRAMES id   (default 1 = M1; 15 = M15, …)
 *   --bars <N>           number of synthetic bars (default 3000)
 *   --seed <N>           PRNG seed (deterministic) (default 0x5eed)
 *   --price <N>          starting price           (default 1.10)
 *   --balance <N>        starting balance         (default 10000)
 *   --input <Name=Value> set an EA input (repeatable); Value is parsed as a
 *                        number / true / false / string. e.g.
 *                        --input InpFastPeriod=5 --input InpLots=0.2
 *
 * Examples:
 *   npm run ea -- examples/MovingAverageCross.mq5
 *   npm run ea -- examples/RsiReversal.mq5 --timeframe 15 --bars 2000
 *   npm run ea -- examples/MovingAverageCross.mq5 --input InpFastPeriod=5 --input InpSlowPeriod=50
 *
 * If your EA uses a builtin the runtime doesn't implement yet, this prints a
 * clear error listing each one and exits non-zero WITHOUT running a broken
 * backtest — so you always know precisely what's supported.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { transpileFile } from './transpile';
import { runEmittedModule } from './backtest';
import { printReport } from '../engine/report-print';
import { formatDiagnostics, hasErrors, countBySeverity } from '../diagnostics';
import type { Inputs } from '../runtime/runtime';

interface ParsedArgs {
  file: string;
  symbol?: string;
  timeframe?: number;
  bars?: number;
  seed?: number;
  price?: number;
  balance?: number;
  inputs: Inputs;
}

/** Parse `Value` as a number, then bool, else keep the raw string. */
function coerce(value: string): number | boolean | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return value !== '' && Number.isFinite(n) ? n : value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { file: '', inputs: {} };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const need = (): string => {
      if (next === undefined) throw new Error(`flag --${key} needs a value`);
      i++;
      return next;
    };
    switch (key) {
      case 'symbol': out.symbol = need(); break;
      case 'timeframe': out.timeframe = Number(need()); break;
      case 'bars': out.bars = Number(need()); break;
      case 'seed': out.seed = Number(need()); break;
      case 'price': out.price = Number(need()); break;
      case 'balance': out.balance = Number(need()); break;
      case 'input': {
        const pair = need();
        const eq = pair.indexOf('=');
        if (eq < 0) throw new Error(`--input expects Name=Value, got '${pair}'`);
        out.inputs[pair.slice(0, eq)] = coerce(pair.slice(eq + 1));
        break;
      }
      default:
        throw new Error(`unknown flag --${key}`);
    }
  }

  out.file = positional[0] ?? '';
  return out;
}

const USAGE =
  'usage: npm run ea -- <YourEA.mq5> ' +
  '[--symbol EURUSD] [--timeframe 1] [--bars 3000] [--seed N] ' +
  '[--price 1.10] [--balance 10000] [--input Name=Value ...]\n';

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.file === '') {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const srcPath = resolve(args.file);
  process.stdout.write(`Transpiling ${srcPath} …\n`);

  const { outPath, diagnostics, name } = transpileFile(srcPath);
  process.stdout.write(`  → ${outPath}\n\n`);

  // The honesty layer: tell the user exactly what their EA uses that we can't
  // run yet — BEFORE attempting a backtest that would throw on the first such
  // call. Warnings are printed but don't block.
  if (diagnostics.length > 0) {
    process.stdout.write(formatDiagnostics(diagnostics) + '\n\n');
  }
  if (hasErrors(diagnostics)) {
    const { error } = countBySeverity(diagnostics);
    process.stderr.write(
      `✗ ${name} uses ${error} builtin(s)/symbol(s) the runtime does not implement yet.\n` +
        `  The transpiled module would throw at run time, so the backtest was NOT run.\n` +
        `  Implement the listed builtins (see src/runtime + src/runtime/coverage.ts) or\n` +
        `  adjust the EA, then re-run.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`✓ ${name} is fully supported — running backtest…\n`);
  const report = await runEmittedModule({
    modulePath: outPath,
    symbol: args.symbol,
    timeframe: args.timeframe,
    bars: args.bars,
    seed: args.seed,
    startPrice: args.price,
    initialBalance: args.balance,
    inputs: Object.keys(args.inputs).length > 0 ? args.inputs : undefined,
  });

  printReport(report, { transpiledPath: outPath });

  if (report.totalDeals === 0) {
    process.stdout.write(
      '\nNote: 0 deals — the strategy did not trade on this synthetic series.\n' +
        'Try a different --seed / --bars / --timeframe, or check the EA logic.\n',
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `ea run failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
