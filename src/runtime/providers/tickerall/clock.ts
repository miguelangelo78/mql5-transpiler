/**
 * TickerallClock — IClock over wall-clock time.
 *
 * TickerAll has no separate server-clock endpoint, so live `TimeCurrent()` /
 * the OnTimer cadence run off the host wall clock (epoch seconds). The feed
 * keeps the latest tick time available; if a stricter server-time alignment is
 * ever needed, point `now()` at the feed's last-tick time instead.
 */

import type { IClock } from '../types';

export class TickerallClock implements IClock {
  now(): number {
    return Math.floor(Date.now() / 1000);
  }
}
