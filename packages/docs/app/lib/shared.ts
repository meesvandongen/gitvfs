import { createGetUrl } from 'fumadocs-core/source'

export const appName = 'gitvfs'
export const docsRoute = '/docs'
export const docsContentRoute = '/llms.mdx/docs'
/** The CMS demo (packages/cms-demo): every feature, against a GitHub API mocked in the browser. */
export const cmsDemoUrl = 'https://demo.cms.gitvfs.mvd.im/'
/** The repository browser demo (packages/sample). */
export const demoUrl = 'https://gitvfs-demo.mvd.im/'

export const gitConfig = {
  user: 'meesvandongen',
  repo: 'gitvfs',
  branch: 'main',
  /** Where the MDX sources live inside the repository. */
  contentDir: 'packages/docs/content/docs',
}

const getContentUrl = createGetUrl(docsContentRoute)

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md']

  return { segments, url: getContentUrl(segments, page.locale) }
}
