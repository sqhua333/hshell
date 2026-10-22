import { describe, expect, it } from 'vitest'
import { parseMonitorOutput } from '../../src/main/monitor/remote'

function fixture(overrides: Partial<Record<'stat' | 'net' | 'now', string>> = {}): string {
  return [
    '@@stat',
    overrides.stat ?? 'cpu  100 20 30 850 0 0 0 0 0 0',
    'cpu0 50 10 15 425 0 0 0 0 0 0',
    'cpu1 50 10 15 425 0 0 0 0 0 0',
    '@@mem',
    'MemTotal:       16000000 kB',
    'MemFree:         2000000 kB',
    'MemAvailable:    6000000 kB',
    'Buffers:          100000 kB',
    'Cached:          2000000 kB',
    'SwapTotal:       4000000 kB',
    'SwapFree:        3900000 kB',
    '@@uptime',
    '123456.78 987654.32',
    '@@net',
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0',
    overrides.net ??
      '  eth0: 1000000 0 0 0 0 0 0 0 2000000 0 0 0 0 0 0 0',
    '@@load',
    '0.42 0.30 0.20 1/100 1234',
    '@@df',
    'Filesystem     1024-blocks    Used Available Capacity Mounted on',
    '/dev/sda1        134217728 85899346  48318382      64% /',
    '@@now',
    overrides.now ?? '1700000000'
  ].join('\n')
}

describe('parseMonitorOutput', () => {
  it('parses memory, swap, disk, uptime, load and core count', () => {
    const { sample, baseline } = parseMonitorOutput(fixture(), Date.now())

    expect(sample.cores).toBe(2)
    expect(sample.load).toBeCloseTo(0.42)
    expect(sample.memTotal).toBe(16_000_000 * 1024)
    expect(sample.memUsed).toBe(10_000_000 * 1024)
    expect(sample.swapTotal).toBe(4_000_000 * 1024)
    expect(sample.swapUsed).toBe(100_000 * 1024)
    expect(sample.diskTotal).toBe(134_217_728 * 1024)
    expect(sample.diskUsed).toBe(85_899_346 * 1024)
    expect(sample.uptime).toBeCloseTo(123456.78)
    expect(sample.bootTime).toBe(1_700_000_000_000 - 123456.78 * 1000)
    expect(sample.timestamp).toBe(1_700_000_000_000)
    // The first reading has no counters to compare against.
    expect(sample.cpu).toBe(0)
    expect(sample.netDown).toBe(0)
    expect(sample.netUp).toBe(0)
    expect(baseline.cpuTotal).toBe(1000)
    expect(baseline.cpuIdle).toBe(850)
    expect(baseline.netRx).toBe(1_000_000)
    expect(baseline.netTx).toBe(2_000_000)
  })

  it('computes CPU and network rates from the previous baseline', () => {
    const first = parseMonitorOutput(fixture(), Date.now())
    const second = parseMonitorOutput(
      fixture({
        stat: 'cpu  300 20 30 1150 0 0 0 0 0 0',
        net: '  eth0: 1200000 0 0 0 0 0 0 0 2400000 0 0 0 0 0 0 0',
        now: '1700000002'
      }),
      0,
      first.baseline
    )

    // 500 total jiffies elapsed, 300 of them idle -> 40% busy.
    expect(second.sample.cpu).toBeCloseTo(40)
    // 200 KB over 2 s, 400 KB the other way.
    expect(second.sample.netDown).toBe(100_000)
    expect(second.sample.netUp).toBe(200_000)
  })

  it('ignores loopback traffic and tolerates missing df output', () => {
    const raw = fixture({
      net: '    lo: 5000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0'
    }).replace(
      'Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/sda1        134217728 85899346  48318382      64% /',
      ''
    )
    const { sample, baseline } = parseMonitorOutput(raw, Date.now())
    expect(baseline.netRx).toBe(0)
    expect(sample.diskTotal).toBe(0)
    expect(sample.diskUsed).toBe(0)
  })

  it('falls back to MemFree when MemAvailable is absent', () => {
    const raw = fixture().replace('MemAvailable:    6000000 kB\n', '')
    const { sample } = parseMonitorOutput(raw, Date.now())
    expect(sample.memUsed).toBe((16_000_000 - (2_000_000 + 100_000 + 2_000_000)) * 1024)
  })

  it('rejects hosts without /proc/stat', () => {
    expect(() => parseMonitorOutput('@@mem\nMemTotal: 1 kB\n', Date.now())).toThrow(
      /不支持 \/proc 监控/
    )
  })

  it('uses the local clock when the remote date is unavailable', () => {
    const localNow = 1_234_567_890_000
    const { sample } = parseMonitorOutput(fixture({ now: '' }), localNow)
    expect(sample.timestamp).toBe(localNow)
    expect(sample.bootTime).toBe(localNow - 123456.78 * 1000)
  })
})
