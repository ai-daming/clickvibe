import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
/**
 * clickvibe client half: the right-side issue/PR panel.
 *
 * Registers:
 * - `shell.overlay` (id `clickvibe`) — the mount anchor for the occupied panel,
 * - `sidebar.footer.action` (id `clickvibe`) — the toggle button.
 *
 * Fetching goes through the plugin's own `/clickvibe/api/fetch` route
 * (no harness RPC — this is a formal bundle plugin, not a dynamic one).
 */
import React from 'react'

export const PANEL_ID = 'clickvibe'

export const MAX_BATCH_ISSUES = 10

/**
 * DSH 客户端上下文:apply 时捕获。「在 DSH 对话中打开」按钮经它解析
 * workspaces / sessions / conversation 服务(运行时由宿主注入)。
 */
export let clientCtx: ClientContext | null = null

export function setClientContext(value: ClientContext): void {
  clientCtx = value
}

export function getClientContext(): ClientContext | null {
  return clientCtx
}

/** Panel open state shared between the footer toggle and the overlay. */
export const panelState: {
  open: boolean
  desktopWidth?: number
  listeners: Set<(value: boolean) => void>
} = { open: false, listeners: new Set() }

export function setPanelOpen(value: boolean): void {
  panelState.open = value
  for (const fn of panelState.listeners) fn(value)
}

export function usePanelOpen(): boolean {
  const [open, setOpen] = React.useState(panelState.open)
  React.useEffect(() => {
    const listener = (v: boolean) => setOpen(v)
    panelState.listeners.add(listener)
    return () => { panelState.listeners.delete(listener) }
  }, [])
  return open
}
