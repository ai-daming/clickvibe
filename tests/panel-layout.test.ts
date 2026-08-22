import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MOBILE_BREAKPOINT,
  resolveDesktopPanelWidth,
  resolvePanelLayout,
} from '../src/client/panel-layout.ts'

test('desktop panel defaults to 25% of the viewport', () => {
  assert.equal(resolveDesktopPanelWidth(1200), 300)
  assert.equal(resolveDesktopPanelWidth(2000), 500)
})

test('desktop panel clamps dragged widths to the viewport with a 280px minimum', () => {
  assert.equal(resolveDesktopPanelWidth(800), 280)
  assert.equal(resolveDesktopPanelWidth(1200, 100), 280)
  assert.equal(resolveDesktopPanelWidth(1200, 1000), 1000)
  assert.equal(resolveDesktopPanelWidth(500, 900), 500)
})

test('mobile panel occupies the viewport without pushing the host below 768px', () => {
  assert.deepEqual(resolvePanelLayout(MOBILE_BREAKPOINT - 1, 300), {
    mobile: true,
    panelWidth: 767,
    pushWidth: 0,
  })
  assert.deepEqual(resolvePanelLayout(MOBILE_BREAKPOINT), {
    mobile: false,
    panelWidth: 280,
    pushWidth: 280,
  })
})
