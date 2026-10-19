/**
 * Drag payload for moving a session from the sidebar onto a terminal pane.
 * A custom MIME type keeps unrelated text drops from triggering a split.
 */
export const SESSION_DRAG_MIME = 'application/x-hshell-session'

export function setSessionDragData(dataTransfer: DataTransfer, sessionId: string): void {
  dataTransfer.setData(SESSION_DRAG_MIME, sessionId)
  // Some platforms only expose plain text during a drag; the custom type stays
  // authoritative and `types` is all we inspect while hovering.
  dataTransfer.setData('text/plain', sessionId)
  dataTransfer.effectAllowed = 'copy'
}

export function readSessionDragId(dataTransfer: DataTransfer): string | null {
  return dataTransfer.getData(SESSION_DRAG_MIME) || null
}

export function isSessionDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer ? Array.from(dataTransfer.types).includes(SESSION_DRAG_MIME) : false
}
