import { snapshotSchema } from './protocol'
import type { Snapshot } from './protocol'

export interface Checkpoints {
  load(): Promise<Snapshot | null>
  save(snapshot: Snapshot | null): Promise<void>
}

export class BrowserCheckpoints implements Checkpoints {
  private database?: Promise<IDBDatabase>

  private open() {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('maze-learning-lab', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('checkpoints')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Checkpoint database is blocked'))
    })
    return this.database
  }

  async load() {
    const database = await this.open()
    return new Promise<Snapshot | null>((resolve, reject) => {
      const request = database.transaction('checkpoints').objectStore('checkpoints').get('active')
      request.onsuccess = () => {
        const parsed = snapshotSchema.safeParse(request.result)
        resolve(parsed.success ? parsed.data : null)
      }
      request.onerror = () => reject(request.error)
    })
  }

  async save(snapshot: Snapshot | null) {
    const database = await this.open()
    return new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('checkpoints', 'readwrite')
      const store = transaction.objectStore('checkpoints')
      if (snapshot) store.put(snapshot, 'active')
      else store.delete('active')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
    })
  }
}
