import { createContext, useContext, type ReactNode } from 'react'
import type { CmsView } from './CmsApp.js'

/** Show another collection, entry or singleton in the surrounding editor. */
export type CmsNavigate = (view: CmsView) => void

const NavigationContext = createContext<CmsNavigate | undefined>(undefined)

/**
 * Lets fields open other documents, such as the entry a reference points at. `CmsApp` provides it;
 * wrap your own `DocumentEditor` or `ContentForm` in it to get the same links in your UI.
 */
export function CmsNavigationProvider({ navigate, children }: { navigate: CmsNavigate | undefined; children?: ReactNode }) {
  return <NavigationContext.Provider value={navigate}>{children}</NavigationContext.Provider>
}

/** The navigation of the surrounding editor, or `undefined` when there is none (fields then hide their links). */
export function useCmsNavigate(): CmsNavigate | undefined {
  return useContext(NavigationContext)
}
