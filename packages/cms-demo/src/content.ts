import { z } from 'zod'
import {
  code,
  codeBlock,
  dateRange,
  datetime,
  defineCollection,
  defineSingleton,
  duration,
  field,
  geoCircle,
  geoLine,
  geoPoint,
  geoPoints,
  geoPolygon,
  graph,
  markdown,
  mermaid,
  money,
  openingHours,
  phone,
  recurrence,
  reference,
  references,
  slider,
  table,
  textarea,
  time,
  tree,
} from 'gitvfs-cms'

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
    // References store the slug of an entry of another collection: `author: ada-lovelace`.
    author: reference({ collection: 'authors', label: 'Author', display: ['role'] }),
    relatedPosts: references({
      collection: 'posts',
      label: 'Related posts',
      description: 'Up to three, in the order they are shown',
      max: 3,
      display: ['category', 'date'],
    }).default([]),
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
        coordinates: geoPoint({ label: 'Pin on the map', height: 240 }).optional(),
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
      .default([])
      .check(table({ label: 'Tickets' })),
    dates: dateRange({ label: 'Dates', description: 'For events that run over several days', maxLength: 14, locale: 'en-GB' }).optional(),
    repeats: recurrence({ label: 'Repeats', description: 'For a series, such as office hours', time: true, locale: 'en-GB' }).optional(),
  }),
  sort: (a, b) => String(a.data.starts ?? '').localeCompare(String(b.data.starts ?? '')),
})

const amsterdam = { lat: 52.372, lng: 4.9 }

export const places = defineCollection({
  name: 'places',
  label: 'Places',
  folder: 'data/places',
  format: 'yaml',
  schema: z.object({
    title: z.string().min(1),
    kind: z.enum(['shop', 'office', 'warehouse']),
    location: geoPoint({ label: 'Location', description: 'Click the map, drag the marker, or paste "52.37, 4.89"', center: amsterdam, zoom: 11 }),
    delivery: geoCircle({
      label: 'Delivery range',
      description: 'A point with a radius in meters',
      center: amsterdam,
      zoom: 11,
      minRadius: 250,
      maxRadius: 15_000,
      defaultRadius: 2_000,
    }).optional(),
    serviceArea: geoPolygon({ label: 'Service area', center: amsterdam, zoom: 11 }).optional(),
    route: geoLine({ label: 'Walking route from the station', center: amsterdam, zoom: 14, maxPoints: 20 }).optional(),
    hours: openingHours({ label: 'Opening hours', description: 'Local times; a closing time before the opening time is on the next day' }).optional(),
    branches: geoPoints({
      label: 'Branches',
      description: 'Pickup points: click the map or search to add one, and name it in the list',
      labels: true,
      center: amsterdam,
      zoom: 12,
      maxPoints: 10,
    }).optional(),
  }),
})

export const shows = defineCollection({
  name: 'shows',
  label: 'Shows',
  folder: 'data/shows',
  format: 'yaml',
  schema: z.object({
    title: z.string().min(1),
    // Read-only fields cannot be filled in, so new shows get a generated id.
    id: z
      .string()
      .default(() => `tm-${crypto.randomUUID().slice(0, 5)}`)
      .check(field({ label: 'Ticketing ID', description: 'Set by the ticketing system', readOnly: true })),
    // Import metadata: not shown in the editor, kept on save (see the Source tab).
    importedAt: datetime({ timeZone: 'UTC', hidden: true }).optional(),
    starts: datetime({ label: 'Starts', timeZone: 'Europe/Amsterdam', description: 'Amsterdam time, wherever you edit from' }),
    doors: time({ label: 'Doors open', step: 900 }).optional(),
    runtime: duration({ label: 'Running time' }),
    intermission: duration({ label: 'Intermission', units: ['minutes'] }).optional(),
    price: money({ label: 'Ticket price', currencies: ['EUR', 'GBP', 'USD'] }),
    onSale: z.number().int().min(0).max(100).check(slider({ label: 'Seats on sale', unit: '%' })),
    onSaleFrom: datetime({ label: 'Tickets on sale from', description: 'In your own time zone' }).optional(),
    boxOffice: phone({ label: 'Box office', description: 'Try 020 123 4567', defaultCountryCode: '31' }).optional(),
  }),
  sort: (a, b) => String(a.data.starts ?? '').localeCompare(String(b.data.starts ?? '')),
})

export const flows = defineCollection({
  name: 'flows',
  label: 'Flows',
  folder: 'data/flows',
  format: 'yaml',
  schema: z.object({
    title: z.string().min(1),
    description: z.string().check(textarea({ label: 'Description' })).optional(),
    flow: graph({
      label: 'Flow',
      description: 'Double-click to add a step, drag from its dot to connect it; or use the List view',
      nodeKinds: {
        start: { label: 'Start', shape: 'ellipse' },
        question: { label: 'Question', shape: 'diamond' },
        step: { label: 'Step', shape: 'rounded' },
        handoff: { label: 'Hand off', shape: 'rect' },
      },
      nodeFields: {
        details: z.string().check(textarea({ label: 'Details', description: 'What to say or do at this step' })).optional(),
        article: z.url().optional().check(field({ label: 'Help article' })),
      },
      edgeFields: {
        role: z.enum(['anyone', 'writer', 'editor', 'support']).optional().check(field({ label: 'Who takes this path' })),
      },
      minNodes: 1,
    }),
  }),
})

export const snippets = defineCollection({
  name: 'snippets',
  label: 'Code snippets',
  folder: 'data/snippets',
  format: 'yaml',
  schema: z.object({
    title: z.string().min(1),
    snippet: codeBlock({
      label: 'Snippet',
      description: 'Stored as { language, code }; the language is picked below the editor',
      languages: ['ts', 'js', 'json', 'yaml', 'css', 'html', 'shell', 'python', 'sql'],
    }),
    settings: code({ label: 'Settings', language: 'json', description: 'JSON, checked for syntax errors as you type', rows: 6 }).optional(),
    styles: code({ label: 'Styles', language: 'css', rows: 4 }).optional(),
    diagram: mermaid({ label: 'Diagram', description: 'Mermaid, with a live preview' }).optional(),
  }),
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
    // A reference to one of several collections stores `{ collection, slug }`.
    highlight: reference({ collection: ['posts', 'docs'], label: 'Highlighted entry' }).optional(),
    body: z.string().check(markdown()).default(''),
  }),
})

export const theme = defineSingleton({
  name: 'theme',
  label: 'Theme',
  path: 'data/theme.yml',
  schema: z.object({
    mode: z.enum(['light', 'dark', 'system']).default('system'),
    fontSize: z.number().int().min(12).max(24).check(slider({ label: 'Base font size', unit: 'px' })),
    radius: z.number().min(0).max(24).multipleOf(0.5).check(slider({ label: 'Corner radius', unit: 'px' })),
  }),
})

export const pricing = defineSingleton({
  name: 'pricing',
  label: 'Pricing',
  path: 'data/pricing.yml',
  schema: z.object({
    currency: z.enum(['EUR', 'USD']).default('EUR'),
    plans: z
      .array(
        z.object({
          name: z.string().min(1).check(field({ label: 'Plan' })),
          tier: z.enum(['starter', 'team', 'enterprise']).check(field({ label: 'Tier' })),
          monthly: z.number().min(0, 'Prices cannot be negative').check(field({ label: 'Per month' })),
          yearly: z.number().min(0, 'Prices cannot be negative').optional().check(field({ label: 'Per year' })),
          seats: z.number().int('Use whole seats').min(1).optional().check(field({ label: 'Seats' })),
          highlighted: z.boolean().default(false).check(field({ label: 'Highlight' })),
          availableFrom: z.coerce.date().optional().check(field({ label: 'Available from' })),
          // A list: shown read-only in the table, and kept as is.
          features: z.array(z.string()).default([]).check(field({ label: 'Features' })),
        }),
      )
      .min(1, 'Add at least one plan')
      .check(table({ label: 'Plans', description: 'Paste rows copied from a spreadsheet, or copy the plans as CSV' })),
  }),
})

export const navigation = defineSingleton({
  name: 'navigation',
  label: 'Navigation',
  path: 'data/navigation.yml',
  schema: z.object({
    main: tree({
      label: 'Main menu',
      description: 'The menu in the site header',
      maxDepth: 3,
      fields: {
        label: z.string().min(1).check(field({ label: 'Label' })),
        href: z.string().min(1).optional().check(field({ label: 'Link' })),
        external: z.boolean().optional().check(field({ label: 'Opens in a new tab' })),
      },
    }).default([]),
  }),
})

export const collections = [posts, docs, authors, events, places, shows, flows, snippets]
export const singletons = [site, homepage, theme, pricing, navigation]

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
author: ada-lovelace
relatedPosts:
  - editing-frontmatter
  - release-notes-0-2
---

Every entry in this demo is a file in a Git repository. The editor on the left is generated from a
**zod schema**; the preview on the right renders the markdown as you type.

## Try this

- Change the title and watch the slug and preview follow.
- Add a tag, then remove it again.
- Press **Save**: the change becomes a commit, listed at the bottom of the sidebar.
- Open the **Source** tab to see the exact file that will be committed.

> Nothing leaves your browser. The GitHub API is mocked with Mock Service Worker.

## What a save does

\`\`\`mermaid
sequenceDiagram
  participant Editor
  participant gitvfs
  participant GitHub
  Editor->>gitvfs: write the file
  gitvfs->>GitHub: create a commit
  GitHub-->>Editor: new commit SHA
\`\`\`
`,
  'content/posts/editing-frontmatter.md': `---
title: Keys the schema does not know survive
date: 2026-10-12
category: guides
tags:
  - frontmatter
layout: wide
canonical: https://example.com/original
author: grace-hopper
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
author: alan-turing
---

The stored category, \`tutorials\`, is not one of the allowed options. The editor still opens the
file and lists what does not match the schema; pick a valid category and save to fix it.

The author, \`alan-turing\`, is not in the Authors collection either. That is a warning rather than
an error, since the author may simply not be committed yet.
`,
  'content/posts/release-notes-0-2.md': `---
title: Release notes 0.2
date: 2026-08-20
category: releases
tags:
  - release
readingTime: 1
draft: true
author: ada-lovelace
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
  coordinates:
    lat: 52.3765
    lng: 4.9081
tickets:
  - name: Regular
    price: 0
  - name: Supporter
    price: 25
`,
  'data/places/canal-shop.yml': `title: Canal shop
kind: shop
location:
  lat: 52.374
  lng: 4.8897
delivery:
  lat: 52.374
  lng: 4.8897
  radius: 3000
serviceArea:
  - lat: 52.3925
    lng: 4.8701
  - lat: 52.3908
    lng: 4.9203
  - lat: 52.3561
    lng: 4.9291
  - lat: 52.3502
    lng: 4.8735
route:
  - lat: 52.3789
    lng: 4.9003
  - lat: 52.3767
    lng: 4.8962
  - lat: 52.3752
    lng: 4.8921
  - lat: 52.374
    lng: 4.8897
branches:
  - lat: 52.3791
    lng: 4.9003
    label: Central Station
  - lat: 52.3579
    lng: 4.8813
    label: Museumplein
  - lat: 52.3843
    lng: 4.9025
    label: Ferry pier Noord
hours:
  mon: []
  tue:
    - opens: "10:00"
      closes: "18:00"
  wed:
    - opens: "10:00"
      closes: "13:00"
    - opens: "14:00"
      closes: "18:00"
  thu:
    - opens: "10:00"
      closes: "21:00"
  fri:
    - opens: "10:00"
      closes: "18:00"
  sat:
    - opens: "10:00"
      closes: "17:00"
  sun:
    - opens: "12:00"
      closes: "17:00"
  exceptions:
    - date: 2026-12-25
      until: 2026-12-26
      label: Christmas
      hours: []
    - date: 2026-12-31
      label: New Year's Eve
      hours:
        - opens: "10:00"
          closes: "16:00"
`,
  'data/places/warehouse-west.yml': `title: Warehouse west
kind: warehouse
location:
  lat: 52.3874
  lng: 4.8212
hours:
  mon:
    - opens: "06:00"
      closes: "22:00"
  tue:
    - opens: "06:00"
      closes: "22:00"
  wed:
    - opens: "06:00"
      closes: "22:00"
  thu:
    - opens: "06:00"
      closes: "22:00"
  fri:
    - opens: "06:00"
      closes: "02:00"
  sat: []
  sun: []
`,
  'data/events/cms-office-hours.yml': `title: CMS office hours
starts: 2026-12-04
online: true
tickets: []
repeats:
  start: 2026-12-04T16:00
  rule: FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;UNTIL=20270625T235959
`,
  'data/events/git-summer-camp.yml': `title: Git summer camp
starts: 2027-07-19
online: false
location:
  venue: The forest camp
  city: Utrecht
tickets:
  - name: Full week
    price: 180
dates:
  start: 2027-07-19
  end: 2027-07-23
`,
  'data/flows/login-trouble.yml': `title: Login trouble
description: Support decision tree for customers who cannot sign in.
flow:
  nodes:
    - id: cannot-sign-in
      label: Customer cannot sign in
      x: 220
      y: 20
      kind: start
    - id: reset-email-arrived
      label: Did the reset email arrive?
      x: 220
      y: 160
      kind: question
    - id: use-reset-link
      label: Use the link in the email
      x: -80
      y: 300
      kind: step
      details: The link works for one hour. Ask them to open it on the same device.
      article: https://example.com/help/reset-password
    - id: in-spam
      label: Is it in the spam folder?
      x: 220
      y: 300
      kind: question
    - id: check-address
      label: Check the address on file
      x: 360
      y: 440
      kind: step
    - id: escalate
      label: Escalate to tier 2
      x: 360
      y: 560
      kind: handoff
  edges:
    - from: cannot-sign-in
      to: reset-email-arrived
    - from: reset-email-arrived
      to: use-reset-link
      label: "Yes"
    - from: reset-email-arrived
      to: in-spam
      label: "No"
    - from: in-spam
      to: use-reset-link
      label: "Yes"
    - from: in-spam
      to: check-address
      label: "No"
    - from: check-address
      to: escalate
      label: Still nothing
      role: support
`,
  'data/flows/publishing-workflow.yml': `title: Publishing workflow
description: How a post moves from draft to the site. Edges in both directions bend apart.
flow:
  nodes:
    - id: draft
      label: Draft
      x: 100
      y: 20
      kind: start
    - id: in-review
      label: In review
      x: 100
      y: 160
      kind: step
    - id: scheduled
      label: Scheduled
      x: 100
      y: 300
      kind: step
    - id: published
      label: Published
      x: 340
      y: 300
      kind: handoff
  edges:
    - from: draft
      to: in-review
      label: Submit
      role: writer
    - from: in-review
      to: draft
      label: Changes requested
      role: editor
    - from: in-review
      to: scheduled
      label: Approve
      role: editor
    - from: scheduled
      to: published
      label: Publish date reached
    - from: published
      to: draft
      label: Update
      role: writer
`,
  'data/shows/late-night-jazz.yml': `title: Late night jazz
id: tm-48213
importedAt: 2026-10-01T08:00:00Z
starts: 2026-11-20T21:30:00+01:00
doors: "20:45"
runtime: PT1H45M
intermission: PT15M
price:
  amount: 24.5
  currency: EUR
onSale: 80
boxOffice: "+31201234567"
`,
  'data/shows/the-tempest-matinee.yml': `title: The Tempest (matinee)
id: tm-48377
importedAt: 2026-10-01T08:00:00Z
starts: 2026-12-06T14:00:00+01:00
runtime: PT2H30M
price:
  amount: 18
  currency: GBP
onSale: 45
onSaleFrom: 2026-11-01T10:00:00+01:00
`,
  'data/snippets/fetch-entries.yml': `title: Fetch entries
snippet:
  language: ts
  code: |
    import type { GitCms } from 'gitvfs-cms'

    // List the blog posts, newest first.
    export async function latestPosts(cms: GitCms, count = 5) {
      const entries = await cms.listEntries('posts')
      return entries.slice(0, count).map((entry) => ({
        title: entry.label,
        href: \`/blog/\${entry.slug}\`,
      }))
    }
settings: |
  {
    "pageSize": 10,
    "features": ["search", "rss"],
    "beta": false
  }
styles: |
  .post-card {
    padding: 1rem;
    border-radius: 8px; /* matches the theme */
  }
diagram: |
  flowchart LR
    A[Editor] -->|save| B(gitvfs)
    B --> C{Provider}
    C -->|REST| D[GitHub]
    C -->|REST| E[GitLab]
`,
  'data/snippets/broken-json.yml': `title: Broken JSON
snippet:
  language: yaml
  code: |
    deploy:
      branch: main
      preview: true
settings: |
  {
    "pageSize": 10,
    "features": ["search", "rss"],
  }
diagram: |
  flowchart TD
    A[Start] --> B[
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
highlight:
  collection: posts
  slug: welcome-to-gitvfs-cms
---

Welcome! This body is markdown too.
`,
  'data/theme.yml': 'mode: system\nfontSize: 16\nradius: 8\n',
  'data/pricing.yml': `currency: EUR
plans:
  - name: Free
    tier: starter
    monthly: 0
    seats: 1
    highlighted: false
    features:
      - 1 site
      - Community support
  - name: Team
    tier: team
    monthly: 12
    yearly: 120
    seats: 10
    highlighted: true
    features:
      - 10 sites
      - Preview deployments
      - Email support
  - name: Enterprise
    tier: enterprise
    monthly: 49
    yearly: 490
    highlighted: false
    availableFrom: 2027-01-01
    features:
      - Unlimited sites
      - Single sign-on
`,
  'data/navigation.yml': `main:
  - label: Home
    href: /
  - label: Product
    children:
      - label: Features
        href: /features
      - label: Pricing
        href: /pricing
      - label: Integrations
        href: /integrations
        children:
          - label: GitHub
            href: /integrations/github
          - label: GitLab
            href: /integrations/gitlab
  - label: Docs
    href: /docs
    children:
      - label: Getting started
        href: /docs/getting-started
      - label: Content types
        href: /docs/content-types
  - label: Blog
    href: /blog
  - label: Status
    href: https://status.example.com
    external: true
`,
}

/** A second repository with the same content model, to show switching with the repository picker. */
export const labsSeedFiles: Record<string, string> = {
  'README.md': '# Acme Labs\n\nExperiments from the Acme team.\n',
  'content/posts/hello-from-labs.md': `---
title: Hello from Acme Labs
date: 2026-10-20
category: news
tags:
  - labs
featured: true
author: grace-hopper
---

This post lives in a different repository, **acme/labs**. You opened it with the repository
picker: the CMS lists what the signed-in account can reach and edits whichever one you choose.
`,
  'data/authors/grace-hopper.json': `${JSON.stringify(
    { name: 'Grace Hopper', role: 'editor', bio: 'Runs the lab.', color: '#b45309', socials: [] },
    null,
    2,
  )}\n`,
  'data/site.json': `${JSON.stringify(
    {
      title: 'Acme Labs',
      tagline: 'Experiments, kept in Git.',
      url: 'https://labs.example.com',
      accent: '#b45309',
      maintenance: false,
      nav: [{ label: 'Blog', href: '/blog' }],
    },
    null,
    2,
  )}\n`,
  'content/index.md': `---
title: Acme Labs
cta:
  label: Read the blog
  href: /blog
---

What we are trying next.
`,
  'data/theme.yml': 'mode: dark\nfontSize: 15\nradius: 4\n',
}
