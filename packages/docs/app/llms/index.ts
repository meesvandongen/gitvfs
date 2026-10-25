import { docsLlms } from '@/lib/source'

export async function loader() {
  return new Response(docsLlms.index())
}
