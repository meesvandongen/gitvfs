import { describe, it, expect } from 'vitest'
import {
  GitFSError,
  NotFoundError,
  RateLimitError,
  ConflictError,
  AuthError,
  NetworkError,
} from '../../src/types/errors'

describe('errors', () => {
  it('GitFSError has message and code', () => {
    const err = new GitFSError('test message', 'TEST_CODE')
    expect(err.message).toBe('test message')
    expect(err.code).toBe('TEST_CODE')
    expect(err.name).toBe('GitFSError')
    expect(err).toBeInstanceOf(Error)
  })

  it('NotFoundError has NOT_FOUND code', () => {
    const err = new NotFoundError('not found')
    expect(err.code).toBe('NOT_FOUND')
    expect(err.name).toBe('NotFoundError')
    expect(err).toBeInstanceOf(GitFSError)
  })

  it('RateLimitError has RATE_LIMIT code and retryAfter', () => {
    const err = new RateLimitError('rate limited', 30)
    expect(err.code).toBe('RATE_LIMIT')
    expect(err.retryAfter).toBe(30)
    expect(err.name).toBe('RateLimitError')
    expect(err).toBeInstanceOf(GitFSError)
  })

  it('ConflictError has CONFLICT code', () => {
    const err = new ConflictError('conflict')
    expect(err.code).toBe('CONFLICT')
    expect(err.name).toBe('ConflictError')
    expect(err).toBeInstanceOf(GitFSError)
  })

  it('AuthError has AUTH code', () => {
    const err = new AuthError('unauthorized')
    expect(err.code).toBe('AUTH')
    expect(err.name).toBe('AuthError')
    expect(err).toBeInstanceOf(GitFSError)
  })

  it('NetworkError has NETWORK code', () => {
    const err = new NetworkError('network failed')
    expect(err.code).toBe('NETWORK')
    expect(err.name).toBe('NetworkError')
    expect(err).toBeInstanceOf(GitFSError)
  })
})
