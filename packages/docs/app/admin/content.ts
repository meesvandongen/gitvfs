import { z } from 'zod'
import { defineCollection, defineSingleton, markdown, textarea, type CommitMessageContext } from 'gitvfs-cms'
import { gitConfig } from '@/lib/shared'

const root = gitConfig.contentDir

// Fumadocs reads `title` and `description` from the frontmatter of every page.
const pageSchema = z.object({
  title: z.string().min(1),
  description: z.string().check(textarea()).optional(),
  body: z.string().check(markdown({ label: 'Content (MDX)' })).default(''),
})

const commitMessage = ({ action, path, previousPath }: CommitMessageContext) => {
  const file = path.slice(root.length + 1)
  if (action === 'rename') return `docs: rename ${previousPath?.slice(root.length + 1)} to ${file}`
  return `docs: ${action} ${file}`
}

const docsCollection = (name: string, label: string, folder: string) =>
  defineCollection({
    name,
    label,
    folder: folder ? `${root}/${folder}` : root,
    extension: 'mdx',
    schema: pageSchema,
    commitMessage,
  })

export const collections = [
  docsCollection('overview', 'Overview', ''),
  docsCollection('gitvfs', 'gitvfs', 'gitvfs'),
  docsCollection('cms', 'gitvfs-cms', 'cms'),
]

// Fumadocs' meta.json orders the sidebar; `---Label---` entries are separators.
const navigationSchema = z.object({
  title: z.string().optional(),
  root: z.boolean().optional(),
  pages: z.array(z.string()).default([]),
})

export const singletons = [
  defineSingleton({ name: 'nav', label: 'Sidebar', path: `${root}/meta.json`, schema: navigationSchema, commitMessage }),
  defineSingleton({
    name: 'nav-gitvfs',
    label: 'Sidebar: gitvfs',
    path: `${root}/gitvfs/meta.json`,
    schema: navigationSchema,
    commitMessage,
  }),
  defineSingleton({
    name: 'nav-cms',
    label: 'Sidebar: gitvfs-cms',
    path: `${root}/cms/meta.json`,
    schema: navigationSchema,
    commitMessage,
  }),
]
