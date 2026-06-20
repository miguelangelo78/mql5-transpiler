/**
 * BacktestClock — the sim clock.
 *
 * `now()` returns the OPEN time (epoch seconds) of the current newest visible
 * bar. The simulation sets it as `visibleCount` advances. Deterministic and
 * offline: no wall-clock reads.
 */

import type { IClock } from '../types';

export class BacktestClock implements IClock {
  private currentTime: number;

  constructor(initialTime = 0) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  /** Set the current sim time (driven by the simulation per bar). */
  set(time: number): void {
    this.currentTime = time;
  }
}
