/**
 * DSH 会话桥(issue #53):issue 详情 → 仓库本地路径对应 workspace 的
 * 空白对话 + 预填 issue 链接草稿。
 *
 * 机制(均为 DSH 客户端公开服务,运行时由宿主注入,缺一不可):
 * - workspaces.create({path})   按 realpath 幂等注册/复用 workspace
 * - workspaces.connectWorkspace 建/复用该 workspace 的空白会话,返回会话 id
 * - conversation.input.for(scope).setDraft  写草稿(在 open 之前,见
 *   connectWorkspace 契约:返回的会话已进列表,允许先写草稿再导航)
 * - sessions.open               导航到该会话
 *
 * 服务形态用本地结构类型描述(ui-conversation 不在编译期依赖里),全部
 * 经依赖注入传入,便于纯逻辑测试。
 */

/** 对话输入的 session 域写草稿面(宿主 SessionInput 的最小结构)。 */
export interface DshSessionInput {
  setDraft(text: string): void
}

/** conversation 服务(ctx.get('conversation'))的最小结构。 */
export interface DshConversation {
  input: { for(actx: unknown): DshSessionInput }
}

/** sessions 服务(ctx.get('sessions'))的最小结构。 */
export interface DshSessions {
  open(id: string): void
  scope(id: string): unknown | undefined
}

/** workspaces 服务(ctx.get('workspaces'))的最小结构。 */
export interface DshWorkspaces {
  create(input: { path: string }): Promise<{ workspaceId: string }>
  connectWorkspace(workspaceId: string): Promise<string>
}

/** 完整桥接依赖;缺任何一个服务都无法完成全流程。 */
export interface DshConversationDeps {
  workspaces: DshWorkspaces
  sessions: DshSessions
  conversation: DshConversation | null
}

/** 从 DSH 客户端上下文解析桥接依赖;返回缺失的服务名供报错。 */
export function resolveDshConversationDeps(ctx: {
  get(name: string): unknown
}): DshConversationDeps | { missing: string[] } {
  const workspaces = ctx.get('workspaces')
  const sessions = ctx.get('sessions')
  const conversation = ctx.get('conversation')
  const missing: string[] = []
  if (workspaces === undefined || workspaces === null) missing.push('workspaces')
  if (sessions === undefined || sessions === null) missing.push('sessions')
  if (missing.length > 0) return { missing }
  return {
    workspaces: workspaces as DshWorkspaces,
    sessions: sessions as DshSessions,
    conversation: (conversation ?? null) as DshConversation | null,
  }
}

export type DshOpenResult =
  | { ok: true; warning?: string }
  | { ok: false; error: string }

/**
 * 在 path 对应 workspace 的空白对话中预填 draftText(不发送)。
 *
 * 草稿失败不拦导航:会话能开就开,再如实报告草稿未预填的原因,
 * 不静默失败。
 */
export async function openDshConversationDraft(
  deps: DshConversationDeps,
  path: string,
  draftText: string,
): Promise<DshOpenResult> {
  let workspaceId: string
  try {
    // 幂等:宿主按 realpath 解析,已注册则复用,未注册则自动注册。
    workspaceId = (await deps.workspaces.create({ path })).workspaceId
  } catch (reason) {
    return { ok: false, error: `DSH workspace 注册失败(${path}): ${errorMessage(reason)}` }
  }

  let sessionId: string
  try {
    sessionId = await deps.workspaces.connectWorkspace(workspaceId)
  } catch (reason) {
    return { ok: false, error: `DSH 空白会话创建失败: ${errorMessage(reason)}` }
  }

  // 先写草稿再导航(connectWorkspace 契约保证会话已可寻址)。
  let draftError: string | null = null
  try {
    if (!deps.conversation) throw new Error('conversation 输入服务未注入')
    const actx = deps.sessions.scope(sessionId)
    if (actx === undefined) throw new Error(`会话 ${sessionId} 无法建立输入作用域`)
    deps.conversation.input.for(actx).setDraft(draftText)
  } catch (reason) {
    draftError = `草稿未预填: ${errorMessage(reason)}`
  }

  try {
    deps.sessions.open(sessionId)
  } catch (reason) {
    return { ok: false, error: `DSH 会话打开失败: ${errorMessage(reason)}${draftError ? `;${draftError}` : ''}` }
  }
  return draftError ? { ok: true, warning: `对话已打开,但${draftError}` } : { ok: true }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
