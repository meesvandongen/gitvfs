import { createContext, useContext, type ReactNode } from 'react'
import type { GitCms } from '../cms.js'

const CmsContext = createContext<GitCms | null>(null)

export function CmsProvider({ cms, children }: { cms: GitCms; children?: ReactNode }) {
  return <CmsContext.Provider value={cms}>{children}</CmsContext.Provider>
}

export function useCms(): GitCms {
  const cms = useContext(CmsContext)
  if (!cms) throw new Error('useCms must be used inside <CmsProvider>')
  return cms
}
