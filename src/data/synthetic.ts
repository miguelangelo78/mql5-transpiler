/**
 * Deterministic synthetic OHLC bar generator for the backtest provider.
 *
 * Seeded with a mulberry32 PRNG (NO Math.random) so the SAME seed yields
 * byte-identical bars every run — the backtest's determinism guarantee
 * (engine/types.ts) rests on this.
 *
 * The price series is shaped so the fast/slow SMA pair WILL cross multiple
 * times: a gentle linear drift + a slow sinusoidal cycle (period chosen so a
 * fast/slow SMA pair oscillates around the cycle and crosses on each up/down
 * leg) + small bounded noise. The slow cycle is the load-bearing part: it
 * forces the mean to rise and fall, dragging the fast SMA above and below the
 * slow SMA repeatedly. Noise is kept small so it perturbs but never dominates
 * the crossing structure.
 */

import type { Bar } from '../runtime/providers/types';

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit seeded PRNG.
 * Returns a float in [0, 1). Deterministic for a given seed.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convert an MQL5 ENUM_TIMEFRAMES value to seconds-per-bar.
 *
 * MT5 encodes the M-series as plain minutes (M1=1 … M30=30) but H1+ as a
 * bitfield (H1=0x4001=16385, H4=0x4004=16388, D1=0x4018=16408, W1=0x8001,
 * MN1=0xC001). We decode both forms exactly rather than guessing.
 */
export function timeframeSeconds(timeframe: number): number {
  switch (timeframe) {
    case 0: // PERIOD_CURRENT — caller should resolve; default to M1 spacing.
      return 60;
    case 1: return 60; // M1
    case 2: return 120; // M2
    case 3: return 180; // M3
    case 4: return 240; // M4
    case 5: return 300; // M5
    case 6: return 360; // M6
    case 10: return 600; // M10
    case 12: return 720; // M12
    case 15: return 900; // M15
    case 20: return 1200; // M20
    case 30: return 1800; // M30
    case 16385: return 3600; // H1  (0x4001)
    case 16386: return 7200; // H2  (0x4002)
    case 16387: return 10800; // H3 (0x4003)
    case 16388: return 14400; // H4  (0x4004)
    case 16390: return 21600; // H6  (0x4006)
    case 16392: return 28800; // H8  (0x4008)
    case 16396: return 43200; // H12 (0x400C)
    case 16408: return 86400; // D1  (0x4018)
    case 32769: return 604800; // W1  (0x8001)
    case 49153: return 2592000; // MN1 (0xC001) — 30-day nominal month
    default:
      // Unknown/intraday minute encoding: if it is a plausible minute count
      // (1..1439) treat it as minutes; otherwise fall back to M1.
      if (timeframe > 0 && timeframe < 1440) return timeframe * 60;
      return 60;
  }
}

export interface SyntheticBarsOptions {
  symbol: string;
  timeframe: number;
  /** Number of bars to generate. */
  bars: number;
  /** Price of the very first bar's open. */
  startPrice: number;
  /** Open time (epoch seconds) of the first bar. */
  startTime: number;
  /** PRNG seed. Same seed ⇒ identical bars. */
  seed: number;

  // ── shape knobs (all have sensible defaults that guarantee crossovers) ──
  /** Per-bar linear drift added to the trend mean. Default 0 (flat trend). */
  driftPerBar?: number;
  /** Peak-to-trough amplitude of the slow cycle, in price units. */
  cycleAmplitude?: number;
  /** Length of one full slow cycle, in bars. */
  cyclePeriodBars?: number;
  /** Bounded per-bar noise amplitude (uniform in ±noise). */
  noise?: number;
  /** Intrabar high/low wick half-range, in price units. */
  wick?: number;
  /** Price quantum the OHLC values are rounded to (e.g. 0.00001). */
  point?: number;
}

/**
 * Generate `bars` chronological OHLC bars. The mean follows
 * `startPrice + drift*i + amplitude*sin(2π i / period)`; each bar's close is
 * that mean plus bounded noise, its open is the previous close (the first
 * bar opens at the mean), and high/low extend by a wick plus noise. Volumes
 * are deterministic from the PRNG too.
 */
export function generateSyntheticBars(opts: SyntheticBarsOptions): Bar[] {
  const {
    symbol: _symbol,
    timeframe,
    bars,
    startPrice,
    startTime,
    seed,
  } = opts;

  // Defaults tuned so SMA(10)/SMA(30) cross several times over a few hundred
  // bars: amplitude well above the noise floor, a cycle long enough that the
  // 30-period mean lags the 10-period mean by a meaningful phase.
  const amplitude = opts.cycleAmplitude ?? Math.max(startPrice * 0.01, 5);
  const cyclePeriod = opts.cyclePeriodBars ?? 60;
  const drift = opts.driftPerBar ?? 0;
  const noise = opts.noise ?? amplitude * 0.06;
  const wick = opts.wick ?? amplitude * 0.04;
  const point = opts.point ?? 0.00001;

  const rand = mulberry32(seed);
  const dt = timeframeSeconds(timeframe);

  const round = (v: number): number => {
    if (point <= 0) return v;
    // Round to the nearest `point` quantum. Guard against fp drift.
    return Math.round(v / point) * point;
  };

  const out: Bar[] = [];
  let prevClose = round(startPrice);

  for (let i = 0; i < bars; i++) {
    const time = startTime + i * dt;

    const trendMean =
      startPrice + drift * i + amplitude * Math.sin((2 * Math.PI * i) / cyclePeriod);

    // Symmetric bounded noise in [-noise, +noise].
    const closeNoise = (rand() * 2 - 1) * noise;
    const close = round(trendMean + closeNoise);

    // Open = previous close (continuous series). First bar opens at the mean.
    const open = i === 0 ? round(trendMean) : prevClose;

    // High/low envelope the open/close, extended by a random wick.
    const hi = Math.max(open, close) + rand() * wick;
    const lo = Math.min(open, close) - rand() * wick;
    const high = round(hi);
    const low = round(lo);

    // Deterministic volumes derived from the PRNG.
    const tickVolume = 50 + Math.floor(rand() * 200);
    const realVolume = tickVolume * (1 + Math.floor(rand() * 10));

    out.push({
      time,
      open,
      high,
      low,
      close,
      tickVolume,
      spread: 0,
      realVolume,
    });

    prevClose = close;
  }

  return out;
}
