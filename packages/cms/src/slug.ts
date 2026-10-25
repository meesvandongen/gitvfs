/** Turn arbitrary text into a URL- and filename-safe slug. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Slugs name files directly inside a collection folder, so they cannot contain separators. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(slug) && !slug.includes('..')
}
