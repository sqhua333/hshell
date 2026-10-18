type DataHandler = (data: Uint8Array) => void
type StatusHandler = (status: { status: string; message?: string }) => void

const dataHandlers = new Map<string, Set<DataHandler>>()
const statusHandlers = new Map<string, Set<StatusHandler>>()

export function subscribeRuntimeData(runtimeId: string, handler: DataHandler): () => void {
  let set = dataHandlers.get(runtimeId)
  if (!set) {
    set = new Set()
    dataHandlers.set(runtimeId, set)
  }
  set.add(handler)
  return () => {
    set?.delete(handler)
    if (set?.size === 0) dataHandlers.delete(runtimeId)
  }
}

export function publishRuntimeData(runtimeId: string, data: Uint8Array): void {
  dataHandlers.get(runtimeId)?.forEach((handler) => handler(data))
}

export function subscribeRuntimeStatus(runtimeId: string, handler: StatusHandler): () => void {
  let set = statusHandlers.get(runtimeId)
  if (!set) {
    set = new Set()
    statusHandlers.set(runtimeId, set)
  }
  set.add(handler)
  return () => {
    set?.delete(handler)
    if (set?.size === 0) statusHandlers.delete(runtimeId)
  }
}

export function publishRuntimeStatus(
  runtimeId: string,
  status: { status: string; message?: string }
): void {
  statusHandlers.get(runtimeId)?.forEach((handler) => handler(status))
}
