import { PANEL_ID } from './panel-state.ts'

// ---- plugin-owned styles (injected once at activation) ----

export const PANEL_CSS = `
/* ClickVibe semantic palette: start */
.cv-panel-slot { --cv-review-primary: #8250df; --cv-review-tertiary: #fbefff; }
body[data-ds-dark-theme] .cv-panel-slot { --cv-review-primary: #d2a8ff; --cv-review-tertiary: #3b254a; }
/* ClickVibe semantic palette: end */
#root.cv-panel-host-open { margin-right: calc(var(--dsh-sidebar-width, 0px) + var(--cv-sidebar-width, 0px)); width: calc(100% - var(--dsh-sidebar-width, 0px) - var(--cv-sidebar-width, 0px)); transition: margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out), width var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.cv-panel-slot { position: fixed; z-index: 50; top: 0; right: var(--dsh-sidebar-width, 0px); bottom: 0; width: var(--cv-sidebar-width); min-width: 0; overflow: visible; pointer-events: auto; transition: right var(--ds-transition-duration-slow) var(--ds-ease-in-out), width var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.cv-panel-slot[data-cv-mobile] { right: 0; width: 100vw; }
.cv-panel { width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l2); box-sizing: border-box; font-size: 13px; color: var(--dsw-alias-label-primary); }
.cv-panel-resizer { position: absolute; z-index: 2; top: 0; bottom: 0; left: -5px; width: 10px; cursor: col-resize; touch-action: none; }
.cv-panel-resizer::after { content: ''; position: absolute; top: 50%; left: 50%; width: 4px; height: 36px; border-radius: 3px; background: var(--dsw-alias-label-caption); opacity: 0; transform: translate(-50%, -50%); transition: opacity 120ms ease; }
.cv-panel-resizer:hover::after, .cv-panel-resizer:focus-visible::after, .cv-panel-resizer[data-dragging]::after { opacity: .75; }
body[data-cv-panel-dragging] #root.cv-panel-host-open, body[data-cv-panel-dragging] .cv-panel-slot { transition: none; }
@media (prefers-reduced-motion: reduce) { #root.cv-panel-host-open, .cv-panel-slot { transition: none; } }
.cv-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; font-weight: 600; color: var(--dsw-alias-label-primary); border-bottom: 1px solid var(--dsw-alias-border-l2); flex-shrink: 0; }
.cv-panel-header-actions { display: flex; align-items: center; gap: 6px; }
.cv-close { border: none; background: transparent; cursor: pointer; font-size: 14px; color: var(--dsw-alias-label-secondary); }
.cv-close:hover { color: var(--dsw-alias-label-primary); }
.cv-input-row { display: flex; gap: 6px; padding: 4px 14px; flex-shrink: 0; }
.cv-input-row:last-of-type { padding-bottom: 10px; }
.cv-project-toolbar { padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); display: grid; gap: 8px; }
.cv-project-selects { display: flex; gap: 6px; }
.cv-project-import { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cv-project-import span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-batch-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cv-batch-btn { border: none; border-radius: 6px; padding: 6px 9px; background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground); font-size: 11px; font-weight: 600; cursor: pointer; }
.cv-batch-btn:disabled { opacity: .5; cursor: not-allowed; }
.cv-batch-btn.cv-batch-secondary { background: var(--dsw-alias-button-contrast-fill); }
.cv-batch-agent { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; overflow: hidden; }
.cv-batch-agent button { border: none; padding: 5px 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; }
.cv-batch-agent button.on { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.cv-batch-status { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cv-row-select { margin: 0; accent-color: var(--dsw-alias-state-business-primary); }
.cv-select { min-width: 0; flex: 1; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); padding: 6px 8px; color: var(--dsw-alias-label-primary); }
.cv-project-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cv-project-list { flex: 1; overflow-y: auto; padding: 8px 10px 16px; }
.cv-group-title { margin: 10px 2px 5px; color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 700; }
.cv-issue-row { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 9px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; margin-bottom: 6px; background: var(--dsw-alias-bg-base); }
.cv-issue-row-main { min-width: 0; container-type: inline-size; }
.cv-issue-row-title { display: block; color: var(--dsw-alias-state-business-primary); font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.cv-issue-row-meta { color: var(--dsw-alias-label-secondary); font-size: 10.5px; margin-top: 3px; display: grid; gap: 2px; min-width: 0; }
.cv-row-meta-layer { display: flex; align-items: center; gap: 5px; min-width: 0; overflow: hidden; }
.cv-row-meta-signals { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 2px 8px; overflow: visible; }
.cv-row-meta-item { display: inline-flex; align-items: baseline; gap: 3px; min-width: 0; max-width: 100%; white-space: nowrap; }
.cv-row-meta-item + .cv-row-meta-item::before { content: '·'; color: var(--dsw-alias-label-caption); margin-right: 2px; flex: none; }
.cv-row-meta-primary .cv-row-meta-item:first-child { flex: 1 1 auto; }
.cv-row-meta-primary .cv-row-meta-item:nth-child(2) { flex: none; }
.cv-row-meta-signals .cv-row-meta-item::before { content: none; }
.cv-row-meta-label { color: var(--dsw-alias-label-caption); flex: none; }
.cv-row-meta-value { color: var(--dsw-alias-label-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
@container (max-width: 240px) { .cv-row-meta-secondary { display: none; } }
.cv-issue-row-main .cv-running-duration { display: block; margin-top: 3px; color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.cv-row-lag { color: var(--dsw-alias-state-warn-label); font-weight: 600; }
.cv-row-contract { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.cv-row-ready { color: var(--dsw-alias-state-success-primary); font-weight: 600; }
:is(.cv-row-lag, .cv-row-contract, .cv-row-ready) .cv-row-meta-value { color: inherit; }
.cv-row-action { border: none; border-radius: 6px; padding: 5px 8px; background: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-label-primary-foreground); font-size: 11px; white-space: nowrap; cursor: pointer; }
.cv-row-action.cv-row-none { background: var(--dsw-alias-button-primary-dimmed); cursor: default; }
.cv-row-action.cv-row-running { background: var(--dsw-alias-state-business-primary); cursor: default; }
.cv-back { border: none; background: transparent; color: var(--dsw-alias-state-business-primary); cursor: pointer; padding: 0; font-size: 12px; }
.cv-input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; }
.cv-input::placeholder { color: var(--dsw-alias-label-caption); }
.cv-fetch { padding: 6px 12px; border: none; border-radius: 6px; background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground); cursor: pointer; font-size: 12px; }
.cv-fetch:disabled { opacity: 0.6; }
.cv-error { margin: 0 14px 10px; padding: 8px 10px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); border: 1px solid var(--dsw-alias-state-error-secondary); flex-shrink: 0; }
.cv-stale { margin: 8px 12px 0; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); border: 1px solid var(--dsw-alias-state-warn-secondary); font-size: 11.5px; flex-shrink: 0; }
.cv-repo-advance { margin: 8px 12px 0; padding: 7px 8px; border-radius: 6px; background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); border: 1px solid var(--dsw-alias-state-warn-secondary); font-size: 11.5px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cv-hint { padding: 20px 14px; color: var(--dsw-alias-label-caption); text-align: center; }
.cv-loading { padding: 20px 14px; color: var(--dsw-alias-label-secondary); text-align: center; }
.cv-issue { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; flex: 1; overflow-y: auto; }
.cv-issue-head { display: flex; gap: 6px; align-items: center; }
.cv-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
.cv-badge-open { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.cv-badge-closed { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.cv-badge-merged { background: var(--cv-review-tertiary); color: var(--cv-review-primary); }
.cv-badge-kind { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-secondary); }
.cv-issue-title { font-size: 15px; font-weight: 700; color: var(--dsw-alias-state-business-primary); text-decoration: none; }
.cv-issue-title:hover { text-decoration: underline; }
.cv-dsh-open-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cv-dsh-open-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); border-radius: 6px; padding: 4px 10px; font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.cv-dsh-open-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
.cv-dsh-open-btn:disabled { opacity: .55; cursor: not-allowed; }
.cv-dsh-open-status { font-size: 11px; color: var(--dsw-alias-state-warn-label); word-break: break-all; }
.cv-issue-labels { display: flex; flex-wrap: wrap; gap: 4px; font-size: 11px; }
.cv-issue-labels span { padding: 1px 6px; border-radius: 10px; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }
.cv-issue-assignees { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cv-meta { width: 100%; border-collapse: collapse; font-size: 12px; }
.cv-meta tr { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.cv-meta tr:last-child { border-bottom: none; }
.cv-meta-k { width: 52px; padding: 3px 0; color: var(--dsw-alias-label-caption); vertical-align: top; }
.cv-meta-v { padding: 3px 0; color: var(--dsw-alias-label-primary); word-break: break-all; }
.cv-issue-body { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 10px; font-size: 12.5px; }
.cv-comments { display: flex; flex-direction: column; gap: 6px; }
.cv-comments-empty { font-size: 12px; color: var(--dsw-alias-label-caption); padding: 4px 0; }
.cv-comments-toggle { border: none; background: transparent; cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-state-business-primary); padding: 2px 0; text-align: left; }
.cv-comment { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px 10px; }
.cv-comment-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 11.5px; }
.cv-comment-author { font-weight: 600; color: var(--dsw-alias-state-business-primary); }
.cv-comment-date { color: var(--dsw-alias-label-caption); }
.cv-toggle { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-primary); }
:where(.cv-panel, .cv-terminal-overlay, .cv-audit-drawer) :is(button, select, input, textarea, a, summary):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; border-radius: 4px; }
:where(.cv-toggle, .cv-issue-organizer):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; border-radius: 4px; }
.cv-toggle:hover { background: var(--dsw-alias-interactive-bg-hover-solid); }
.cv-issue-organizer { border: 0; border-radius: 6px; padding: 4px 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; white-space: nowrap; cursor: pointer; }
.cv-issue-organizer:hover { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-primary); }
.cv-md { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-primary); word-break: break-word; }
.cv-md p { margin: 0 0 8px; }
.cv-md h1, .cv-md h2, .cv-md h3, .cv-md h4, .cv-md h5, .cv-md h6 { margin: 10px 0 6px; font-weight: 600; }
.cv-md h1 { font-size: 18px; }
.cv-md h2 { font-size: 16px; }
.cv-md h3 { font-size: 14.5px; }
.cv-md h4, .cv-md h5, .cv-md h6 { font-size: 13.5px; }
.cv-md pre { background: var(--dsw-alias-markdown-code-block); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 10px; overflow-x: auto; margin: 0 0 8px; }
.cv-md pre code { background: transparent; padding: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre; }
.cv-md :not(pre) > code { background: var(--dsw-alias-markdown-inline-code); padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.cv-md-code { background: var(--dsw-alias-markdown-inline-code); padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.cv-md a { color: var(--dsw-alias-state-business-primary); }
.cv-md ul { padding-left: 20px; list-style: disc; margin: 0 0 8px; }
.cv-md ol { padding-left: 20px; list-style: decimal; margin: 0 0 8px; }
.cv-md blockquote { border-left: 4px solid var(--dsw-alias-border-l2); padding-left: 10px; margin: 0 0 8px; color: var(--dsw-alias-label-secondary); }
.cv-md hr { border: none; border-top: 1px solid var(--dsw-alias-border-l2); margin: 10px 0; }
.cv-md table { border-collapse: collapse; width: 100%; margin: 0 0 8px; font-size: 12.5px; }
.cv-md th, .cv-md td { border: 1px solid var(--dsw-alias-border-l2); padding: 4px 8px; text-align: left; vertical-align: top; }
.cv-md th { background: var(--dsw-alias-interactive-bg-hover-solid); font-weight: 600; }
.cv-md input[type="checkbox"] { margin-right: 6px; accent-color: var(--dsw-alias-state-business-primary); pointer-events: none; }
.cv-md img { max-width: 100%; }
.cv-dev { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.cv-dev-head { font-weight: 600; font-size: 12.5px; color: var(--dsw-alias-label-primary); }
.cv-dev-actions { display: flex; gap: 6px; }
.cv-auto-run { position: relative; margin: 6px 0; }
.cv-auto-run-trigger { border: 1px solid var(--dsw-alias-state-business-primary); border-radius: 6px; padding: 6px 9px; background: transparent; color: var(--dsw-alias-state-business-primary); cursor: pointer; font-size: 11px; font-weight: 600; }
.cv-auto-run-trigger:disabled { opacity: .65; cursor: not-allowed; }
.cv-auto-run-form { display: grid; gap: 7px; margin-top: 6px; padding: 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-base); min-width: 220px; }
.cv-auto-run-compact .cv-auto-run-form { position: absolute; z-index: 20; right: 0; width: 240px; box-shadow: 0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.cv-auto-run-form label { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cv-auto-run-form select, .cv-auto-run-form input[type="number"] { width: 100px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.cv-auto-run-form .cv-auto-run-check { justify-content: flex-start; }
.cv-auto-run-status, .cv-auto-run-findings { margin-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 10.5px; }
.cv-auto-run-paused { color: var(--dsw-alias-state-warn-primary); }
.cv-row-actions { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.cv-row-actions .cv-auto-run { margin: 0; }
.cv-dev-btn { padding: 5px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary-foreground); }
.cv-dev-codex { background: var(--dsw-alias-button-primary-fill); }
.cv-dev-claude { background: var(--dsw-alias-state-warn-primary); }
.cv-dev-btn:hover { opacity: 0.85; }
.cv-dev-status { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cv-dev-path { font-size: 11px; color: var(--dsw-alias-label-caption); word-break: break-all; margin-top: 2px; }
.cv-dev-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger); border: 1px solid var(--dsw-alias-state-error-secondary); border-radius: 4px; padding: 6px 8px; }
/* Fixed dark terminal palette: start */
.cv-terminal { position: relative; display: flex; flex-direction: column; min-height: 0; overflow: hidden; border: 1px solid #30363d; border-radius: 8px; background: #0d1117; color: #e6edf3; box-shadow: inset 0 1px 0 rgb(255 255 255 / 4%); }
.cv-terminal-head { min-height: 32px; padding: 0 8px 0 10px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #21262d; background: #161b22; font: 600 10.5px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; color: #8b949e; }
.cv-terminal-head .cv-running-duration { color: inherit; font: inherit; }
.cv-terminal-agent { color: #58a6ff; text-transform: uppercase; letter-spacing: .04em; }
.cv-terminal-agent[data-agent="claude"] { color: #f2a65a; }
.cv-terminal-spacer { flex: 1; }
.cv-terminal-detach { border: 0; border-radius: 4px; padding: 3px 6px; background: #21262d; color: #c9d1d9; cursor: pointer; font: inherit; }
.cv-terminal-detach:hover { background: #30363d; }
.cv-dev-log { min-height: 72px; max-height: 200px; overflow: auto; overscroll-behavior: contain; padding: 8px 10px; font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; word-break: normal; overflow-wrap: normal; scrollbar-color: #30363d #0d1117; }
.cv-terminal-line, .cv-terminal-block { min-height: 1.55em; }
.cv-terminal-block-text { width: max-content; min-width: 100%; white-space: pre; }
.cv-terminal-row { display: grid; grid-template-columns: 3.5em max-content; min-width: 100%; min-height: 1.55em; }
.cv-terminal-line-number { padding-right: 1em; color: #6e7681; text-align: right; user-select: none; }
.cv-terminal-line-content { white-space: pre; }
.cv-terminal-block-toggle { margin: 3px 0 5px 3.5em; padding: 2px 7px; border: 1px solid #30363d; border-radius: 4px; background: #161b22; color: #8b949e; cursor: pointer; font: inherit; }
.cv-terminal-block-toggle:hover { border-color: #484f58; color: #c9d1d9; background: #21262d; }
.cv-terminal-line-system { margin: 2px 0; padding: 1px 5px; border-left: 2px solid #58a6ff; color: #79c0ff; background: rgb(56 139 253 / 9%); }
.cv-terminal-line-stage { color: #d2a8ff; }
.cv-terminal-line-command { color: #7ee787; font-weight: 600; }
.cv-terminal-line-command_output { padding-left: 12px; color: #b1bac4; }
.cv-terminal-line-reasoning, .cv-terminal-line-thinking { color: #8b949e; font-style: italic; }
.cv-terminal-line-tool { color: #ffa657; }
.cv-terminal-line-message { color: #f0f6fc; }
.cv-terminal-overlay { position: fixed; z-index: 10000; inset: 32px; display: flex; padding: 0; background: #0d1117; border-radius: 10px; box-shadow: 0 16px 48px rgb(1 4 9 / 55%); }
.cv-terminal-overlay::before { content: ''; position: fixed; z-index: -1; inset: 0; background: rgb(1 4 9 / 62%); }
.cv-terminal-overlay .cv-terminal { width: 100%; border-radius: inherit; }
.cv-terminal-overlay .cv-dev-log { flex: 1; max-height: none; font-size: 13px; }
/* Fixed dark terminal palette: end */
.cv-log-history { border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover-solid); }
.cv-log-history summary { padding: 5px 8px; cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-weight: 600; }
@media (max-width: 767px) { .cv-terminal-overlay { inset: 0; border-radius: 0; } .cv-terminal-overlay .cv-dev-log { font-size: 12px; } }
.cv-dev-done { font-size: 12px; color: var(--dsw-alias-state-success-primary); font-weight: 600; }
.cv-stage { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; margin-left: 6px; }
.cv-stage-idle { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-secondary); }
.cv-stage-developing { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }
.cv-stage-review-ready { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.cv-stage-reviewing { background: var(--cv-review-tertiary); color: var(--cv-review-primary); }
.cv-stage-passed { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.cv-running-duration { color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: nowrap; }
.cv-dev-btn.cv-dev-warn { background: var(--dsw-alias-state-warn-secondary); color: var(--dsw-alias-label-primary-foreground); }
.cv-dev-btn.cv-dev-review { background: var(--cv-review-primary); color: var(--dsw-alias-label-primary-foreground); }
.cv-review-fail { display: flex; flex-direction: column; gap: 6px; }
.cv-review-issues { margin: 0; padding-left: 18px; font-size: 12px; color: var(--dsw-alias-label-primary); }
.cv-review-issues li { margin: 2px 0; }
.cv-refresh { padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 14px; line-height: 1; }
.cv-refresh:hover { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-primary); }
.cv-links { display: flex; flex-direction: column; gap: 4px; }
.cv-section { min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; overflow: clip; }
.cv-section-head { position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-base); }
.cv-section-toggle { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 0; padding: 7px 9px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }
.cv-section-toggle:hover { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-primary); }
.cv-section-content { max-height: min(360px, 55vh); overflow: auto; overscroll-behavior: contain; padding: 7px 9px 9px; border-top: 1px solid var(--dsw-alias-border-l1); }
.cv-dep-block { display: flex; flex-direction: column; gap: 4px; }
.cv-dep-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.cv-link-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); flex-wrap: wrap; }
.cv-link { color: var(--dsw-alias-state-business-primary); font-weight: 600; text-decoration: none; }
.cv-link:hover { text-decoration: underline; }
.cv-link-state { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10.5px; font-weight: 600; }
.cv-link-state-open { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.cv-link-state-closed { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.cv-link-state-merged { background: var(--cv-review-tertiary); color: var(--cv-review-primary); }
.cv-link-state-open { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.cv-link-kind { font-size: 10.5px; font-weight: 700; color: var(--dsw-alias-label-secondary); }
.cv-pr-icon { flex-shrink: 0; display: inline-block; }
.cv-pr-open { color: var(--dsw-alias-state-success-primary); }
.cv-pr-merged { color: var(--cv-review-primary); }
.cv-pr-closed { color: var(--dsw-alias-state-error-primary); }
.cv-issue-open { color: var(--dsw-alias-state-success-primary); }
.cv-issue-closed { color: var(--cv-review-primary); }
.cv-link-state-issue-closed { background: var(--cv-review-tertiary); color: var(--cv-review-primary); }
.cv-stage-new { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.cv-timeline { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.cv-timeline-head { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.cv-tl-row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.cv-tl-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 3px 4px; border: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.cv-tl-open:hover { background: var(--dsw-alias-interactive-bg-hover-solid); }
.cv-tl-summary { color: var(--dsw-alias-label-primary); font-weight: 600; }
.cv-tl-kind { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10.5px; font-weight: 600; }
.cv-tl-kind-dev { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }
.cv-tl-kind-rework { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.cv-tl-kind-review { background: var(--cv-review-tertiary); color: var(--cv-review-primary); }
.cv-tl-kind-resume { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-secondary); }
.cv-tl-kind-note { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-secondary); }
.cv-tl-kind-merge-override { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.cv-override-entry { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; margin: 4px 0; }
.cv-override-gates { margin: 0; padding-left: 18px; font-size: 11.5px; color: var(--dsw-alias-state-warn-label); }
.cv-tl-time { color: var(--dsw-alias-label-caption); }
.cv-tl-duration { color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; }
.cv-tl-hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; background: var(--dsw-alias-markdown-inline-code); padding: 0 4px; border-radius: 4px; }
.cv-tl-verdict { font-weight: 600; }
.cv-tl-pass { color: var(--dsw-alias-state-success-primary); }
.cv-tl-fail { color: var(--dsw-alias-state-error-primary); }
.cv-tl-note { color: var(--dsw-alias-label-secondary); }
.cv-tl-public { color: var(--dsw-alias-state-business-primary); font-weight: 600; text-decoration: none; }
.cv-tl-public:hover { text-decoration: underline; }
.cv-tl-local { color: var(--dsw-alias-label-caption); }
.cv-tl-publish-fail { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.cv-audit-backdrop { position: fixed; z-index: 10020; inset: 0; background: var(--dsw-alias-bg-mask-2); }
.cv-audit-drawer { position: absolute; top: 0; right: 0; bottom: 0; width: min(480px, 92vw); overflow: auto; padding: 18px; background: var(--dsw-alias-bg-base); box-shadow: var(--dsw-shadow-lv3); color: var(--dsw-alias-label-primary); }
.cv-audit-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.cv-audit-close { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 26px; line-height: 1; cursor: pointer; }
.cv-audit-summary { margin-top: 12px; padding: 8px 10px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover-solid); font-size: 12px; font-weight: 600; }
.cv-audit-section { margin-top: 16px; font-size: 12px; overflow-wrap: anywhere; }
.cv-audit-section h4 { margin: 0 0 7px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cv-audit-muted { color: var(--dsw-alias-label-caption); font-size: 11px; }
.cv-audit-list { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 7px; }
.cv-audit-commits code { margin-right: 5px; }
.cv-audit-diffstat { list-style: none; padding-left: 0; }
.cv-audit-diffstat li { display: flex; justify-content: space-between; gap: 12px; }
.cv-audit-diffstat span { overflow-wrap: anywhere; }
.cv-audit-log { margin-top: 16px; border: 1px solid var(--dsw-alias-state-business-primary); border-radius: 6px; padding: 7px 10px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-state-business-primary); font-size: 11px; cursor: pointer; }
.cv-delivery-summary { font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover-solid); border-radius: 4px; padding: 6px 8px; }
.cv-review-next { font-size: 12px; font-weight: 600; }
.cv-state { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.cv-state-head { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.cv-state-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.cv-state-table td { padding: 3px 0; vertical-align: top; }
.cv-state-k { width: 78px; color: var(--dsw-alias-label-caption); font-weight: 600; }
.cv-state-v { color: var(--dsw-alias-label-primary); word-break: break-all; }
.cv-state-delta { display: block; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.cv-state-warn { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 8px; background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); font-weight: 600; font-size: 10.5px; }
.cv-review-stale { font-size: 12px; color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); border: 1px solid var(--dsw-alias-state-warn-secondary); border-radius: 4px; padding: 6px 8px; }
.cv-dev-noop { font-size: 12px; color: var(--dsw-alias-label-caption); padding: 4px 0; }
.cv-agent-toggle { display: inline-flex; gap: 2px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; overflow: hidden; align-self: center; }
.cv-agent-toggle button { border: none; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); padding: 4px 10px; font-size: 12px; cursor: pointer; }
.cv-agent-toggle button.on { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground); }
.cv-agent-toggle button:disabled { opacity: 0.45; cursor: not-allowed; }
.cv-dev-btn.cv-dev-sync { background: var(--dsw-alias-state-business-primary); }
.cv-dev-btn.cv-dev-merge { background: var(--dsw-alias-state-success-primary); }
.cv-dev-link { border: none; background: transparent; color: var(--dsw-alias-state-business-primary); font-size: 11.5px; cursor: pointer; padding: 4px 2px; text-decoration: underline; }
.cv-dev-link:hover { opacity: 0.8; }
.cv-context { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; flex: 1; min-width: 0; }
.cv-context-toggle { border: none; background: transparent; color: var(--dsw-alias-state-business-primary); font-size: 11.5px; cursor: pointer; padding: 2px 0; text-decoration: underline; }
.cv-context-toggle:hover { opacity: 0.8; }
.cv-context-toggle:disabled { opacity: 0.45; cursor: not-allowed; }
.cv-context-input { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); padding: 6px 8px; font-size: 12px; font-family: inherit; line-height: 1.5; resize: vertical; }
.cv-context-input::placeholder { color: var(--dsw-alias-label-caption); }
.cv-tl-user-context { color: var(--dsw-alias-label-secondary); word-break: break-all; }
`

/** Inject the plugin stylesheet once; returns the disposer. */
export function installStyles(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = PANEL_ID
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}
