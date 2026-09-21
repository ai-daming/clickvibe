/**
 * DSH 会话桥(issue #53):issue 详情 → 仓库本地路径对应 workspace 的
 * 空白对话 + 预填 issue 链接草稿。
 *
 * 机制(均为 DSH 客户端公开服务,运行时由宿主注入,缺一不可):
 * - workspaces.create({path})   按 realpath 幂等注册/复用 workspace
 * - uiWorkspace.connectWorkspace(workspaceId)  建/复用该 workspace 的空白会话,返回会话 id
 * - uiWorkspace.openSession(sessionId)         导航(内部 retain,会话作用域随后同步可用)
 * - conversation.input.for(sessions.scope(sessionId)).setDraft(text)  写草稿
 *
 * DSH 已把导航面从 workspaces/sessions 收窄到 uiWorkspace(见 fixture
 * 0efc7f045e "carve outward interfaces"):workspaces 只剩注册/改名/删除,
 * sessions 只剩 retain/scope/list,connectWorkspace/openSession 只在
 * uiWorkspace 上。旧写法 deps.workspaces.connectWorkspace 在现宿主上必然
 * 报 "is not a function"。
 *
 * 顺序:注册 workspace → connect 取会话 id → 绑定讨论 → 导航(retain,
 * 作用域生效)→ 写草稿。草稿必须晚于导航:未 retain 的会话没有 scope,
 * conversation.input.for 解析不到输入面。草稿失败不拦导航,再如实报告
 * 草稿未预填的原因,不静默失败。
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

/** sessions 服务(ctx.get('sessions'))的最小结构(导航已收窄到 uiWorkspace)。 */
export interface DshSessions {
  scope(id: string): unknown | undefined
}

/** workspaces 服务(ctx.get('workspaces'))的最小结构:只有注册面。 */
export interface DshWorkspaces {
  create(input: { path: string }): Promise<{ workspaceId: string }>
}

/** uiWorkspace 服务(ctx.get('uiWorkspace'))的最小结构:会话导航面。 */
export interface DshUiWorkspace {
  connectWorkspace(workspaceId: string): Promise<string>
  openSession(sessionId: string): void
}

/** 完整桥接依赖;缺任何一个服务都无法完成全流程。 */
export interface DshConversationDeps {
  workspaces: DshWorkspaces
  uiWorkspace: DshUiWorkspace
  sessions: DshSessions
  conversation: DshConversation | null
}

/** 从 DSH 客户端上下文解析桥接依赖;返回缺失的服务名供报错。 */
export function resolveDshConversationDeps(ctx: {
  get(name: string): unknown
}): DshConversationDeps | { missing: string[] } {
  const workspaces = ctx.get('workspaces')
  const uiWorkspace = ctx.get('uiWorkspace')
  const sessions = ctx.get('sessions')
  const conversation = ctx.get('conversation')
  const missing: string[] = []
  if (workspaces === undefined || workspaces === null) missing.push('workspaces')
  if (uiWorkspace === undefined || uiWorkspace === null) missing.push('uiWorkspace')
  if (sessions === undefined || sessions === null) missing.push('sessions')
  if (missing.length > 0) return { missing }
  return {
    workspaces: workspaces as DshWorkspaces,
    uiWorkspace: uiWorkspace as DshUiWorkspace,
    sessions: sessions as DshSessions,
    conversation: (conversation ?? null) as DshConversation | null,
  }
}

export type DshOpenResult = { ok: true; warning?: string } | { ok: false; error: string }

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
  bindSession?: (sessionId: string) => Promise<void>,
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
    sessionId = await deps.uiWorkspace.connectWorkspace(workspaceId)
  } catch (reason) {
    return { ok: false, error: `DSH 空白会话创建失败: ${errorMessage(reason)}` }
  }

  try {
    await bindSession?.(sessionId)
  } catch (reason) {
    return { ok: false, error: `讨论关联失败: ${errorMessage(reason)}` }
  }

  try {
    deps.uiWorkspace.openSession(sessionId)
  } catch (reason) {
    return { ok: false, error: `DSH 会话打开失败: ${errorMessage(reason)}` }
  }

  // 导航即 retain(mainView),作用域随之同步可解析:草稿必须写在导航之后。
  let draftError: string | null = null
  try {
    if (!deps.conversation) throw new Error('conversation 输入服务未注入')
    const actx = deps.sessions.scope(sessionId)
    if (actx === undefined) throw new Error(`会话 ${sessionId} 无法建立输入作用域`)
    deps.conversation.input.for(actx).setDraft(draftText)
  } catch (reason) {
    draftError = `草稿未预填: ${errorMessage(reason)}`
  }

  return draftError ? { ok: true, warning: `对话已打开,但${draftError}` } : { ok: true }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
