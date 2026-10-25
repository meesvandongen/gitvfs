import { lazy, Suspense, useEffect, useState } from 'react'

// The editor talks to the GitHub API with the visitor's token, so it only ever runs in the
// browser. The prerendered page is just this shell; the CMS bundle loads on demand.
const AdminApp = lazy(() => import('@/admin/AdminApp'))

export function meta() {
  return [{ title: 'Edit docs | gitvfs' }, { name: 'robots', content: 'noindex' }]
}

export default function Admin() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const loading = <p className="p-8 text-fd-muted-foreground">Loading editor…</p>
  return mounted ? <Suspense fallback={loading}>{<AdminApp />}</Suspense> : loading
}
