import { describe, it, expect } from 'vitest'
import { ChangeBuffer } from '../../src/change-buffer'

describe('ChangeBuffer', () => {
  it('adds and retrieves changes', () => {
    const buffer = new ChangeBuffer()
    buffer.add({ action: 'create', path: 'foo.txt', content: 'hello' })
    expect(buffer.has('foo.txt')).toBe(true)
    expect(buffer.get('foo.txt')).toEqual({
      action: 'create',
      path: 'foo.txt',
      content: 'hello',
    })
  })

  it('tracks deletions', () => {
    const buffer = new ChangeBuffer()
    buffer.add({ action: 'delete', path: 'foo.txt' })
    expect(buffer.isDeleted('foo.txt')).toBe(true)
  })

  it('returns all changes', () => {
    const buffer = new ChangeBuffer()
    buffer.add({ action: 'create', path: 'a.txt', content: 'a' })
    buffer.add({ action: 'update', path: 'b.txt', content: 'b' })
    buffer.add({ action: 'delete', path: 'c.txt' })
    expect(buffer.all()).toHaveLength(3)
    expect(buffer.size).toBe(3)
  })

  it('overwrites changes for same path', () => {
    const buffer = new ChangeBuffer()
    buffer.add({ action: 'create', path: 'a.txt', content: 'v1' })
    buffer.add({ action: 'update', path: 'a.txt', content: 'v2' })
    expect(buffer.size).toBe(1)
    expect(buffer.get('a.txt')?.content).toBe('v2')
  })

  it('clears all changes', () => {
    const buffer = new ChangeBuffer()
    buffer.add({ action: 'create', path: 'a.txt', content: 'a' })
    buffer.clear()
    expect(buffer.size).toBe(0)
    expect(buffer.has('a.txt')).toBe(false)
  })
})
