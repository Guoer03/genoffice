import { beforeEach, describe, expect, it } from 'vitest'
import { getRecentColors, pushRecentColor } from '../src/renderer/recent-colors'

beforeEach(() => {
  localStorage.clear()
})

describe('recent colors', () => {
  it('stores valid hex as uppercase RRGGBB', () => {
    pushRecentColor('#ff0000')
    expect(getRecentColors()).toEqual(['#FF0000'])
  })

  it('rejects 8-digit RGBA and trailing garbage instead of truncating', () => {
    pushRecentColor('#FF000080')
    pushRecentColor('abcdefXYZ')
    expect(getRecentColors()).toEqual([])
  })

  it('filters legacy junk entries on read', () => {
    localStorage.setItem('slides:recent-colors', JSON.stringify(['#FF000080', '#00ff00']))
    expect(getRecentColors()).toEqual(['#00FF00'])
  })
})
