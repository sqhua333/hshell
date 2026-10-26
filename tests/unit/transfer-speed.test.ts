import { describe, expect, it } from 'vitest'
import { TransferSpeedMeter } from '../../src/renderer/src/lib/transfer-speed'

const KEY = 'rt:transfer:file.bin'

describe('TransferSpeedMeter', () => {
  it('stays at zero until there are two samples', () => {
    const meter = new TransferSpeedMeter()
    expect(meter.sample(KEY, true, 0, 0)).toBe(0)
    expect(meter.sample(KEY, true, 1024, 100)).toBe(0)
  })

  it('reports bytes per second from the sample window', () => {
    const meter = new TransferSpeedMeter()
    meter.sample(KEY, true, 0, 0)
    // 1 MB in 500 ms.
    expect(meter.sample(KEY, true, 1_048_576, 500)).toBe(2_097_152)
  })

  it('smooths a rate change instead of jumping to the new value', () => {
    const meter = new TransferSpeedMeter()
    meter.sample(KEY, true, 0, 0)
    meter.sample(KEY, true, 1000, 500) // 2000 B/s
    // Next window moves twice as fast: 0.6 * 2000 + 0.4 * 4000.
    expect(meter.sample(KEY, true, 3000, 1000)).toBe(2800)
  })

  it('ignores events closer than the sampling window', () => {
    const meter = new TransferSpeedMeter()
    meter.sample(KEY, true, 0, 0)
    const first = meter.sample(KEY, true, 1000, 500)
    expect(meter.sample(KEY, true, 1100, 550)).toBe(first)
  })

  it('resets when a new file starts inside the same transfer', () => {
    const meter = new TransferSpeedMeter()
    meter.sample(KEY, true, 0, 0)
    meter.sample(KEY, true, 1_000_000, 500)
    expect(meter.sample(KEY, true, 0, 600)).toBe(0)
    expect(meter.sample(KEY, true, 1000, 1100)).toBe(2000)
  })

  it('returns to zero for finished phases and forgets the samples', () => {
    const meter = new TransferSpeedMeter()
    meter.sample(KEY, true, 0, 0)
    meter.sample(KEY, true, 1000, 500)
    expect(meter.sample(KEY, false, 1000, 600)).toBe(0)
    // A fresh run with a smaller counter restarts from zero.
    expect(meter.sample(KEY, true, 10, 700)).toBe(0)
  })

  it('clears every sample sharing a transfer prefix', () => {
    const meter = new TransferSpeedMeter()
    meter.sample('rt:t1:a.bin', true, 0, 0)
    meter.sample('rt:t1:a.bin', true, 1000, 500)
    meter.sample('rt:t1:b.bin', true, 0, 0)
    meter.sample('rt:t1:b.bin', true, 1000, 500)
    meter.clear('rt:t1:')
    // Both files start over: the next sample cannot build on the old one.
    expect(meter.sample('rt:t1:a.bin', true, 2000, 1000)).toBe(0)
    expect(meter.sample('rt:t2:a.bin', true, 3000, 1000)).toBe(0)
  })
})
