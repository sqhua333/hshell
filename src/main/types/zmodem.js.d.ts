/**
 * Minimal typings for `zmodem.js` (CommonJS, no bundled types).
 * Only the APIs HShell uses are described.
 */
declare module 'zmodem.js' {
  export interface ZmodemFileDetails {
    name: string
    size?: number | null
    mtime?: Date | number | null
    mode?: number | null
    serial?: number | null
    files_remaining?: number | null
    bytes_remaining?: number | null
  }

  export interface ZmodemTransfer {
    send(data: Uint8Array | number[]): void
    end(data?: Uint8Array | number[]): Promise<void>
    get_offset(): number
  }

  export interface ZmodemOffer {
    get_details(): ZmodemFileDetails
    accept(opts?: {
      on_input?: ((chunk: Uint8Array) => void) | 'spool_uint8array' | 'spool_array'
      offset?: number
    }): Promise<unknown>
    skip(): void
  }

  export interface ZmodemSession {
    type: 'send' | 'receive'
    set_sender(sender: (octets: number[]) => void): void
    consume(octets: number[] | Uint8Array): void
    has_ended(): boolean
    start(): Promise<ZmodemOffer | undefined>
    abort(): void
    close(): Promise<void>
    send_offer(params: ZmodemFileDetails): Promise<ZmodemTransfer | undefined>
    on(event: 'session_end', handler: () => void): void
    on(event: 'garbage', handler: (octets: number[]) => void): void
    on(event: 'offer', handler: (offer: ZmodemOffer) => void): void
    on(event: string, handler: (...args: never[]) => void): void
  }

  export interface ZmodemHeader {
    to_hex(): number[]
  }

  export interface ZmodemLibrary {
    Session: {
      parse(octets: number[]): ZmodemSession | undefined
    }
    Header: {
      build(name: string, ...args: unknown[]): ZmodemHeader
    }
  }

  const Zmodem: ZmodemLibrary
  export default Zmodem
}
