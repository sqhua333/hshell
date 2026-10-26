interface SpeedSample {
  at: number
  bytes: number
  speed: number
}

/**
 * Turns byte counters from transfer progress events into a smoothed rate.
 * Events arrive every ~100 ms; rates are recomputed once enough time has
 * passed, weighted towards the previous value so the label does not flicker.
 */
export class TransferSpeedMeter {
  private samples = new Map<string, SpeedSample>()

  /** Feed one progress event and return the smoothed bytes per second. */
  sample(key: string, running: boolean, transferred: number, now = Date.now()): number {
    if (!running) {
      this.samples.delete(key)
      return 0
    }
    const previous = this.samples.get(key)
    // A zero or smaller counter means a new file started inside this transfer.
    if (!previous || transferred === 0 || transferred < previous.bytes) {
      this.samples.set(key, { at: now, bytes: transferred, speed: 0 })
      return 0
    }
    const elapsed = (now - previous.at) / 1000
    if (elapsed < 0.2) return previous.speed
    const instant = (transferred - previous.bytes) / elapsed
    const speed = previous.speed > 0 ? previous.speed * 0.6 + instant * 0.4 : instant
    this.samples.set(key, { at: now, bytes: transferred, speed })
    return speed
  }

  /** Drop all samples belonging to one transfer (keys share its prefix). */
  clear(prefix: string): void {
    for (const key of this.samples.keys()) {
      if (key.startsWith(prefix)) this.samples.delete(key)
    }
  }
}
