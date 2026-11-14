/**
 * 聊天模式的 host 服务：注册「闲聊」agent 预设（persona + 无工具行），
 * 并提供 Typert 远端读数。骨架阶段不含会话消息路由——聊天走原生 agent
 * 循环（preset 激活后 mneme 的宿主级钩子照常触发，记忆白捡）。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workspace'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { CHAT_TURN_PATH, REMOTE_NAMESPACE } from '../shared/protocol.js'
import { createChatTurnRoute } from './llm.js'

/** 聊天模式配置：preset 组装 + 临时聊天通道的凭据与模型。 */
export interface ChatModeConfig {
  /** 预设名（用户在 DSH 预设列表里看到的）。 */
  presetName: string
  /** 人格提示；空 = 不插 persona 行（行 config 形状待对 @deepseek-ai/dsh-persona 验证后启用）。 */
  personaPrompt: string
  /** DeepSeek API key（host 持有，不下发浏览器；临时聊天通道用）。 */
  apiKey: string
  /** 聊天模型（快档）。 */
  model: string
  /** Anthropic 兼容端点 origin。 */
  apiOrigin: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 聊天模式的预设注册与远端读数。 */
    chatMode: ChatModeService
  }
}

/** 聊天模式服务：注册预设 + 远端读数。 */
// cordis 插件加载器约定 default export（官方 deepseek-chat-import 同款）
// eslint-disable-next-line import/no-default-export
export default class ChatModeService extends TypertRemoteService {
  static inject = ['typert', 'connection', 'workspaceRegistry', 'agentPresets']

  static Config: Schema<ChatModeConfig> = Schema.object({
    presetName: Schema.string().default('Melete 聊天')
      .description('聊天模式预设在 DSH 预设列表里的名字。'),
    personaPrompt: Schema.string().default('')
      .description('聊天模式的人格提示；空 = 预设不含 persona 行（形状验证后启用）。'),
    apiKey: Schema.string().default('')
      .description('DeepSeek API key（临时聊天通道用，仅存本机 host config）。'),
    model: Schema.string().default('deepseek-flash')
      .description('聊天模型（快档）。'),
    apiOrigin: Schema.string().default('https://api.deepseek.com')
      .description('Anthropic 兼容端点 origin。'),
  })

  constructor(ctx: Context, private readonly config: ChatModeConfig) {
    super(ctx, REMOTE_NAMESPACE, { namespace: REMOTE_NAMESPACE })
    ctx.effect(
      () => ctx.agentPresets.register(this.buildPreset()),
      'dsh-chat-mode: register chat preset',
    )
    // 临时聊天通道：phase 2 换 preset 激活的原生循环后退役。
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: CHAT_TURN_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createChatTurnRoute({
          apiKey: this.config.apiKey,
          model: this.config.model,
          apiOrigin: this.config.apiOrigin,
          systemPrompt: this.systemPrompt(),
          maxTurnChars: 256 * 1024,
        }),
      }),
      'dsh-chat-mode: chat turn route',
    )
    // TODO(phase-2): 注册代管 workspace（聊天归档桶）——官方导入对话框读
    // workspaceRegistry，注册后导入目标自动出现。
  }

  /** 聊天系统提示：persona 优先，否则缺省对话人格。 */
  private systemPrompt(): string {
    return this.config.personaPrompt.trim() || '你是 Melete 聊天模式的对话伙伴，回答自然、简洁、直接。'
  }

  /**
   * 组装聊天预设：只含本插件 context 行（无工具行 = 「不代入 DS 工具」；
   * 模型走宿主缺省 = 「不思考那么久」）。persona 行待验证后启用。
   */
  private buildPreset(): PresetDefinition {
    const personaRow = this.config.personaPrompt.trim()
      ? [{ name: '@deepseek-ai/dsh-persona', config: { prompt: this.config.personaPrompt } }]
      : []
    return {
      id: 'dsh-chat-mode',
      name: this.config.presetName,
      description:
        'Melete chat mode: tool-free fast chat. DeepSeek app archives imported into the chat workspace live here.',
      order: 60,
      plugins: [
        ...personaRow,
        { id: 'chat-context', name: 'dsh-chat-mode/chat-context', config: {} },
      ],
    }
  }

  /** 远端读数：骨架阶段只回报预设与 workspace 接线状态。 */
  @Remote
  status(): ChatModeStatus {
    return { preset: this.config.presetName, workspace: null }
  }
}

export interface ChatModeStatus {
  preset: string
  workspace: string | null
}
