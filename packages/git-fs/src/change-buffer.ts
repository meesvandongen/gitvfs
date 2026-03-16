export interface Change {
  action: 'create' | 'update' | 'delete' | 'move'
  path: string
  content?: Uint8Array | string
  previousPath?: string
}

export class ChangeBuffer {
  private changes = new Map<string, Change>()

  add(change: Change): void {
    this.changes.set(change.path, change)
  }

  get(path: string): Change | undefined {
    return this.changes.get(path)
  }

  has(path: string): boolean {
    return this.changes.has(path)
  }

  /** Check if a path has been deleted in the buffer. */
  isDeleted(path: string): boolean {
    const change = this.changes.get(path)
    return change?.action === 'delete'
  }

  /** Get all pending changes. */
  all(): Change[] {
    return Array.from(this.changes.values())
  }

  /** Get number of pending changes. */
  get size(): number {
    return this.changes.size
  }

  /** Clear all pending changes. */
  clear(): void {
    this.changes.clear()
  }
}
