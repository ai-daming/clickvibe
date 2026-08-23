/** Responsive shell that owns the occupied panel layout. */
import React from 'react'
import { resolveDesktopPanelWidth, resolvePanelLayout } from '../panel-layout.ts'
import { createPortal } from 'react-dom'
import { panelState } from '../panel-state.ts'
import { PanelContent } from './project-panel.tsx'

/**
 * shell.overlay gives us a stable lifecycle anchor. The visible panel is
 * portalled to body while #root gives up the same width, matching the proven
 * better-sidebar layout-push pattern without covering the conversation.
 */
export function OccupiedPanel() {
  const [portalHost, setPortalHost] = React.useState<HTMLDivElement | null>(null)
  const [viewportWidth, setViewportWidth] = React.useState(() => window.innerWidth)
  const [desktopWidth, setDesktopWidth] = React.useState(() =>
    resolveDesktopPanelWidth(window.innerWidth, panelState.desktopWidth),
  )
  const layout = resolvePanelLayout(viewportWidth, desktopWidth)
  const layoutRef = React.useRef(layout)
  const dragRef = React.useRef<{ x: number; width: number } | null>(null)
  const dragFrameRef = React.useRef<number | null>(null)
  const pendingWidthRef = React.useRef<number | null>(null)

  React.useLayoutEffect(() => {
    const root = document.getElementById('root')
    if (!root) return

    const host = document.createElement('div')
    host.className = 'cv-panel-slot'
    document.body.appendChild(host)
    root.classList.add('cv-panel-host-open')
    setPortalHost(host)

    return () => {
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current)
      document.body.removeAttribute('data-cv-panel-dragging')
      root.classList.remove('cv-panel-host-open')
      document.documentElement.style.removeProperty('--cv-sidebar-width')
      host.remove()
    }
  }, [])

  React.useEffect(() => {
    let frame: number | null = null
    const measure = () => {
      frame = null
      setViewportWidth(window.innerWidth)
    }
    const onResize = () => {
      if (frame === null) frame = requestAnimationFrame(measure)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  React.useLayoutEffect(() => {
    layoutRef.current = layout
    if (!portalHost) return
    portalHost.toggleAttribute('data-cv-mobile', layout.mobile)
    portalHost.style.width = layout.mobile ? '100vw' : `${layout.panelWidth}px`
    document.documentElement.style.setProperty('--cv-sidebar-width', `${layout.pushWidth}px`)
  }, [layout.mobile, layout.panelWidth, layout.pushWidth, portalHost])

  const applyDragWidth = (width: number) => {
    if (!portalHost) return
    portalHost.style.width = `${width}px`
    document.documentElement.style.setProperty('--cv-sidebar-width', `${width}px`)
  }

  const scheduleDragWidth = (width: number) => {
    pendingWidthRef.current = width
    if (dragFrameRef.current !== null) return
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null
      const pending = pendingWidthRef.current
      if (pending !== null) {
        pendingWidthRef.current = null
        applyDragWidth(pending)
      }
    })
  }

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const pending = pendingWidthRef.current
    const width = pending ?? resolveDesktopPanelWidth(window.innerWidth, drag.width - (event.clientX - drag.x))
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = null
    }
    pendingWidthRef.current = null
    applyDragWidth(width)
    event.currentTarget.releasePointerCapture(event.pointerId)
    event.currentTarget.removeAttribute('data-dragging')
    dragRef.current = null
    document.body.removeAttribute('data-cv-panel-dragging')
    panelState.desktopWidth = width
    setDesktopWidth(width)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.setAttribute('data-dragging', '')
    dragRef.current = { x: event.clientX, width: layoutRef.current.panelWidth }
    document.body.setAttribute('data-cv-panel-dragging', '')
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    scheduleDragWidth(resolveDesktopPanelWidth(window.innerWidth, drag.width - (event.clientX - drag.x)))
  }

  return (
    <>
      {portalHost
        ? createPortal(
            <>
              {!layout.mobile && (
                <div
                  className="cv-panel-resizer"
                  role="separator"
                  aria-label="调整 ClickVibe 面板宽度"
                  aria-orientation="vertical"
                  aria-valuenow={layout.panelWidth}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={finishDrag}
                  onPointerCancel={finishDrag}
                />
              )}
              <PanelContent />
            </>,
            portalHost,
          )
        : null}
    </>
  )
}
