import type { RemoteMonitorSample } from '@shared/types'

/**
 * Collect everything the monitor needs in a single SSH exec. The markers let a
 * missing file (busybox, non-Linux) be skipped without losing the other
 * sections. LC_ALL keeps `df` output parseable on localized hosts.
 */
export const MONITOR_COMMAND = `export LC_ALL=C
echo "@@stat"
cat /proc/stat 2>/dev/null
echo "@@mem"
cat /proc/meminfo 2>/dev/null
echo "@@uptime"
cat /proc/uptime 2>/dev/null
echo "@@net"
cat /proc/net/dev 2>/dev/null
echo "@@load"
cat /proc/loadavg 2>/dev/null
echo "@@df"
df -Pk / 2>/dev/null
echo "@@now"
date +%s 2>/dev/null`

export interface MonitorBaseline {
  /** Remote clock at the time of the sample. */
  at: number
  cpuTotal: number
  cpuIdle: number
  netRx: number
  netTx: number
}

export interface MonitorReading {
  sample: RemoteMonitorSample
  baseline: MonitorBaseline
}

const SECTION_MARKER = /^@@(stat|mem|uptime|net|load|df|now)$/

function splitSections(raw: string): Record<string, string> {
  const sections: Record<string, string> = {}
  let current: string | null = null
  let lines: string[] = []
  const flush = (): void => {
    if (current) sections[current] = lines.join('\n')
    lines = []
  }
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const match = SECTION_MARKER.exec(line.trim())
    if (match) {
      flush()
      current = match[1]
      continue
    }
    if (current) lines.push(line)
  }
  flush()
  return sections
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface CpuCounters {
  total: number
  idle: number
  cores: number
}

function parseCpu(stat: string): CpuCounters | null {
  const lines = stat.split('\n')
  const cpuLine = lines.find((line) => /^cpu\s/.test(line))
  if (!cpuLine) return null
  const values = cpuLine.trim().split(/\s+/).slice(1).map((part) => Number(part) || 0)
  // user nice system idle iowait irq softirq steal; guest time is already
  // included in user, so it must not be counted twice.
  const total = values.slice(0, 8).reduce((sum, value) => sum + value, 0)
  const idle = (values[3] ?? 0) + (values[4] ?? 0)
  const cores = lines.filter((line) => /^cpu\d+\s/.test(line)).length || 1
  return { total, idle, cores }
}

function meminfoBytes(meminfo: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(meminfo)
  return match ? Number(match[1]) * 1024 : null
}

function parseMemory(meminfo: string): {
  total: number
  used: number
  swapTotal: number
  swapUsed: number
} {
  const total = meminfoBytes(meminfo, 'MemTotal') ?? 0
  const available =
    meminfoBytes(meminfo, 'MemAvailable') ??
    (meminfoBytes(meminfo, 'MemFree') ?? 0) +
      (meminfoBytes(meminfo, 'Buffers') ?? 0) +
      (meminfoBytes(meminfo, 'Cached') ?? 0)
  const swapTotal = meminfoBytes(meminfo, 'SwapTotal') ?? 0
  const swapFree = meminfoBytes(meminfo, 'SwapFree') ?? swapTotal
  return {
    total,
    used: clamp(total - available, 0, total),
    swapTotal,
    swapUsed: clamp(swapTotal - swapFree, 0, swapTotal)
  }
}

function parseNetwork(text: string): { rx: number; tx: number } {
  let rx = 0
  let tx = 0
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim()
    if (!name || name === 'lo') continue
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map((part) => Number(part))
    // rx bytes are field 0 and tx bytes field 8 of the 16 counters.
    if (fields.length < 16 || fields.some((value) => !Number.isFinite(value))) continue
    rx += fields[0]
    tx += fields[8]
  }
  return { rx, tx }
}

function parseDisk(text: string): { total: number; used: number } {
  // df -Pk: "Filesystem 1024-blocks Used Available Capacity Mounted-on"
  for (const line of text.trim().split('\n').reverse()) {
    const fields = line.trim().split(/\s+/)
    if (fields.length >= 6 && /^\d+$/.test(fields[1]) && /^\d+$/.test(fields[2])) {
      return { total: Number(fields[1]) * 1024, used: Number(fields[2]) * 1024 }
    }
  }
  return { total: 0, used: 0 }
}

/**
 * Turn the raw exec output into a sample. `localNow` is only a fallback for the
 * remote clock, which is used so uptime and boot time stay correct across
 * timezone and clock-offset differences.
 */
export function parseMonitorOutput(
  raw: string,
  localNow: number,
  previous?: MonitorBaseline
): MonitorReading {
  const sections = splitSections(raw)
  const stat = sections.stat ?? ''
  const cpu = parseCpu(stat)
  if (!cpu) throw new Error('远程主机不支持 /proc 监控（需要 Linux）')

  const nowSeconds = Number(sections.now?.trim() ?? '')
  const remoteNow = Number.isFinite(nowSeconds) && nowSeconds > 0 ? nowSeconds * 1000 : localNow
  const uptime = Math.max(0, Number.parseFloat(sections.uptime?.trim().split(/\s+/)[0] ?? '') || 0)
  const load = Number.parseFloat((sections.load ?? '').trim().split(/\s+/)[0] ?? '') || 0
  const memory = parseMemory(sections.mem ?? '')
  const network = parseNetwork(sections.net ?? '')
  const disk = parseDisk(sections.df ?? '')

  let cpuPercent = 0
  let netDown = 0
  let netUp = 0
  if (previous) {
    const totalDelta = cpu.total - previous.cpuTotal
    const idleDelta = cpu.idle - previous.cpuIdle
    if (totalDelta > 0) {
      cpuPercent = clamp((1 - idleDelta / totalDelta) * 100, 0, 100)
    }
    const elapsed = (remoteNow - previous.at) / 1000
    if (elapsed > 0) {
      netDown = Math.max(0, (network.rx - previous.netRx) / elapsed)
      netUp = Math.max(0, (network.tx - previous.netTx) / elapsed)
    }
  }

  return {
    sample: {
      cpu: cpuPercent,
      cores: cpu.cores,
      load,
      memTotal: memory.total,
      memUsed: memory.used,
      swapTotal: memory.swapTotal,
      swapUsed: memory.swapUsed,
      diskTotal: disk.total,
      diskUsed: disk.used,
      netDown,
      netUp,
      uptime,
      bootTime: remoteNow - uptime * 1000,
      timestamp: remoteNow
    },
    baseline: {
      at: remoteNow,
      cpuTotal: cpu.total,
      cpuIdle: cpu.idle,
      netRx: network.rx,
      netTx: network.tx
    }
  }
}
