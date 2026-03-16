# gitvfs

`gitvfs` is a tiny filesystem-style wrapper over Git provider APIs. It lets apps browse repositories, stage edits locally, and commit changes back to GitHub or GitLab.

**Demo:** [gitvfs-demo.mvd.im](https://gitvfs-demo.mvd.im/)

## Features

- GitHub and GitLab providers
- Filesystem-like reads: `readFile`, `readdir`, `exists`, `stat`
- Local staging for writes, deletes, and renames
- Buffered commits to a branch
- Separate read and write branches
- Optional auto-commit with custom commit messages
- Text and binary file support
- Prefetch for faster warm-up
- Cache backends: memory, IndexedDB, none, or a custom adapter
- Automatic cache invalidation when the branch head changes
- Typed errors for common API failures

## Install

```sh
pnpm add gitvfs
```

## Quick start

```ts
import { GitFS } from 'gitvfs'
import { github } from 'gitvfs/providers/github'

const fs = new GitFS({
  provider: github({
    owner: 'acme',
    repo: 'docs',
    token: () => localStorage.getItem('github_token') ?? '',
  }),
  branch: 'main',
})

const readme = await fs.readFile('README.md', { encoding: 'utf-8' })
fs.writeFile('notes/todo.txt', 'hello from gitvfs\n')
await fs.commit('Add todo file')
```

## API at a glance

- Read: `readFile`, `readdir`, `exists`, `stat`, `prefetch`
- Edit: `writeFile`, `rm`, `rename`
- Change management: `status`, `discard`, `commit`
- Branches: `createBranch`, `checkout`

## Provider imports

- `gitvfs/providers/github`
- `gitvfs/providers/gitlab`
- `gitvfs/cache/indexeddb`

That’s the whole pitch: Git-backed file access, minus the Git plumbing headache.