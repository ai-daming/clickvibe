/** ClickVibe client composition root. */
// Type references that load the SlotMap augmentations for the slots this
// bundle registers into (shell.overlay, sidebar.footer.action). Importing
// a named type from each package's /client face forces TS to load its
// client d.ts, whose `declare module '@deepseek-ai/dsh-client-ui-slots'`
// merges the slot names.
import type { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { PANEL_ID, panelState, setClientContext, setPanelOpen, usePanelOpen } from './panel-state.ts'
import { installStyles } from './styles.ts'
import { OccupiedPanel } from './views/occupied-panel.tsx'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type _SlotLoaders = [typeof LayoutController, SidebarFooterActionOwnerProps]

export const name = 'clickvibe-client'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  setClientContext(ctx)

  ctx.effect(() => {
    const disposers: (() => void)[] = [installStyles()]

    disposers.push(slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: PANEL_ID, order: 20 },
      () => {
        const open = usePanelOpen()
        if (!open) return null
        return <OccupiedPanel />
      },
    )))

    disposers.push(slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: PANEL_ID, order: 20 },
      (props: { wide: boolean }) => (
        <button
          className="cv-toggle"
          title="ClickVibe"
          onClick={() => setPanelOpen(!panelState.open)}
        >
          {props.wide ? 'ClickVibe' : 'CV'}
        </button>
      ),
    )))

    return () => { for (const dispose of disposers) dispose() }
  }, 'clickvibe: styles, panel and toggle')
}
