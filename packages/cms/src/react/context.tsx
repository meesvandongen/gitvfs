import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { ChangeComparison, CmsState, GitCms } from '../cms.js'
import type { AsyncState } from './use-async.js'

const CmsContext = createContext<GitCms | null>(null)

export function CmsProvider({ cms, children }: { cms: GitCms; children?: ReactNode }) {
  return <CmsContext.Provider value={cms}>{children}</CmsContext.Provider>
}

export function useCms(): GitCms {
  const cms = useContext(CmsContext)
  if (!cms) throw new Error('useCms must be used inside <CmsProvider>')
  return cms
}

/** The CMS's branches, re-rendering after every commit and branch switch. */
export function useCmsState(): CmsState {
  const cms = useCms()
  return useSyncExternalStore(cms.subscribe, cms.getState, cms.getState)
}

/**
 * The current change compared to the base branch, shared by the views that show it. `data` is
 * `null` outside a change, and when the repository cannot compare branches.
 */
export const ChangeReviewContext = createContext<AsyncState<ChangeComparison | null> | null>(null)

export function useChangeReview(): AsyncState<ChangeComparison | null> | null {
  return useContext(ChangeReviewContext)
}
