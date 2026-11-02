import { z } from 'zod'
import {
  defineCollection,
  defineSingleton,
  embed,
  field,
  file,
  gallery,
  geoCircle,
  geoLine,
  geoPoint,
  geoPolygon,
  image,
  imagePath,
  markdown,
  table,
  textarea,
  tree,
} from 'gitvfs-cms'

// One content model that touches every feature: all field types, the three formats, collections
// and singletons, custom fields and previews, and files the schema does not fully describe.

// Uploads are committed into public/, which the site serves from its root.
const postImages = { folder: 'public/images/posts', publicPath: '/images/posts', maxSize: 1024 * 1024 }

const color = (label: string) => field({ label, fieldType: 'color', description: 'A custom field type: see ColorField.tsx' })

export const posts = defineCollection({
  name: 'posts',
  label: 'Blog posts',
  folder: 'content/posts',
  schema: z.object({
    title: z.string().min(3).check(field({ label: 'Title', description: 'The slug of new posts is derived from it' })),
    cover: image({ label: 'Cover image', description: 'Click the image to set the focal point', ...postImages }).optional(),
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
    body: z.string().check(markdown({ label: 'Content', media: postImages })).default(''),
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
    avatar: imagePath({ label: 'Avatar', folder: 'public/images/authors', publicPath: '/images/authors', maxSize: 512 * 1024 }).optional(),
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
    photos: gallery({ label: 'Photos', folder: 'public/images/events', publicPath: '/images/events', max: 8, maxSize: 1024 * 1024 }).optional(),
    agenda: file({ label: 'Agenda (PDF)', folder: 'public/files', publicPath: '/files', accept: '.pdf,application/pdf', maxSize: 1024 * 1024 }).optional(),
    video: embed({ label: 'Recording', description: 'A YouTube or Vimeo link', providers: ['youtube', 'vimeo'] }).optional(),
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

export const collections = [posts, docs, authors, events, places]
export const singletons = [site, homepage, theme, pricing, navigation]

const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))

// Tiny generated images and a one-page PDF, so the media fields have something to show.
const SUNSET_PNG = fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAB0UlEQVR42u3QXUsTYBjG8evjdCaEghAEggdCIAlBEHQgSIEgTveWc26u2XS6NUqRiuFbSIXJRFKkZDFipEghIiKihERE9CH0YCeddI89z008T1zwO78u/mjq/00CXO3/RQK0BH6SAK2BHyTAtYHvJMD1wXMSoG3wGwnQHjwjATpCpyTAjdAJCdAZPiYBusJHJMCtyCEJcDt6QALcie6TAHcffCUBuoe+kAA9Q3skwP3YLgnQG/tMAvQNV0mAQPyTdy6O7v2N+haC8YpfhDo1unOIjHz0Rd00f9IaRSxR9kVDgbRGMZLY9kJDdWpUdjGafO8+gzo19tNIJ7fcZxzIfhqZ0U33GQeyn0Y29c59xoHsp5FLrbvPOJD9NAoP19xnHMh+GtPpkvuMA9lPYza96j7jQPbTeD624j7jQPbTKI698YJBHZVdzD965YuG6miNYimz7IuGAmmNYjnz0i910+jO4fX4oneEOupbeDuxQAKUJuZIgPVskQTYyL4gAbYmn5EAV5pvavkwNWvPtT+agcpTM/Zc+6MZqJJ7as+1P5qBqvkn9lz7oxloJ1+w59ofzUB7j/P2XPujGei/xEAMxEAMxEAMxEAMxEDEQAzEQP/eJdhsNa4Ssmp7AAAAAElFTkSuQmCC',
)
const CROWD_PNG = fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAABq0lEQVR42u3Nx1KUURiE4b4w1lwEa9beB0lBQTGRRMlxyJkZskpUwQSI4SJ65WbqrzPMVJ/9f7rqWb7f1+C/AxPAv/smgH/2TAB/75oA3u2YAP4qmQDeFk0Ab7ZNAK+3TAB/bpoA/tgwAfy+bgL4bc0E8OuqCeDVigng5bIJ4JclE8DPiyaAnxZMAC/mTQDP50wAzwomgKezJoAnM/fU1T+oVp0l0oPH06GadfmmskykBz9OZURdvgniRHrww2QmfhDEifTg+4lM/CCIE+nBo/FM/CCIE+nBw7FM/CCIE+nBg9FM/CCIE+nB/ZFM/CCIE+nBveGQqivLRHpwd+ie2nVVlkgP7rwzASy9NQEsDpoAbr8xAdwaMAHc7DcB3OgzAVzvjWpobK2WSA+u9Wg1v5c3EujB1deC+F7eyHsPrrwS4gN578Hll0J8IO89uPRCiA/kvQcXnwvxgbz34EK3EB/Iew/OPxPiA3nvwbmnmvqeQA8WuqJqf0+jB2c7TQBnnpgATj82AZzqMAGcbDcBnHhkAjj+0ARwrM0EcLTVBHCkxQRwuNkEcKjJhP/zG6RE7m5xLwAAAABJRU5ErkJggg==',
)
const AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#7c3aed"/>
  <circle cx="32" cy="25" r="11" fill="#ede9fe"/>
  <path d="M12 58c2-12 10-18 20-18s18 6 20 18z" fill="#ede9fe"/>
</svg>
`
const AGENDA_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 58 >> stream
BT /F1 18 Tf 24 90 Td (gitvfs meetup: agenda) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
`

/** The repository visitors start with, and go back to on reset. */
export const seedFiles: Record<string, string | Uint8Array> = {
  'public/images/posts/sunset.png': SUNSET_PNG,
  'public/images/authors/ada-lovelace.svg': AVATAR_SVG,
  'public/images/events/meetup-crowd.png': CROWD_PNG,
  'public/images/events/meetup-sunset.png': SUNSET_PNG,
  'public/files/meetup-agenda.pdf': AGENDA_PDF,
  'README.md': '# Acme site\n\nContent for the gitvfs-cms demo.\n',
  'content/posts/welcome-to-gitvfs-cms.md': `---
title: Welcome to gitvfs-cms
cover:
  src: /images/posts/sunset.png
  alt: A sun setting over dark hills
  focus:
    x: 0.67
    y: 0.47
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
- Upload a cover image, or use the **Image** button in the toolbar: the file is committed together
  with the post, in the same commit.

![The cover image again, from the repository](/images/posts/sunset.png)

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
      avatar: '/images/authors/ada-lovelace.svg',
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
photos:
  - src: /images/events/meetup-crowd.png
    alt: People listening to a talk
  - src: /images/events/meetup-sunset.png
    alt: The view from the terrace afterwards
agenda: /files/meetup-agenda.pdf
video: https://www.youtube.com/watch?v=aircAruvnKk
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
`,
  'data/places/warehouse-west.yml': `title: Warehouse west
kind: warehouse
location:
  lat: 52.3874
  lng: 4.8212
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
author:
  name: Grace Hopper
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
