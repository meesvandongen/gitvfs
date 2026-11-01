import { z } from 'zod'
import { defineCollection, defineSingleton, field, markdown, textarea } from 'gitvfs-cms'

// One content model that touches every feature: all field types, the three formats, collections
// and singletons, custom fields and previews, and files the schema does not fully describe.

const color = (label: string) => field({ label, fieldType: 'color', description: 'A custom field type: see ColorField.tsx' })

export const posts = defineCollection({
  name: 'posts',
  label: 'Blog posts',
  folder: 'content/posts',
  schema: z.object({
    title: z.string().min(3).check(field({ label: 'Title', description: 'The slug of new posts is derived from it' })),
    description: z.string().check(textarea({ label: 'Summary' })).optional(),
    date: z.coerce.date().check(field({ label: 'Publish date' })),
    category: z.enum(['news', 'guides', 'releases']).check(field({ label: 'Category' })),
    tags: z.array(z.string().min(1)).default([]).check(field({ label: 'Tags' })),
    readingTime: z.number().int().min(1).max(120).optional().check(field({ label: 'Reading time (minutes)' })),
    featured: z.boolean().default(false).check(field({ label: 'Featured on the homepage' })),
    draft: z.boolean().default(false).check(field({ label: 'Draft', description: 'Hidden from the site' })),
    author: z
      .object({
        name: z.string().min(1).check(field({ label: 'Name' })),
        url: z.url().optional().check(field({ label: 'Website' })),
      })
      .check(field({ label: 'Author' })),
    body: z.string().check(markdown({ label: 'Content' })).default(''),
  }),
  // Newest first; the default sorts by label.
  sort: (a, b) => String(b.data.date ?? '').localeCompare(String(a.data.date ?? '')),
})

export const docs = defineCollection({
  name: 'docs',
  label: 'Documentation',
  folder: 'content/docs',
  extension: 'mdx',
  schema: z.object({
    title: z.string().min(1),
    order: z.number().int().min(0).check(field({ label: 'Order in the sidebar' })),
    sidebarLabel: z.string().optional().check(field({ label: 'Sidebar label', description: 'Defaults to the title' })),
    body: z.string().check(markdown({ label: 'Content (MDX)' })).default(''),
  }),
  sort: (a, b) => Number(a.data.order ?? 0) - Number(b.data.order ?? 0),
  // The preview frame loads the site's own stylesheet.
  previewStylesheets: ['/preview.css'],
})

export const authors = defineCollection({
  name: 'authors',
  label: 'Authors',
  folder: 'data/authors',
  format: 'json',
  slugField: 'name',
  labelField: 'name',
  schema: z.object({
    name: z.string().min(1),
    role: z.enum(['editor', 'writer', 'guest']),
    bio: z.string().check(textarea({ label: 'Bio' })).optional(),
    avatar: z.url().optional().check(field({ label: 'Avatar URL' })),
    color: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a hex color like #2f6feb').check(color('Profile color')),
    socials: z
      .array(
        z.object({
          network: z.enum(['github', 'mastodon', 'bluesky', 'website']),
          url: z.url().check(field({ label: 'URL' })),
        }),
      )
      .default([])
      .check(field({ label: 'Social links' })),
  }),
})

export const events = defineCollection({
  name: 'events',
  label: 'Events',
  folder: 'data/events',
  format: 'yaml',
  schema: z.object({
    title: z.string().min(1),
    starts: z.coerce.date().check(field({ label: 'Date' })),
    online: z.boolean().default(false),
    location: z
      .object({
        venue: z.string().min(1),
        city: z.string().min(1),
      })
      .optional()
      .check(field({ label: 'Location' })),
    tickets: z
      .array(
        z.object({
          name: z.string().min(1),
          price: z.number().min(0).check(field({ label: 'Price (EUR)' })),
        }),
      )
      .default([]),
  }),
  sort: (a, b) => String(a.data.starts ?? '').localeCompare(String(b.data.starts ?? '')),
})

export const site = defineSingleton({
  name: 'site',
  label: 'Site settings',
  path: 'data/site.json',
  schema: z.object({
    title: z.string().min(1),
    tagline: z.string().check(textarea()).optional(),
    url: z.url(),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a hex color like #2f6feb').check(color('Accent color')),
    maintenance: z.boolean().default(false).check(field({ label: 'Maintenance mode' })),
    nav: z
      .array(z.object({ label: z.string().min(1), href: z.string().min(1).check(field({ label: 'Link' })) }))
      .default([])
      .check(field({ label: 'Navigation' })),
  }),
})

export const homepage = defineSingleton({
  name: 'homepage',
  label: 'Homepage',
  path: 'content/index.md',
  schema: z.object({
    title: z.string().min(1),
    subtitle: z.string().check(textarea()).optional(),
    cta: z.object({ label: z.string().min(1), href: z.string().min(1) }).check(field({ label: 'Call to action' })),
    body: z.string().check(markdown()).default(''),
  }),
})

export const theme = defineSingleton({
  name: 'theme',
  label: 'Theme',
  path: 'data/theme.yml',
  schema: z.object({
    mode: z.enum(['light', 'dark', 'system']).default('system'),
    fontSize: z.number().int().min(12).max(24).check(field({ label: 'Base font size (px)' })),
    radius: z.number().min(0).max(24).check(field({ label: 'Corner radius (px)' })),
  }),
})

export const collections = [posts, docs, authors, events]
export const singletons = [site, homepage, theme]

/** The repository visitors start with, and go back to on reset. */
export const seedFiles: Record<string, string> = {
  'README.md': '# Acme site\n\nContent for the gitvfs-cms demo.\n',
  'content/posts/welcome-to-gitvfs-cms.md': `---
title: Welcome to gitvfs-cms
description: A tour of the editor you are looking at.
date: 2026-10-30
category: news
tags:
  - tour
  - cms
readingTime: 3
featured: true
draft: false
author:
  name: Ada Lovelace
  url: https://example.com/ada
---

Every entry in this demo is a file in a Git repository. The editor on the left is generated from a
**zod schema**; the preview on the right renders the markdown as you type.

## Try this

- Change the title and watch the slug and preview follow.
- Add a tag, then remove it again.
- Press **Save**: the change becomes a commit, listed at the bottom of the sidebar.
- Open the **Source** tab to see the exact file that will be committed.

> Nothing leaves your browser. The GitHub API is mocked with Mock Service Worker.
`,
  'content/posts/editing-frontmatter.md': `---
title: Keys the schema does not know survive
date: 2026-10-12
category: guides
tags:
  - frontmatter
layout: wide
canonical: https://example.com/original
author:
  name: Grace Hopper
---

This file has \`layout\` and \`canonical\` keys that the schema does not describe. Edit and save the
post, then look at the **Source** tab or the commit: both keys are still there, in their original
place, so diffs only show what you changed.
`,
  'content/posts/a-post-that-needs-fixing.md': `---
title: A post that needs fixing
date: 2026-09-01
category: tutorials
tags: []
author:
  name: Alan Turing
---

The stored category, \`tutorials\`, is not one of the allowed options. The editor still opens the
file and lists what does not match the schema; pick a valid category and save to fix it.
`,
  'content/posts/release-notes-0-2.md': `---
title: Release notes 0.2
date: 2026-08-20
category: releases
tags:
  - release
readingTime: 1
draft: true
author:
  name: Ada Lovelace
---

### Added

- Cookie sessions for GitHub sign-in
- Preview deployments

### Fixed

- Singleton editors use the full width
`,
  'content/docs/getting-started.mdx': `---
title: Getting started
order: 1
---

Install the package and describe your content with zod:

\`\`\`ts
const posts = defineCollection({ name: 'posts', folder: 'content/posts', schema })
\`\`\`

The preview of this collection uses the site's own stylesheet (\`previewStylesheets\`).
`,
  'content/docs/content-types.mdx': `---
title: Content types
order: 2
sidebarLabel: Types
---

Collections are folders of entries. Singletons are single files, like **Site settings**.
`,
  'data/authors/ada-lovelace.json': `${JSON.stringify(
    {
      name: 'Ada Lovelace',
      role: 'editor',
      bio: 'Writes about analytical engines.',
      color: '#7c3aed',
      socials: [{ network: 'website', url: 'https://example.com/ada' }],
    },
    null,
    2,
  )}\n`,
  'data/authors/grace-hopper.json': `${JSON.stringify(
    {
      name: 'Grace Hopper',
      role: 'writer',
      bio: 'Finds bugs, literally.',
      color: '#0f766e',
      socials: [{ network: 'github', url: 'https://github.com/' }],
    },
    null,
    2,
  )}\n`,
  'data/events/gitvfs-meetup.yml': `title: gitvfs meetup
starts: 2026-11-20
online: false
location:
  venue: The Library
  city: Amsterdam
tickets:
  - name: Regular
    price: 0
  - name: Supporter
    price: 25
`,
  'data/events/cms-office-hours.yml': `title: CMS office hours
starts: 2026-12-04
online: true
tickets: []
`,
  'data/site.json': `${JSON.stringify(
    {
      title: 'Acme',
      tagline: 'Content that lives in Git.',
      url: 'https://example.com',
      accent: '#2f6feb',
      maintenance: false,
      nav: [
        { label: 'Blog', href: '/blog' },
        { label: 'Docs', href: '/docs' },
      ],
    },
    null,
    2,
  )}\n`,
  'content/index.md': `---
title: Build with Acme
subtitle: Edit this homepage, a markdown singleton with frontmatter.
cta:
  label: Read the blog
  href: /blog
---

Welcome! This body is markdown too.
`,
  'data/theme.yml': 'mode: system\nfontSize: 16\nradius: 8\n',
}
