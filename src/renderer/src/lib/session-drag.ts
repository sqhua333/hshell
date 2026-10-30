/**
 * Drag payload for moving a session from the sidebar onto a terminal pane, or
 * within the sidebar to reorder it. A custom MIME type keeps unrelated text
 * drops from triggering a split.
 */
export const SESSION_DRAG_MIME = 'application/x-hshell-session'

export function setSessionDragData(dataTransfer: DataTransfer, sessionId: string): void {
  dataTransfer.setData(SESSION_DRAG_MIME, sessionId)
  // Some platforms only expose plain text during a drag; the custom type stays
  // authoritative and `types` is all we inspect while hovering.
  dataTransfer.setData('text/plain', sessionId)
  // The terminal "copies" the session into a new pane, while the sidebar moves
  // the entry, so both effects must be offered or the cursor shows a no-drop
  // sign over one of the two targets.
  dataTransfer.effectAllowed = 'copyMove'
}

export function readSessionDragId(dataTransfer: DataTransfer): string | null {
  return dataTransfer.getData(SESSION_DRAG_MIME) || null
}

export function isSessionDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer ? Array.from(dataTransfer.types).includes(SESSION_DRAG_MIME) : false
}

/**
 * Drag payload for an already-open tab. Dropping it on the terminal merges the
 * tab into the target tab as a split, so two open sessions can be shown side
 * by side without going back to the sidebar.
 */
export const TAB_DRAG_MIME = 'application/x-hshell-tab'

export function setTabDragData(dataTransfer: DataTransfer, tabId: string): void {
  dataTransfer.setData(TAB_DRAG_MIME, tabId)
  dataTransfer.setData('text/plain', tabId)
  dataTransfer.effectAllowed = 'move'
}

export function readTabDragId(dataTransfer: DataTransfer): string | null {
  return dataTransfer.getData(TAB_DRAG_MIME) || null
}

export function isTabDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer ? Array.from(dataTransfer.types).includes(TAB_DRAG_MIME) : false
}
