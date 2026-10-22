/**
 * Minimal telnet protocol codec: strips IAC sequences from the stream and
 * answers the common option negotiations. Only the pieces a terminal client
 * needs are implemented (TTYPE, NAWS, SGA and ECHO); everything else is
 * refused so the server falls back to plain NVT.
 */

export const IAC = 255
export const DONT = 254
export const DO = 253
export const WONT = 252
export const WILL = 251
export const SB = 250
export const SE = 240

export const OPT_ECHO = 1
export const OPT_SGA = 3
export const OPT_TTYPE = 24
export const OPT_NAWS = 31
export const OPT_LINEMODE = 34

/** TTYPE subnegotiation commands. */
const TTYPE_IS = 0
const TTYPE_SEND = 1

export interface TelnetProtocolOptions {
  /** Writes negotiation bytes back to the socket. */
  send: (data: Buffer) => void
  terminalType?: string
}

type ParseState = 'data' | 'iac' | 'option' | 'sub' | 'subIac'

export class TelnetProtocol {
  private state: ParseState = 'data'
  private command = 0
  private sub: number[] = []
  private cols = 80
  private rows = 24
  private nawsAgreed = false
  private readonly sentWill = new Set<number>()
  private readonly sentWont = new Set<number>()
  private readonly sentDo = new Set<number>()
  private readonly sentDont = new Set<number>()
  private readonly terminalType: string

  constructor(private readonly options: TelnetProtocolOptions) {
    this.terminalType = options.terminalType || 'xterm-256color'
  }

  /** Announce the options this client is willing to use. */
  start(): void {
    this.sendWill(OPT_TTYPE)
    this.sendWill(OPT_NAWS)
    this.sendWill(OPT_SGA)
  }

  /** Remember the size for future NAWS replies (and send one if negotiated). */
  setWindowSize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.min(65535, Math.floor(cols) || 80))
    this.rows = Math.max(1, Math.min(65535, Math.floor(rows) || 24))
    // RFC 1073: only send NAWS after the server acknowledged our WILL.
    if (this.nawsAgreed) this.sendWindowSize()
  }

  /**
   * Consume bytes from the socket and return the application data, excluding
   * every telnet command. Negotiation replies are emitted synchronously.
   */
  feed(chunk: Buffer): Buffer {
    const out: number[] = []
    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === IAC) this.state = 'iac'
          else out.push(byte)
          break
        case 'iac':
          if (byte === IAC) {
            // Escaped literal 0xFF.
            out.push(byte)
            this.state = 'data'
          } else if (byte === DO || byte === DONT || byte === WILL || byte === WONT) {
            this.command = byte
            this.state = 'option'
          } else if (byte === SB) {
            this.sub = []
            this.state = 'sub'
          } else {
            // NOP, GA and other two-byte commands are ignored.
            this.state = 'data'
          }
          break
        case 'option':
          this.handleOption(this.command, byte)
          this.state = 'data'
          break
        case 'sub':
          if (byte === IAC) this.state = 'subIac'
          else this.sub.push(byte)
          break
        case 'subIac':
          if (byte === SE) {
            this.handleSubnegotiation(Buffer.from(this.sub))
            this.sub = []
            this.state = 'data'
          } else if (byte === IAC) {
            this.sub.push(IAC)
            this.state = 'sub'
          } else {
            // Malformed subnegotiation; drop back to the data stream.
            this.sub = []
            this.state = 'data'
          }
          break
      }
    }
    return Buffer.from(out)
  }

  private handleOption(command: number, option: number): void {
    if (command === DO) {
      if (option === OPT_TTYPE || option === OPT_NAWS || option === OPT_SGA) {
        this.sendWill(option)
        if (option === OPT_TTYPE) this.sendTerminalType()
        else if (option === OPT_NAWS) {
          this.nawsAgreed = true
          this.sendWindowSize()
        }
      } else {
        this.sendWont(option)
      }
      return
    }
    if (command === WILL) {
      if (option === OPT_ECHO || option === OPT_SGA) this.sendDo(option)
      else this.sendDont(option)
    }
    // DONT / WONT require no reply.
  }

  private handleSubnegotiation(data: Buffer): void {
    // Some servers ask again with SB TTYPE SEND (RFC 1091).
    if (data[0] === OPT_TTYPE && data[1] === TTYPE_SEND) this.sendTerminalType()
  }

  private sendWill(option: number): void {
    if (this.sentWill.has(option)) return
    this.sentWill.add(option)
    this.raw(WILL, option)
  }

  private sendWont(option: number): void {
    if (this.sentWont.has(option)) return
    this.sentWont.add(option)
    this.raw(WONT, option)
  }

  private sendDo(option: number): void {
    if (this.sentDo.has(option)) return
    this.sentDo.add(option)
    this.raw(DO, option)
  }

  private sendDont(option: number): void {
    if (this.sentDont.has(option)) return
    this.sentDont.add(option)
    this.raw(DONT, option)
  }

  private sendTerminalType(): void {
    const name = Buffer.from(this.terminalType, 'ascii')
    this.sendSubnegotiation(Buffer.concat([Buffer.from([OPT_TTYPE, TTYPE_IS]), name]))
  }

  private sendWindowSize(): void {
    const payload = Buffer.alloc(5)
    payload[0] = OPT_NAWS
    payload.writeUInt16BE(this.cols, 1)
    payload.writeUInt16BE(this.rows, 3)
    this.sendSubnegotiation(payload)
  }

  private sendSubnegotiation(payload: Buffer): void {
    this.options.send(Buffer.concat([Buffer.from([IAC, SB]), payload, Buffer.from([IAC, SE])]))
  }

  private raw(command: number, option: number): void {
    this.options.send(Buffer.from([IAC, command, option]))
  }
}

/** Escape IAC bytes and expand a lone CR so servers receive NVT line endings. */
export function encodeTelnetInput(data: string): Buffer {
  const text = data.replace(/\r(?!\n)/g, '\r\n')
  const source = Buffer.from(text, 'utf8')
  if (!source.includes(IAC)) return source
  const out = Buffer.alloc(source.length + source.filter((byte) => byte === IAC).length)
  let offset = 0
  for (const byte of source) {
    out[offset++] = byte
    if (byte === IAC) out[offset++] = IAC
  }
  return out.subarray(0, offset)
}
