import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { appName, cmsDemoUrl, demoUrl, gitConfig } from './shared'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
    },
    links: [
      { text: 'Docs', url: '/docs' },
      { text: 'CMS demo', url: cmsDemoUrl, external: true },
      { text: 'Repository demo', url: demoUrl, external: true },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  }
}
