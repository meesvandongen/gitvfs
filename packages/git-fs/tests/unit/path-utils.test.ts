import { describe, it, expect } from 'vitest'
import { normalize, join, dirname, basename } from '../../src/utils/path'

describe('path utils', () => {
  describe('normalize', () => {
    it('removes leading and trailing slashes', () => {
      expect(normalize('/foo/bar/')).toBe('foo/bar')
    })

    it('collapses double slashes', () => {
      expect(normalize('foo//bar')).toBe('foo/bar')
    })

    it('handles empty string', () => {
      expect(normalize('')).toBe('')
    })

    it('handles single segment', () => {
      expect(normalize('foo')).toBe('foo')
    })
  })

  describe('join', () => {
    it('joins path segments', () => {
      expect(join('foo', 'bar', 'baz')).toBe('foo/bar/baz')
    })

    it('filters empty segments', () => {
      expect(join('', 'foo', '', 'bar')).toBe('foo/bar')
    })

    it('normalizes the result', () => {
      expect(join('/foo/', '/bar/')).toBe('foo/bar')
    })
  })

  describe('dirname', () => {
    it('returns parent directory', () => {
      expect(dirname('foo/bar/baz.txt')).toBe('foo/bar')
    })

    it('returns empty for root-level file', () => {
      expect(dirname('file.txt')).toBe('')
    })
  })

  describe('basename', () => {
    it('returns file name', () => {
      expect(basename('foo/bar/baz.txt')).toBe('baz.txt')
    })

    it('returns full name for root-level file', () => {
      expect(basename('file.txt')).toBe('file.txt')
    })
  })
})
