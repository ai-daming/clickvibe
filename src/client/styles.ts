import { PANEL_ID } from './panel-state.ts'

// ---- plugin-owned styles (injected once at activation) ----

export const PANEL_CSS = `
#root.cv-panel-host-open { margin-right: calc(var(--dsh-sidebar-width, 0px) + var(--cv-sidebar-width, 0px)); width: calc(100% - var(--dsh-sidebar-width, 0px) - var(--cv-sidebar-width, 0px)); transition: margin-right var(--ds-transition-duration-slow) var(--ds-ease-in-out), width var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.cv-panel-slot { position: fixed; z-index: 50; top: 0; right: var(--dsh-sidebar-width, 0px); bottom: 0; width: var(--cv-sidebar-width); min-width: 0; overflow: visible; pointer-events: auto; transition: right var(--ds-transition-duration-slow) var(--ds-ease-in-out), width var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.cv-panel-slot[data-cv-mobile] { right: 0; width: 100vw; }
.cv-panel { width: 100%; height: 100%; display: flex; flex-direction: column; background: #ffffff; border-left: 1px solid #d0d7de; box-sizing: border-box; font-size: 13px; color: #1f2328; }
.cv-panel-resizer { position: absolute; z-index: 2; top: 0; bottom: 0; left: -5px; width: 10px; cursor: col-resize; touch-action: none; }
.cv-panel-resizer::after { content: ''; position: absolute; top: 50%; left: 50%; width: 4px; height: 36px; border-radius: 3px; background: #8c959f; opacity: 0; transform: translate(-50%, -50%); transition: opacity 120ms ease; }
.cv-panel-resizer:hover::after, .cv-panel-resizer:focus-visible::after, .cv-panel-resizer[data-dragging]::after { opacity: .75; }
body[data-cv-panel-dragging] #root.cv-panel-host-open, body[data-cv-panel-dragging] .cv-panel-slot { transition: none; }
@media (prefers-reduced-motion: reduce) { #root.cv-panel-host-open, .cv-panel-slot { transition: none; } }
.cv-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; font-weight: 600; color: #1f2328; border-bottom: 1px solid #d0d7de; flex-shrink: 0; }
.cv-panel-header-actions { display: flex; align-items: center; gap: 6px; }
.cv-close { border: none; background: transparent; cursor: pointer; font-size: 14px; color: #57606a; }
.cv-close:hover { color: #1f2328; }
.cv-input-row { display: flex; gap: 6px; padding: 4px 14px; flex-shrink: 0; }
.cv-input-row:last-of-type { padding-bottom: 10px; }
.cv-project-toolbar { padding: 10px 12px; border-bottom: 1px solid #d0d7de; display: grid; gap: 8px; }
.cv-project-selects { display: flex; gap: 6px; }
.cv-project-import { display: flex; align-items: center; gap: 8px; color: #57606a; font-size: 11px; }
.cv-project-import span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-batch-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cv-batch-btn { border: none; border-radius: 6px; padding: 6px 9px; background: #0969da; color: #fff; font-size: 11px; font-weight: 600; cursor: pointer; }
.cv-batch-btn:disabled { opacity: .5; cursor: not-allowed; }
.cv-batch-btn.cv-batch-secondary { background: #57606a; }
.cv-batch-agent { display: inline-flex; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; }
.cv-batch-agent button { border: none; padding: 5px 8px; background: #fff; color: #57606a; cursor: pointer; font-size: 11px; }
.cv-batch-agent button.on { background: #1f2328; color: #fff; }
.cv-batch-status { color: #57606a; font-size: 11px; }
.cv-row-select { margin: 0; accent-color: #0969da; }
.cv-select { min-width: 0; flex: 1; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; padding: 6px 8px; color: #1f2328; }
.cv-project-meta { color: #57606a; font-size: 11px; }
.cv-project-list { flex: 1; overflow-y: auto; padding: 8px 10px 16px; }
.cv-group-title { margin: 10px 2px 5px; color: #57606a; font-size: 11px; font-weight: 700; }
.cv-issue-row { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 9px 8px; border: 1px solid #d8dee4; border-radius: 7px; margin-bottom: 6px; background: #fff; }
.cv-issue-row-main { min-width: 0; }
.cv-issue-row-title { display: block; color: #0969da; font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.cv-issue-row-meta { color: #57606a; font-size: 10.5px; margin-top: 3px; display: flex; gap: 7px; flex-wrap: wrap; }
.cv-row-lag { color: #9a6700; font-weight: 600; }
.cv-row-contract { color: #cf222e; font-weight: 600; }
.cv-row-ready { color: #1a7f37; font-weight: 600; }
.cv-row-action { border: none; border-radius: 6px; padding: 5px 8px; background: #1f883d; color: white; font-size: 11px; white-space: nowrap; cursor: pointer; }
.cv-row-action.cv-row-none { background: #afb8c1; cursor: default; }
.cv-row-action.cv-row-running { background: #0969da; cursor: default; }
.cv-back { border: none; background: transparent; color: #0969da; cursor: pointer; padding: 0; font-size: 12px; }
.cv-input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; background: #ffffff; color: #1f2328; font-size: 12px; }
.cv-input::placeholder { color: #8c959f; }
.cv-fetch { padding: 6px 12px; border: none; border-radius: 6px; background: #0969da; color: #ffffff; cursor: pointer; font-size: 12px; }
.cv-fetch:disabled { opacity: 0.6; }
.cv-error { margin: 0 14px 10px; padding: 8px 10px; border-radius: 6px; background: #ffebe9; color: #cf222e; border: 1px solid #ff8182; flex-shrink: 0; }
.cv-stale { margin: 8px 12px 0; padding: 6px 8px; border-radius: 6px; background: #fff8c5; color: #9a6700; border: 1px solid #d4a72c; font-size: 11.5px; flex-shrink: 0; }
.cv-repo-advance { margin: 8px 12px 0; padding: 7px 8px; border-radius: 6px; background: #fff8c5; color: #7d4e00; border: 1px solid #d4a72c; font-size: 11.5px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cv-hint { padding: 20px 14px; color: #8c959f; text-align: center; }
.cv-loading { padding: 20px 14px; color: #57606a; text-align: center; }
.cv-issue { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; flex: 1; overflow-y: auto; }
.cv-issue-head { display: flex; gap: 6px; align-items: center; }
.cv-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
.cv-badge-open { background: #dafbe1; color: #1a7f37; }
.cv-badge-closed { background: #ffebe9; color: #cf222e; }
.cv-badge-merged { background: #d8f5ff; color: #8250df; }
.cv-badge-kind { background: #f6f8fa; color: #57606a; }
.cv-issue-title { font-size: 15px; font-weight: 700; color: #0969da; text-decoration: none; }
.cv-issue-title:hover { text-decoration: underline; }
.cv-dsh-open-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cv-dsh-open-btn { border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 4px 10px; font-size: 12px; color: #1f2328; cursor: pointer; }
.cv-dsh-open-btn:hover:not(:disabled) { background: #eff1f3; }
.cv-dsh-open-btn:disabled { opacity: .55; cursor: not-allowed; }
.cv-dsh-open-status { font-size: 11px; color: #9a6700; word-break: break-all; }
.cv-issue-labels { display: flex; flex-wrap: wrap; gap: 4px; font-size: 11px; }
.cv-issue-labels span { padding: 1px 6px; border-radius: 10px; background: #ddf4ff; color: #0969da; }
.cv-issue-assignees { font-size: 12px; color: #57606a; }
.cv-meta { width: 100%; border-collapse: collapse; font-size: 12px; }
.cv-meta tr { border-bottom: 1px solid #f0f2f4; }
.cv-meta tr:last-child { border-bottom: none; }
.cv-meta-k { width: 52px; padding: 3px 0; color: #8c959f; vertical-align: top; }
.cv-meta-v { padding: 3px 0; color: #1f2328; word-break: break-all; }
.cv-issue-body { border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; font-size: 12.5px; }
.cv-comments { display: flex; flex-direction: column; gap: 6px; }
.cv-comments-empty { font-size: 12px; color: #8c959f; padding: 4px 0; }
.cv-comments-toggle { border: none; background: transparent; cursor: pointer; font-size: 12.5px; font-weight: 600; color: #0969da; padding: 2px 0; text-align: left; }
.cv-comment { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px; }
.cv-comment-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 11.5px; }
.cv-comment-author { font-weight: 600; color: #0969da; }
.cv-comment-date { color: #8c959f; }
.cv-toggle { border: 1px solid #d0d7de; background: #ffffff; border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer; color: #1f2328; }
.cv-toggle:hover { background: #f6f8fa; }
.cv-issue-organizer { border: 0; border-radius: 6px; padding: 4px 8px; background: transparent; color: var(--ds-color-text-secondary, #57606a); font: inherit; white-space: nowrap; cursor: pointer; }
.cv-issue-organizer:hover { background: var(--ds-color-bg-secondary, #f6f8fa); color: var(--ds-color-text, #1f2328); }
.cv-md { font-size: 13px; line-height: 1.6; color: #1f2328; word-break: break-word; }
.cv-md-p { margin: 0 0 8px; }
.cv-md-h { margin: 10px 0 6px; font-weight: 600; }
.cv-md-h1 { font-size: 18px; }
.cv-md-h2 { font-size: 16px; }
.cv-md-h3 { font-size: 14.5px; }
.cv-md-h4, .cv-md-h5, .cv-md-h6 { font-size: 13.5px; }
.cv-md-pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; overflow-x: auto; margin: 0 0 8px; }
.cv-md-pre code { background: transparent; padding: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre; }
.cv-md-code { background: #eff1f3; padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.cv-md-link { color: #0969da; }
.cv-md-ul { padding-left: 20px; list-style: disc; margin: 0 0 8px; }
.cv-md-ol { padding-left: 20px; list-style: decimal; margin: 0 0 8px; }
.cv-md-blockquote { border-left: 4px solid #d0d7de; padding-left: 10px; margin: 0 0 8px; color: #57606a; }
.cv-md-hr { border: none; border-top: 1px solid #d0d7de; margin: 10px 0; }
.cv-dev { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.cv-dev-head { font-weight: 600; font-size: 12.5px; color: #1f2328; }
.cv-dev-actions { display: flex; gap: 6px; }
.cv-dev-btn { padding: 5px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; color: #ffffff; }
.cv-dev-codex { background: #1f2328; }
.cv-dev-claude { background: #d97706; }
.cv-dev-btn:hover { opacity: 0.85; }
.cv-dev-status { font-size: 12px; color: #57606a; }
.cv-dev-path { font-size: 11px; color: #8c959f; word-break: break-all; margin-top: 2px; }
.cv-dev-error { font-size: 12px; color: #cf222e; background: #ffebe9; border: 1px solid #ff8182; border-radius: 4px; padding: 6px 8px; }
.cv-terminal { position: relative; display: flex; flex-direction: column; min-height: 0; overflow: hidden; border: 1px solid #30363d; border-radius: 8px; background: #0d1117; color: #e6edf3; box-shadow: inset 0 1px 0 rgb(255 255 255 / 4%); }
.cv-terminal-head { min-height: 32px; padding: 0 8px 0 10px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #21262d; background: #161b22; font: 600 10.5px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; color: #8b949e; }
.cv-terminal-agent { color: #58a6ff; text-transform: uppercase; letter-spacing: .04em; }
.cv-terminal-agent[data-agent="claude"] { color: #f2a65a; }
.cv-terminal-spacer { flex: 1; }
.cv-terminal-detach { border: 0; border-radius: 4px; padding: 3px 6px; background: #21262d; color: #c9d1d9; cursor: pointer; font: inherit; }
.cv-terminal-detach:hover { background: #30363d; }
.cv-dev-log { min-height: 72px; max-height: 200px; overflow: auto; overscroll-behavior: contain; padding: 8px 10px; font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; scrollbar-color: #30363d #0d1117; }
.cv-terminal-line { min-height: 1.55em; }
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
.cv-log-history { border-radius: 6px; background: #f6f8fa; }
.cv-log-history summary { padding: 5px 8px; cursor: pointer; color: #57606a; font-size: 11.5px; font-weight: 600; }
@media (max-width: 767px) { .cv-terminal-overlay { inset: 0; border-radius: 0; } .cv-terminal-overlay .cv-dev-log { font-size: 12px; } }
.cv-dev-done { font-size: 12px; color: #1a7f37; font-weight: 600; }
.cv-stage { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; margin-left: 6px; }
.cv-stage-idle { background: #f6f8fa; color: #57606a; }
.cv-stage-developing { background: #ddf4ff; color: #0969da; }
.cv-stage-review-ready { background: #fff8c5; color: #9a6700; }
.cv-stage-reviewing { background: #fbefff; color: #8250df; }
.cv-stage-passed { background: #dafbe1; color: #1a7f37; }
.cv-running-duration { color: #57606a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: nowrap; }
.cv-dev-btn.cv-dev-warn { background: #d4a72c; color: #ffffff; }
.cv-dev-btn.cv-dev-review { background: #8250df; color: #ffffff; }
.cv-review-fail { display: flex; flex-direction: column; gap: 6px; }
.cv-review-issues { margin: 0; padding-left: 18px; font-size: 12px; color: #1f2328; }
.cv-review-issues li { margin: 2px 0; }
.cv-refresh { padding: 6px 10px; border: 1px solid #d0d7de; border-radius: 6px; background: #ffffff; color: #57606a; cursor: pointer; font-size: 14px; line-height: 1; }
.cv-refresh:hover { background: #f6f8fa; color: #1f2328; }
.cv-links { display: flex; flex-direction: column; gap: 4px; }
.cv-dep-block { display: flex; flex-direction: column; gap: 4px; }
.cv-dep-label { font-size: 12px; font-weight: 600; color: #57606a; }
.cv-link-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #57606a; flex-wrap: wrap; }
.cv-link { color: #0969da; font-weight: 600; text-decoration: none; }
.cv-link:hover { text-decoration: underline; }
.cv-link-state { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10.5px; font-weight: 600; }
.cv-link-state-open { background: #dafbe1; color: #1a7f37; }
.cv-link-state-closed { background: #ffebe9; color: #cf222e; }
.cv-link-state-merged { background: #d8f5ff; color: #8250df; }
.cv-link-state-open { background: #dafbe1; color: #1a7f37; }
.cv-link-kind { font-size: 10.5px; font-weight: 700; color: #57606a; }
.cv-pr-icon { flex-shrink: 0; display: inline-block; }
.cv-pr-open { color: #1a7f37; }
.cv-pr-merged { color: #8250df; }
.cv-pr-closed { color: #cf222e; }
.cv-issue-open { color: #1a7f37; }
.cv-issue-closed { color: #8250df; }
.cv-link-state-issue-closed { background: #fbefff; color: #8250df; }
.cv-stage-new { background: #fff8c5; color: #9a6700; }
.cv-timeline { border-top: 1px solid #d0d7de; padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.cv-timeline-head { font-size: 12px; font-weight: 600; color: #57606a; }
.cv-tl-row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.cv-tl-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 3px 4px; border: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.cv-tl-open:hover { background: #f6f8fa; }
.cv-tl-summary { color: #1f2328; font-weight: 600; }
.cv-tl-kind { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10.5px; font-weight: 600; }
.cv-tl-kind-dev { background: #ddf4ff; color: #0969da; }
.cv-tl-kind-rework { background: #fff8c5; color: #9a6700; }
.cv-tl-kind-review { background: #fbefff; color: #8250df; }
.cv-tl-kind-resume { background: #f6f8fa; color: #57606a; }
.cv-tl-kind-note { background: #f6f8fa; color: #57606a; }
.cv-tl-kind-merge-override { background: #ffebe9; color: #cf222e; }
.cv-override-entry { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; margin: 4px 0; }
.cv-override-gates { margin: 0; padding-left: 18px; font-size: 11.5px; color: #9a6700; }
.cv-tl-time { color: #8c959f; }
.cv-tl-duration { color: #57606a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; }
.cv-tl-hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; background: #eff1f3; padding: 0 4px; border-radius: 4px; }
.cv-tl-verdict { font-weight: 600; }
.cv-tl-pass { color: #1a7f37; }
.cv-tl-fail { color: #cf222e; }
.cv-tl-note { color: #57606a; }
.cv-tl-public { color: #0969da; font-weight: 600; text-decoration: none; }
.cv-tl-public:hover { text-decoration: underline; }
.cv-tl-local { color: #8c959f; }
.cv-tl-publish-fail { color: #cf222e; font-weight: 600; }
.cv-audit-backdrop { position: fixed; z-index: 10020; inset: 0; background: rgb(31 35 40 / 28%); }
.cv-audit-drawer { position: absolute; top: 0; right: 0; bottom: 0; width: min(480px, 92vw); overflow: auto; padding: 18px; background: #fff; box-shadow: -12px 0 36px rgb(31 35 40 / 24%); color: #1f2328; }
.cv-audit-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid #d0d7de; }
.cv-audit-close { border: 0; background: transparent; color: #57606a; font-size: 26px; line-height: 1; cursor: pointer; }
.cv-audit-summary { margin-top: 12px; padding: 8px 10px; border-radius: 6px; background: #f6f8fa; font-size: 12px; font-weight: 600; }
.cv-audit-section { margin-top: 16px; font-size: 12px; overflow-wrap: anywhere; }
.cv-audit-section h4 { margin: 0 0 7px; font-size: 12px; color: #57606a; }
.cv-audit-muted { color: #8c959f; font-size: 11px; }
.cv-audit-list { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 7px; }
.cv-audit-commits code { margin-right: 5px; }
.cv-audit-diffstat { list-style: none; padding-left: 0; }
.cv-audit-diffstat li { display: flex; justify-content: space-between; gap: 12px; }
.cv-audit-diffstat span { overflow-wrap: anywhere; }
.cv-audit-log { margin-top: 16px; border: 1px solid #0969da; border-radius: 6px; padding: 7px 10px; background: #fff; color: #0969da; font-size: 11px; cursor: pointer; }
.cv-delivery-summary { font-size: 12px; color: #57606a; background: #f6f8fa; border-radius: 4px; padding: 6px 8px; }
.cv-review-next { font-size: 12px; font-weight: 600; }
.cv-state { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.cv-state-head { font-size: 12px; font-weight: 600; color: #57606a; }
.cv-state-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.cv-state-table td { padding: 3px 0; vertical-align: top; }
.cv-state-k { width: 78px; color: #8c959f; font-weight: 600; }
.cv-state-v { color: #1f2328; word-break: break-all; }
.cv-state-delta { display: block; color: #57606a; font-size: 11px; }
.cv-state-warn { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 8px; background: #fff8c5; color: #9a6700; font-weight: 600; font-size: 10.5px; }
.cv-review-stale { font-size: 12px; color: #9a6700; background: #fff8c5; border: 1px solid #d4a72c; border-radius: 4px; padding: 6px 8px; }
.cv-dev-noop { font-size: 12px; color: #8c959f; padding: 4px 0; }
.cv-agent-toggle { display: inline-flex; gap: 2px; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; align-self: center; }
.cv-agent-toggle button { border: none; background: #ffffff; color: #57606a; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.cv-agent-toggle button.on { background: #0969da; color: #ffffff; }
.cv-agent-toggle button:disabled { opacity: 0.45; cursor: not-allowed; }
.cv-dev-btn.cv-dev-sync { background: #0969da; }
.cv-dev-btn.cv-dev-merge { background: #1a7f37; }
.cv-dev-link { border: none; background: transparent; color: #0969da; font-size: 11.5px; cursor: pointer; padding: 4px 2px; text-decoration: underline; }
.cv-dev-link:hover { opacity: 0.8; }
.cv-context { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; flex: 1; min-width: 0; }
.cv-context-toggle { border: none; background: transparent; color: #0969da; font-size: 11.5px; cursor: pointer; padding: 2px 0; text-decoration: underline; }
.cv-context-toggle:hover { opacity: 0.8; }
.cv-context-toggle:disabled { opacity: 0.45; cursor: not-allowed; }
.cv-context-input { width: 100%; box-sizing: border-box; border: 1px solid #d0d7de; border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: inherit; line-height: 1.5; resize: vertical; }
.cv-tl-user-context { color: #57606a; word-break: break-all; }
.cv-auth-overlay { position: fixed; z-index: 90; inset: 0; display: grid; place-items: center; padding: 18px; background: rgba(31, 35, 40, .42); }
.cv-auth-dialog { width: min(460px, 100%); max-height: calc(100vh - 36px); overflow: auto; box-sizing: border-box; padding: 16px; border: 1px solid #d0d7de; border-radius: 10px; background: #fff; box-shadow: 0 12px 36px rgba(31, 35, 40, .24); }
.cv-auth-title { margin-bottom: 10px; color: #1f2328; font-size: 15px; font-weight: 700; }
.cv-auth-snapshot { display: grid; gap: 3px; color: #57606a; font-size: 12px; }
.cv-auth-snapshot strong { color: #1f2328; font-size: 13px; }
.cv-auth-advanced { margin-top: 12px; padding: 9px 10px; border: 1px solid #d8dee4; border-radius: 7px; background: #f6f8fa; }
.cv-auth-advanced summary { cursor: pointer; color: #24292f; font-weight: 600; }
.cv-auth-baseline { display: grid; gap: 5px; margin-top: 9px; color: #57606a; font-size: 12px; }
.cv-auth-baseline select { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #afb8c1; border-radius: 6px; background: #fff; color: #1f2328; }
.cv-auth-frozen, .cv-auth-note, .cv-auth-warning { margin-top: 7px; font-size: 11.5px; line-height: 1.45; }
.cv-auth-frozen { color: #57606a; }
.cv-auth-note { color: #0969da; }
.cv-auth-warning { color: #9a6700; }
.cv-auth-actions { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 14px; }
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
