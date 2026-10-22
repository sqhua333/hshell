import { describe, expect, it } from 'vitest'
import {
  DO,
  DONT,
  IAC,
  OPT_NAWS,
  OPT_SGA,
  OPT_TTYPE,
  SB,
  SE,
  WILL,
  WONT,
  TelnetProtocol,
  encodeTelnetInput
} from '../../src/main/telnet/protocol'

function createProtocol(): { protocol: TelnetProtocol; sent: Buffer[] } {
  const sent: Buffer[] = []
  const protocol = new TelnetProtocol({
    send: (data) => sent.push(data),
    terminalType: 'xterm-256color'
  })
  return { protocol, sent }
}

describe('TelnetProtocol', () => {
  it('announces TTYPE, NAWS and SGA on start', () => {
    const { protocol, sent } = createProtocol()
    protocol.start()
    const joined = Buffer.concat(sent)
    expect([...joined]).toEqual([
      IAC, WILL, OPT_TTYPE,
      IAC, WILL, OPT_NAWS,
      IAC, WILL, OPT_SGA
    ])
  })

  it('strips negotiation and returns application data', () => {
    const { protocol } = createProtocol()
    const data = protocol.feed(
      Buffer.from([IAC, DO, OPT_SGA, ...Buffer.from('hello\r\n'), IAC, 1])
    )
    expect(data.toString()).toBe('hello\r\n')
  })

  it('reports the terminal type when the server requests TTYPE', () => {
    const { protocol, sent } = createProtocol()
    protocol.start()
    sent.length = 0
    protocol.feed(Buffer.from([IAC, DO, OPT_TTYPE]))
    const reply = Buffer.concat(sent)
    // WILL was already sent by start(); the answer is just the IS payload.
    expect([...reply.subarray(0, 4)]).toEqual([IAC, SB, OPT_TTYPE, 0])
    expect(reply.toString('ascii')).toContain('xterm-256color')
  })

  it('sends NAWS after the server agrees, using the current size', () => {
    const { protocol, sent } = createProtocol()
    protocol.start()
    protocol.setWindowSize(120, 40)
    sent.length = 0
    // Nothing may be sent before the server's DO NAWS.
    expect(sent).toHaveLength(0)
    protocol.feed(Buffer.from([IAC, DO, OPT_NAWS]))
    const reply = Buffer.concat(sent)
    // WILL NAWS was sent by start(); only the agreed subnegotiation is new.
    expect([...reply]).toEqual([IAC, SB, OPT_NAWS, 0, 120, 0, 40, IAC, SE])
  })

  it('updates NAWS after the size changes', () => {
    const { protocol, sent } = createProtocol()
    protocol.start()
    protocol.feed(Buffer.from([IAC, DO, OPT_NAWS]))
    sent.length = 0
    protocol.setWindowSize(80, 24)
    expect([...Buffer.concat(sent)]).toEqual([
      IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE
    ])
  })

  it('refuses unknown options and accepts ECHO/SGA from the server', () => {
    const { protocol, sent } = createProtocol()
    protocol.start()
    sent.length = 0
    protocol.feed(Buffer.from([IAC, DO, 99, IAC, WILL, 1, IAC, WILL, 99]))
    const replies = sent.map((item) => [...item])
    expect(replies).toContainEqual([IAC, WONT, 99])
    expect(replies).toContainEqual([IAC, DO, 1])
    expect(replies).toContainEqual([IAC, DONT, 99])
  })

  it('unescapes IAC IAC in the data stream', () => {
    const { protocol } = createProtocol()
    const data = protocol.feed(Buffer.from([0x61, IAC, IAC, 0x62]))
    expect([...data]).toEqual([0x61, 0xff, 0x62])
  })

  it('does not answer DONT/WONT', () => {
    const { protocol, sent } = createProtocol()
    protocol.start()
    sent.length = 0
    protocol.feed(Buffer.from([IAC, DONT, OPT_SGA, IAC, WONT, OPT_TTYPE]))
    expect(sent).toHaveLength(0)
  })
})

describe('encodeTelnetInput', () => {
  it('expands a bare CR to CRLF but keeps existing CRLF intact', () => {
    expect(encodeTelnetInput('a\rb').toString()).toBe('a\r\nb')
    expect(encodeTelnetInput('a\r\nb').toString()).toBe('a\r\nb')
  })
})
