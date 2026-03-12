# git-fs + oidc-spa Sample

A single-page application that demonstrates using [oidc-spa](https://github.com/keycloakify/oidc-spa) for authentication and [git-fs](../../) to browse and edit files in a GitHub repository.

## What it does

1. **Authenticates** the user via OpenID Connect using `oidc-spa` (Authorization Code + PKCE flow).
2. **Passes the access token** from the OIDC provider to the `git-fs` GitHub provider.
3. **Renders a file browser** backed by `git-fs` — directories are listable, files are viewable and editable.
4. **Commits edits** directly to the GitHub repository when the user saves a file.

> **Note:** This sample uses the access token issued by your OIDC provider as the GitHub API token. This works when GitHub itself is the OIDC/OAuth2 provider. If you use a different provider (Keycloak, Auth0, etc.), you will need to supply a GitHub Personal Access Token separately — see [Adapting to a different provider](#adapting-to-a-different-provider).

## Prerequisites

- Node.js 18+
- A GitHub repository you want to browse/edit
- An OIDC provider configured with a public client (no client secret, PKCE required):
  - **Redirect URI:** `http://localhost:3000`
  - **Scopes:** `openid profile email` (plus `repo` if using GitHub as the provider)

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your values:

   ```sh
   cp .env.example .env
   ```

   | Variable | Description |
   |---|---|
   | `VITE_OIDC_ISSUER_URI` | OIDC issuer URL (e.g. `https://auth.example.com/realms/myrealm`) |
   | `VITE_OIDC_CLIENT_ID` | Client ID registered with your OIDC provider |
   | `VITE_GITHUB_OWNER` | GitHub repository owner (user or org) |
   | `VITE_GITHUB_REPO` | GitHub repository name |
   | `VITE_GITHUB_BRANCH` | Branch to read from (default: `main`) |

3. Start the dev server:

   ```sh
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000).

## Using GitHub as the OIDC provider

GitHub supports OAuth 2.0 with OpenID Connect. To use GitHub as the provider:

1. [Create a GitHub OAuth App](https://github.com/settings/applications/new):
   - **Application name:** anything
   - **Homepage URL:** `http://localhost:3000`
   - **Authorization callback URL:** `http://localhost:3000`

2. Set in `.env`:
   ```
   VITE_OIDC_ISSUER_URI=https://github.com
   VITE_OIDC_CLIENT_ID=<your GitHub OAuth App client ID>
   ```

   > GitHub's OIDC issuer is `https://github.com` and it exposes a discovery document at `https://github.com/.well-known/openid-configuration`.

The access token issued by GitHub can then be used directly with the GitHub API, which is exactly what this sample does.

## Adapting to a different provider

If you authenticate with a non-GitHub OIDC provider (Keycloak, Auth0, Entra ID, etc.), the access token will not be valid for the GitHub API. In that case, modify `src/app.ts` to use a GitHub Personal Access Token instead:

```ts
// src/app.ts
const githubToken = import.meta.env.VITE_GITHUB_TOKEN  // add this to .env

const fs = new GitFS({
  provider: github({ token: githubToken, owner, repo }),
  branch,
})
```

The OIDC authentication still protects the app — users must sign in before they can see or use the file browser.

## Project structure

```
samples/oidc-spa/
├── index.html          # HTML entry point
├── src/
│   ├── main.ts         # Initializes oidc-spa, renders login or app
│   ├── app.ts          # File browser UI backed by git-fs
│   └── style.css       # Styles
├── .env.example        # Environment variable template
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## Building for production

```sh
npm run build
```

The output is in `dist/`. Deploy as a static site (Netlify, Vercel, GitHub Pages, etc.). Make sure to add your production URL as an allowed redirect URI in your OIDC provider.
