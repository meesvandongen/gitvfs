/** Normalize a path: remove leading/trailing slashes, collapse double slashes. */
export function normalize(path: string): string {
  return path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')
}

/** Join path segments. */
export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join('/'))
}

/** Get the directory name of a path. */
export function dirname(path: string): string {
  const normalized = normalize(path)
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash === -1 ? '' : normalized.slice(0, lastSlash)
}

/** Get the base name (last segment) of a path. */
export function basename(path: string): string {
  const normalized = normalize(path)
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)
}
