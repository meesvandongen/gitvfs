# gitvfs docs

Documentation for the gitvfs packages, built with [Fumadocs](https://fumadocs.dev) on React Router. Every page is prerendered to static files.

The pages are MDX files in `content/docs`. They can be edited in the browser at `/admin`, which is [gitvfs-cms](../cms) pointed at this folder of this repository: each save is a commit made with your GitHub token.

## Develop

```sh
pnpm install
pnpm --filter gitvfs-docs dev
```

The site builds `gitvfs` and `gitvfs-cms` from their sources, so no package needs to be built first.

## Deploy

Deployed by Cloudflare [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/); GitHub CI never runs Wrangler.

- **Root directory:** `packages/docs`
- **Build command:** `pnpm run build`
- **Deploy command:** `npx wrangler deploy` (production branch)
- **Preview command:** `npx wrangler preview` (every other branch)

## Sign in with GitHub

`/admin` offers **Sign in with GitHub** through [gitvfs-github-auth](../github-auth) when the Worker in `worker/index.ts` is configured for the current origin. Otherwise it falls back to personal access tokens.

1. Create a GitHub App with callback URL `https://<docs domain>/admin` and **Contents: read and write**, and install it on this repository.
2. Set `GITHUB_CLIENT_ID` and `GITHUB_ALLOWED_ORIGINS` in `wrangler.jsonc`.
3. Run `pnpm exec wrangler secret put GITHUB_CLIENT_SECRET`.

Previews do not inherit these variables, so they offer token sign-in only.

## Assets

`wrangler.jsonc` serves `build/client` as static assets, and only `/api/github/*` runs the Worker. Its empty `previews` block enables [Worker Previews](https://developers.cloudflare.com/workers/previews/). To try the production build on the Workers runtime:

```sh
pnpm run build
pnpm exec wrangler dev
```
