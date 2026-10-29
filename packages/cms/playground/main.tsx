import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GitFS } from 'gitvfs'
import { z } from 'zod'
import { createCms, defineCollection, defineSingleton, field, markdown, textarea } from '../src'
import { CmsApp } from '../src/react'
import { MemoryProvider } from '../tests/helpers/memory-provider'
import '../src/styles.css'

// Everything lives in memory: reload the page to start over.
const provider = new MemoryProvider({
  'content/posts/hello-world.md': `---
title: Hello world
date: 2024-05-01
tags:
  - intro
draft: false
---

Welcome to **gitvfs-cms**. Edit this post on the left and watch the preview update.

- Markdown with YAML frontmatter
- Commits straight to GitHub or GitLab
`,
  'content/posts/second-post.md': `---
title: A second post
date: 2024-06-12
category: notes
draft: true
---

> Drafts are just a boolean in the frontmatter.
`,
  'content/pages/about.md': '---\ntitle: About\n---\n\nThis site is managed with gitvfs-cms.\n',
  'data/site.json': JSON.stringify({ title: 'My site', description: 'A demo site' }, null, 2),
})

const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  folder: 'content/posts',
  schema: z.object({
    title: z.string().min(1).check(field({ label: 'Title' })),
    date: z.coerce.date().optional().check(field({ label: 'Publish date' })),
    category: z.enum(['news', 'notes', 'guides']).optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false).check(field({ label: 'Draft', description: 'Hidden from the site' })),
    body: z.string().check(markdown({ label: 'Content' })).default(''),
  }),
  sort: (a, b) => String(b.data.date ?? '').localeCompare(String(a.data.date ?? '')),
})

const pages = defineCollection({
  name: 'pages',
  label: 'Pages',
  folder: 'content/pages',
  schema: z.object({
    title: z.string().min(1),
    body: z.string().check(markdown({ label: 'Content' })).default(''),
  }),
})

const site = defineSingleton({
  name: 'site',
  label: 'Site settings',
  path: 'data/site.json',
  schema: z.object({
    title: z.string().min(1),
    description: z.string().check(textarea()).optional(),
  }),
})

const cms = createCms({
  fs: new GitFS({ provider, branch: 'main', cache: 'none' }),
  collections: [posts, pages],
  singletons: [site],
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CmsApp
      cms={cms}
      title="Playground"
      sidebarFooter={<span className="gcms-muted">In-memory repository</span>}
    />
  </StrictMode>,
)
