// React Router writes the client-rendered fallback for routes that were not prerendered to
// __spa-fallback.html. Workers static assets serve 404.html for unknown paths, so copy it there.
import { copyFile } from 'node:fs/promises'

await copyFile('build/client/__spa-fallback.html', 'build/client/404.html')
