export const MOBILE_BREAKPOINT = 768
export const DEFAULT_PANEL_RATIO = 0.25
export const PANEL_MIN = 280

/**
 * Resolve the desktop panel width against the viewport. A dragged width wins;
 * otherwise the panel starts at roughly one quarter of the viewport, matching
 * better-sidebar's percentage-based default.
 */
export function resolveDesktopPanelWidth(viewportWidth: number, preferredWidth?: number): number {
  const viewport = Math.max(0, Math.round(viewportWidth))
  const upper = Math.max(PANEL_MIN, viewport)
  const requested = preferredWidth ?? viewport * DEFAULT_PANEL_RATIO
  return Math.round(Math.min(upper, Math.max(PANEL_MIN, requested)))
}

/**
 * The mobile drawer fills the viewport but deliberately does not push #root:
 * a 100vw occupied drawer has no useful main-column space left to preserve.
 */
export function resolvePanelLayout(
  viewportWidth: number,
  preferredWidth?: number,
): { mobile: boolean; panelWidth: number; pushWidth: number } {
  if (viewportWidth < MOBILE_BREAKPOINT) {
    return {
      mobile: true,
      panelWidth: Math.max(0, Math.round(viewportWidth)),
      pushWidth: 0,
    }
  }
  const panelWidth = resolveDesktopPanelWidth(viewportWidth, preferredWidth)
  return {
    mobile: false,
    panelWidth,
    pushWidth: panelWidth,
  }
}
