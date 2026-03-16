# gitvfs Personal Access Token React Sample

A React single-page app that demonstrates a simple “bring your own token” flow with [TanStack Router](https://tanstack.com/router) and [gitvfs](../../). Users choose GitHub or GitLab, paste a personal access token by hand, and the app stores it in browser storage for repository browsing and editing.

## What it does

1. Lets users choose GitHub or GitLab in the UI.
2. Prompts for a personal access token directly in the app.
3. Saves the token in `localStorage` for the selected provider.
4. Uses the saved token with `gitvfs` to browse repositories and files.
5. Allows editing text files and committing changes back to the repository.

## Stack

- React 19
- TanStack Router
- Vite 8
- TypeScript
- `gitvfs`

## Prerequisites

- Node.js 20.19+
- A GitHub or GitLab account with repositories you want to browse or edit
- A personal access token for the provider you want to use

## Setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Optional: copy `.env.example` to `.env` if you want to target a self-managed GitLab instance.

   | Variable | Description |
   |---|---|
   | `VITE_GITLAB_URL` | Optional base URL for self-managed GitLab |

3. Start the dev server:

   ```sh
   pnpm dev
   ```

4. Open [http://localhost:3000](http://localhost:3000), choose a provider, and paste a token.

## Creating tokens

### GitHub

Create a token at [GitHub personal access tokens](https://github.com/settings/personal-access-tokens/new).

- Classic tokens usually need `repo` access to browse and commit.
- Fine-grained tokens should have repository contents access plus metadata read access for the repositories you want to browse.

### GitLab

Create a token in GitLab under **User Settings → Access Tokens**.

- Give the token the `api` scope so the sample can list projects, read files, and commit changes.

For self-managed GitLab, set this in `.env`:

```txt
VITE_GITLAB_URL=https://gitlab.example.com
```

## Storage note

This sample stores tokens in `localStorage` for the current browser profile. That keeps the demo straightforward, but it is not a substitute for a production-grade secret-handling strategy.

## Project structure

```txt
packages/sample/
├── index.html
├── src/
│   ├── components/
│   │   └── AppFrame.tsx
│   ├── lib/
│   │   ├── git-data.ts
│   │   ├── provider-config.ts
│   │   └── user-profile.ts
│   ├── pages/
│   │   ├── EditorPage.tsx
│   │   ├── HomePage.tsx
│   │   └── RepositoriesPage.tsx
│   ├── main.tsx
│   ├── router.tsx
│   ├── style.css
│   └── vite-env.d.ts
├── .env.example
├── package.json
├── tsconfig.json
├── wrangler.jsonc
└── vite.config.ts
```

## Routing overview

- `/` — provider selection and token entry
- `/repositories` — repository list for the active provider token
- `/editor` — file browser and editor for the selected repository

The repository and editor routes redirect back to `/` when no token is saved for the active provider.

## Building for production

```sh
pnpm build
```

The production files are written to `dist/`.

## Deploying to Cloudflare Workers

This sample is configured for a static Cloudflare Workers deployment using Wrangler and the built Vite output in `dist/`.

### Workers project name

The Worker is named `gitvfs-demo`.

### Default deployment URL

After deployment, the default Workers URL will be:

```txt
https://gitvfs-demo.<your-account-subdomain>.workers.dev
```

Cloudflare uses your Worker name plus your account's `workers.dev` subdomain to form the final URL.

### Deploy steps

1. Authenticate Wrangler with your Cloudflare account:

   ```sh
   pnpm exec wrangler login
   ```

2. Deploy the app:

   ```sh
   pnpm deploy
   ```

Wrangler runs the sample build before deployment and uploads the contents of `dist/` as static assets. The config also enables single-page application fallback routing, so client-side routes like `/repositories` and `/editor` resolve to `index.html`.
