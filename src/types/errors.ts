export class GitFSError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'GitFSError'
    this.code = code
  }
}

export class NotFoundError extends GitFSError {
  constructor(message: string) {
    super(message, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

export class RateLimitError extends GitFSError {
  retryAfter: number

  constructor(message: string, retryAfter: number) {
    super(message, 'RATE_LIMIT')
    this.name = 'RateLimitError'
    this.retryAfter = retryAfter
  }
}

export class ConflictError extends GitFSError {
  constructor(message: string) {
    super(message, 'CONFLICT')
    this.name = 'ConflictError'
  }
}

export class AuthError extends GitFSError {
  constructor(message: string) {
    super(message, 'AUTH')
    this.name = 'AuthError'
  }
}

export class NetworkError extends GitFSError {
  constructor(message: string) {
    super(message, 'NETWORK')
    this.name = 'NetworkError'
  }
}
