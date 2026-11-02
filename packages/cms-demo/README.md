# gitvfs-cms demo

A public playground for [gitvfs-cms](../cms). It runs the real editor, the real gitvfs GitHub provider and real API requests. Those requests are answered in the browser by [gitvfs-github-msw](../github-msw), a Mock Service Worker mock of the GitHub API. Each visitor gets a private copy of the repository in `localStorage`; every save is a commit there, and **Reset demo** restores the original content.

## What it shows

| Content | Format | Features |
| --- | --- | --- |
| Blog posts | markdown | every built-in field type (text, textarea, date, select, number, checkboxes, a list, a nested object, markdown); slugs derived from titles; custom sort; frontmatter the schema does not know is preserved; a stored file that fails validation |
| Documentation | MDX | the site's own stylesheet in the preview (`previewStylesheets`) |
| Authors | JSON | a custom field type (`ColorField.tsx`), a custom preview (`previews.tsx`), a list of objects |
| Events | YAML | an optional nested object with a map pin, a list of objects with numbers, a custom preview |
| Places | YAML | map fields: a point, a point with a delivery radius, a service area polygon, a route line and labelled branch markers (`geoPoints`); address search on every map field through `mapDefaults={{ geocoder: nominatimGeocoder() }}` |
| Site settings, Homepage, Theme | JSON, markdown, YAML | singletons |

Editing happens in **changes** (`changes: true`): **New change** in the sidebar starts a branch, saves become commits there, and **Review & publish** lists what changed, opens a pull request and merges it. Inside a change, fields that differ from `main` are marked (with **Revert**), and the preview's **Changes** tab shows both versions rendered (**Before & after**) or as a source diff. The mock serves the branch, compare and pull request endpoints this needs.

The mock serves two repositories, `acme/site` and `acme/labs`. **Switch repository** in the sidebar opens `RepositoryPicker`, which lists them through `github({ token }).listRepositories()`; the choice is remembered across reloads, and **Reset demo** restores both.

The content model is in `src/content.ts` and the seed files are at its end. Change the storage key in `src/main.tsx` when the seed changes, so returning visitors start over.

## Develop

```sh
pnpm --filter gitvfs-cms-demo dev   # http://localhost:3002
```

## Deploy

Deployed as static assets by Cloudflare [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/); GitHub CI never runs Wrangler.

- **Worker:** `gitvfs-cms-demo`
- **Root directory:** `packages/cms-demo`
- **Build command:** `pnpm run build`
- **Deploy command:** `npx wrangler deploy` (production branch)
- **Preview command:** `npx wrangler preview` (every other branch)
- **Domain:** `demo.cms.gitvfs.mvd.im`

The build emits `mockServiceWorker.js` at the root, so the service worker controls the whole site.
