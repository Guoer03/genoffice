/** Search result types and shared constants for the index backend. */

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface ImageSearchResult {
  title: string
  imageUrl: string
  sourceUrl: string
  source: string
  width?: number
  height?: number
}

// Known stock-photo hosts skipped during image search (matches the upstream filter list)
export const COPYRIGHT_HOSTS = ['gettyimages', 'istockphoto', 'shutterstock', 'corbis']

export function safeHost(url: unknown): string {
  try {
    return new URL(String(url)).hostname
  } catch {
    return ''
  }
}

/**
 * View untrusted JSON as a string-keyed record so properties can be probed
 * without `any`; non-object inputs read as an empty record.
 */
export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}
