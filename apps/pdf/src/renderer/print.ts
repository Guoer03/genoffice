import type { PDFDocumentProxy } from 'pdfjs-dist'

const PRINT_SCALE = 150 / 72

/**
 * Sequentially render pages as JPEG images into a print-only container (canvas discarded
 * immediately to avoid keeping full-doc hi-res bitmaps in memory), then hand off to the
 * system print dialog; clean up after it closes (including cancel).
 * Caller flushes unsaved changes and re-getDocument first — rotations/deleted pages are
 * already in the file.
 * @param pages 1-based file pages to render; defaults to the whole document.
 */
export async function printPdf(doc: PDFDocumentProxy, pages?: number[]): Promise<void> {
  const root = document.createElement('div')
  root.className = 'pdf-print-root'
  const canvas = document.createElement('canvas')
  const targets =
    pages && pages.length > 0
      ? [...new Set(pages)].filter((n) => n >= 1 && n <= doc.numPages).sort((a, b) => a - b)
      : Array.from({ length: doc.numPages }, (_x, i) => i + 1)
  for (const n of targets) {
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: PRINT_SCALE })
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    await page.render({ canvas, viewport }).promise
    const img = document.createElement('img')
    img.src = canvas.toDataURL('image/jpeg', 0.92)
    root.appendChild(img)
  }
  canvas.width = 0
  canvas.height = 0
  document.body.appendChild(root)
  try {
    await Promise.all([...root.querySelectorAll('img')].map((img) => img.decode()))
    await new Promise<void>((resolve) => {
      const done = () => {
        window.removeEventListener('afterprint', done)
        resolve()
      }
      window.addEventListener('afterprint', done)
      window.print()
    })
  } finally {
    root.remove()
  }
}
