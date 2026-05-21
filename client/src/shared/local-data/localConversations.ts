import type { Conversation, ConversationExport } from './types'

const STORE_NAME = 'conversations'

export class LocalConversationStore {
  private dbPromise?: Promise<IDBDatabase>

  constructor(private readonly dbName = 'jiandanly-local') {}

  async list(): Promise<Conversation[]> {
    const store = await this.objectStore('readonly')
    const conversations = await requestToPromise<Conversation[]>(store.getAll())
    return conversations.sort(compareConversations)
  }

  async get(id: string): Promise<Conversation | undefined> {
    const store = await this.objectStore('readonly')
    return requestToPromise<Conversation | undefined>(store.get(id))
  }

  async save(conversation: Conversation): Promise<void> {
    const store = await this.objectStore('readwrite')
    await requestToPromise(store.put(conversation))
  }

  async delete(id: string): Promise<void> {
    const store = await this.objectStore('readwrite')
    await requestToPromise(store.delete(id))
  }

  async exportAll(): Promise<ConversationExport> {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      conversations: await this.list(),
    }
  }

  async importAll(payload: ConversationExport | string): Promise<void> {
    const parsed = typeof payload === 'string' ? (JSON.parse(payload) as ConversationExport) : payload
    if (parsed.version !== 1 || !Array.isArray(parsed.conversations)) {
      throw new Error('Unsupported SheJane conversation export')
    }
    const store = await this.objectStore('readwrite')
    await Promise.all(parsed.conversations.map((conversation) => requestToPromise(store.put(conversation))))
  }

  private async objectStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open()
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
          store.createIndex('updatedAt', 'updatedAt')
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    return this.dbPromise
  }
}

function compareConversations(a: Conversation, b: Conversation): number {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) {
    return a.pinned ? -1 : 1
  }
  return b.updatedAt.localeCompare(a.updatedAt)
}

function requestToPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function createLocalID(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`
}
