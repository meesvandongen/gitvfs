import { setupServer } from 'msw/node'
import type { RequestHandler } from 'msw'

export function createTestServer(...handlers: RequestHandler[]) {
  return setupServer(...handlers)
}
