# gitvfs-cms

A Git-backed content management system. Describe your content with [zod](https://zod.dev) schemas. `gitvfs-cms` reads and writes it as markdown with YAML frontmatter, JSON or YAML files in a GitHub or GitLab repository, through [gitvfs](../gitvfs). Every save is a commit. The React editor generates its forms with [AutoForm](https://autoform.vantezzen.io/) and shows a live preview.

## Install

```sh
pnpm add gitvfs gitvfs-cms zod
# for the editor UI
pnpm add react react-dom react-hook-form @hookform/resolvers
# for OpenID Connect sign-in
pnpm add oidc-spa
```

## Quick start

```tsx
import { z } from 'zod'
import { GitFS } from 'gitvfs'
import { github } from 'gitvfs/providers/github'
import { createCms, defineCollection, defineSingleton, markdown } from 'gitvfs-cms'
import { CmsApp } from 'gitvfs-cms/react'
import 'gitvfs-cms/styles.css'

const posts = defineCollection({
  name: 'posts',
  label: 'Posts',
  folder: 'content/posts',
  schema: z.object({
    title: z.string().min(1),
    date: z.coerce.date().optional(),
    draft: z.boolean().default(false),
    body: z.string().check(markdown()).default(''),
  }),
})

const site = defineSingleton({
  name: 'site',
  path: 'data/site.json',
  schema: z.object({ title: z.string() }),
})

const cms = createCms({
  fs: new GitFS({ provider: github({ owner: 'acme', repo: 'site', token }), branch: 'main' }),
  collections: [posts],
  singletons: [site],
})

export const Admin = () => <CmsApp cms={cms} title="Acme" />
```

## Entry points

| Import | Contents | Needs |
| --- | --- | --- |
| `gitvfs-cms` | `defineCollection`, `defineSingleton`, `createCms` / `GitCms`, document parsing, field helpers | `gitvfs`, `zod` |
| `gitvfs-cms/react` | `CmsApp`, `DocumentEditor`, `ContentForm`, previews, AutoForm components | `react`, `react-dom`, `react-hook-form`, `@hookform/resolvers` |
| `gitvfs-cms/oidc` | `createOidcSession`, `oidcTokenProvider`, `gitlabOidc` | `oidc-spa` |
| `gitvfs-cms/styles.css` | Default editor theme (`gcms-*` classes, CSS custom properties) | |

## Highlights

- **Collections** (a folder of entries) and **singletons** (one file), in markdown, JSON or YAML.
- **Faithful saves:** keys the schema does not know are kept, and existing keys keep their order, so diffs stay small.
- **Validation** against the schema before anything is committed. Stored files that do not match still open, with the issues listed.
- **Editor** with text, number, checkbox, date, select, list, group, textarea and markdown fields (the markdown field has a toolbar).
- **Preview** in an iframe sandboxed without scripts, so repository content cannot reach the user's token. A **Source** tab shows the exact file that will be committed.
- **OIDC sign-in** via [oidc-spa](https://www.oidc-spa.dev/), with a GitLab preset whose OAuth tokens work directly against the GitLab API.

Full documentation: [`packages/docs`](../docs), whose `/admin` page edits the docs with this package.

## Develop

```sh
pnpm --filter gitvfs-cms dev    # playground with an in-memory repository at http://localhost:3001
pnpm --filter gitvfs-cms test
pnpm --filter gitvfs-cms build
```
