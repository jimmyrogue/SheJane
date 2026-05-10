import type { ChatAPI } from '../../shared/api/client'
import { createLocalID, LocalConversationStore } from '../../shared/local-data/localConversations'
import type { ChatMode, ChatMessage, Conversation } from '../../shared/local-data/types'

interface ChatStoreDeps {
  localData: LocalConversationStore
  api: ChatAPI
  now?: () => string
}

interface SendMessageInput {
  conversationId?: string
  content: string
  mode: ChatMode
  scene: string
}

export function createChatStore(deps: ChatStoreDeps) {
  const now = deps.now ?? (() => new Date().toISOString())

  return {
    async sendMessage(input: SendMessageInput): Promise<Conversation> {
      const text = input.content.trim()
      if (!text) {
        throw new Error('消息不能为空')
      }

      const timestamp = now()
      const conversation =
        (input.conversationId ? await deps.localData.get(input.conversationId) : undefined) ??
        createConversation(text, timestamp)

      const userMessage: ChatMessage = {
        id: createLocalID('msg'),
        role: 'user',
        content: text,
        createdAt: timestamp,
        status: 'done',
      }
      const assistantMessage: ChatMessage = {
        id: createLocalID('msg'),
        role: 'assistant',
        content: '',
        createdAt: timestamp,
        status: 'streaming',
      }

      const requestMessages = [...conversation.messages, userMessage]
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role, content: message.content }))

      conversation.messages = [...conversation.messages, userMessage, assistantMessage]
      conversation.updatedAt = timestamp
      await deps.localData.save(conversation)

      try {
        const result = await deps.api.streamChat(
          {
            mode: input.mode,
            scene: input.scene,
            clientConversationId: conversation.id,
            clientMessageId: userMessage.id,
            messages: requestMessages,
          },
          {
            onDelta: (delta) => {
              assistantMessage.content += delta
            },
          },
        )
        assistantMessage.status = 'done'
        assistantMessage.requestId = result.requestId
        assistantMessage.creditsCost = result.creditsCost
      } catch (error) {
        assistantMessage.status = 'error'
        assistantMessage.content = error instanceof Error ? error.message : '发送失败'
        throw error
      } finally {
        conversation.updatedAt = now()
        await deps.localData.save(conversation)
      }

      return conversation
    },
  }
}

function createConversation(firstMessage: string, timestamp: string): Conversation {
  return {
    id: createLocalID('conv'),
    title: firstMessage.slice(0, 24) || '新对话',
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
  }
}
