# gitvfs-github-msw

A mock of the GitHub API for [Mock Service Worker](https://mswjs.io), covering what [gitvfs](../gitvfs) uses. Apps and tests run the real `gitvfs/providers/github` code against a Git repository that lives in memory or in the browser's storage.

It powers the [gitvfs-cms demo](../cms-demo), where visitors can create, edit and delete content without a GitHub account.

## What it covers

| Endpoint | Used by gitvfs for |
| --- | --- |
| `GET /user/repos` | `listRepositories()`: every mocked repository (describe each with `details`) |
| `GET /repos/:owner/:repo/git/ref/heads/:branch` | branch heads, cache invalidation |
| `POST /repos/:owner/:repo/git/refs`, `DELETE …/git/refs/heads/:branch` | creating and deleting branches |
| `POST /repos/:owner/:repo/merges` | `updateFromBase()`: merge commits, `204` when up to date, `409` on conflicts |
| `GET /repos/:owner/:repo/git/commits/:sha`, `…/git/trees/:sha?recursive=1` | recursive listings |
| `GET /repos/:owner/:repo/contents/:path?ref=` | directory listings |
| `GET /repos/:owner/:repo/git/blobs/:sha` | binary files |
| `POST /graphql`: `object(expression: "ref:path")` | reading files |
| `POST /graphql`: `createCommitOnBranch` | commits, including `expectedHeadOid` conflicts |
| `GET /user` | the signed-in user |

Like GitHub, every endpoint requires an `Authorization` header, but any token works. Requests for other repositories fall through to the network.

## Usage

```ts
import { setupWorker } from 'msw/browser'
import { createGitHubHandlers, MockRepository, persistentRepository } from 'gitvfs-github-msw'

const { repository, save, reset } = await persistentRepository({
  key: 'my-demo',
  seed: () => MockRepository.create({ files: { 'content/hello.md': '# Hello\n' } }),
})

await setupWorker(
  ...createGitHubHandlers({ repositories: [{ owner: 'acme', repo: 'site', repository }], onChange: save }),
).start()

// Anything using gitvfs now talks to the mock:
const gh = github({ token: 'demo' })
const fs = new GitVFS({ repository: gh.repository('acme/site'), branch: 'main' })
```

List more entries in `repositories` to serve several; `details` sets the description, visibility and default branch that `/user/repos` reports. `onChange` receives the repository that changed.

`persistentRepository` saves the repository to `localStorage` after every change and restores it on the next visit. `reset()` goes back to the seed.

In tests, use `setupServer` from `msw/node` with a plain `MockRepository`. `repository.log(branch)` lists the commits, which is useful for assertions.

## Model

`MockRepository` holds the following, all serializable as JSON:
- branches;
- commits (with parents, messages and dates; merge commits have a second parent);
- flat trees (path → blob id);
- blobs, stored as base64.

Blob ids are real Git object ids. Commit ids are random but stable within a repository. Merges work on whole files: a file both branches changed differently is a conflict.
