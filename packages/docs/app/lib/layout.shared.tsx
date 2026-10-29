import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { appName, gitConfig } from './shared'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
    },
    links: [
      { text: 'Docs', url: '/docs' },
      { text: 'Edit docs', url: '/admin' },
      { text: 'Demo', url: 'https://gitvfs-demo.mvd.im/', external: true },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  }
}
