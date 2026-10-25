import type { Config } from '@react-router/dev/config'
import { glob } from 'node:fs/promises'
import { createGetUrl, getSlugs } from 'fumadocs-core/source'

const getUrl = createGetUrl('/docs')

// Everything is prerendered to static files and served from Workers static assets.
export default {
  ssr: false,
  async prerender({ getStaticPaths }) {
    const paths = [...getStaticPaths()]

    for await (const entry of glob('**/*.mdx', { cwd: 'content/docs' })) {
      const slugs = getSlugs(entry)
      paths.push(getUrl(slugs), `/llms.mdx/docs/${[...slugs, 'content.md'].join('/')}`)
    }

    return paths
  },
} satisfies Config
