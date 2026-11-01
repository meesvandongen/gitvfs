import { MockRepository, type RepositoryState } from './repository.js'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface PersistentRepositoryOptions {
  /** Storage key. Change it to start over when the seed content changes. */
  key: string
  /** The repository to start from, and to reset to. */
  seed: () => Promise<MockRepository> | MockRepository
  /** Default: `localStorage`, or memory when it is unavailable. */
  storage?: StorageLike
}

export interface PersistentRepository {
  repository: MockRepository
  /** Save the current state; pass this as the handlers' `onChange`. */
  save: () => void
  /** Throw away all changes and go back to the seed. */
  reset: () => Promise<void>
}

function defaultStorage(): StorageLike | undefined {
  try {
    const probe = '__gitvfs_github_msw__'
    localStorage.setItem(probe, probe)
    localStorage.removeItem(probe)
    return localStorage
  } catch {
    return undefined
  }
}

/** A repository that survives reloads by saving itself to browser storage after every change. */
export async function persistentRepository(options: PersistentRepositoryOptions): Promise<PersistentRepository> {
  const storage = options.storage ?? defaultStorage()
  let repository: MockRepository | undefined
  try {
    const saved = storage?.getItem(options.key)
    if (saved) repository = MockRepository.fromJSON(JSON.parse(saved) as RepositoryState)
  } catch {
    // Corrupt or outdated state: start from the seed.
  }
  repository ??= await options.seed()

  const save = () => {
    try {
      storage?.setItem(options.key, JSON.stringify(repository.toJSON()))
    } catch {
      // Quota exceeded or storage blocked: keep working in memory.
    }
  }
  save()

  return {
    repository,
    save,
    reset: async () => {
      repository.replaceWith(await options.seed())
      save()
    },
  }
}
