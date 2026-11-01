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

The app is a GitHub App (client ID `Iv23liL4d3j01dbuzSpS`) with callback URL `https://docs.gitvfs.mvd.im/admin` and **Contents: read and write**, installed on this repository. `GITHUB_CLIENT_ID` and `GITHUB_ALLOWED_ORIGINS` are set in `wrangler.jsonc`; `GITHUB_SCOPE` is only for OAuth Apps. The client secret is a Worker secret:

```sh
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
```

Optionally, set `GITHUB_SESSION_SECRET` (32+ characters) to keep refresh tokens in an encrypted `HttpOnly` cookie instead of the browser's session storage. Without it, sign-in still works, with tokens in `sessionStorage`:

```sh
openssl rand -base64 32 | pnpm exec wrangler secret put GITHUB_SESSION_SECRET
openssl rand -base64 32 | pnpm exec wrangler preview base-config secret put GITHUB_SESSION_SECRET
```

Cloudflare only accepts secrets once the deployed Worker has its script, not just static assets. Until the client secret is set, sign-in stays off.

Previews get their own variables from the `previews` block in `wrangler.jsonc` and allow `https://*.docs.gitvfs.mvd.im`. The app's callback URL has wildcard matching enabled, so preview subdomains sign in too. Previews need the secret separately:

```sh
pnpm exec wrangler preview base-config secret put GITHUB_CLIENT_SECRET
```

## Assets

`wrangler.jsonc` serves `build/client` as static assets, and only `/api/github/*` runs the Worker. Its `previews` block enables [Worker Previews](https://developers.cloudflare.com/workers/previews/). To try the production build on the Workers runtime:

```sh
pnpm run build
pnpm exec wrangler dev
```
