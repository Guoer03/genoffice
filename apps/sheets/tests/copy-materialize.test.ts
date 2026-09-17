import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installCopyMaterialize } from '../src/renderer/copy-materialize'
import { ensureLazyRangeLoaded } from '../src/renderer/univer-sync'

vi.mock('../src/renderer/univer-sync', () => ({
  ensureLazyRangeLoaded: vi.fn().mockResolvedValue(true),
}))

const mockEnsure = vi.mocked(ensureLazyRangeLoaded)

function harness(opts: {
  fileRows: number
  fileCols: number
  ops: unknown[]
  selection: { row: number; column: number; height: number; width: number }
  loaded?: { startRow: number; endRow: number; startColumn: number; endColumn: number }
}) {
  const messages: string[] = []
  const clipboard = { copy: vi.fn().mockResolvedValue(true), cut: vi.fn() }
  const worksheet = { getSheetId: () => 's1' }
  const selection = {
    getRow: () => opts.selection.row,
    getColumn: () => opts.selection.column,
    getHeight: () => opts.selection.height,
    getWidth: () => opts.selection.width,
  }
  const workbook = {
    getActiveSheet: () => worksheet,
    getActiveRange: () => selection,
  }
  const runtime = {
    univerAPI: { getActiveWorkbook: () => workbook },
    univer: { __getInjector: () => ({ get: () => clipboard }) },
  }
  const state = {
    formulaMode: false,
    file: { sheets: [{ id: 's1', rowCount: opts.fileRows, columnCount: opts.fileCols }] },
    editJournal: { structuralOps: new Map([['s1', opts.ops]]) },
    loadedRanges: new Map(opts.loaded ? [['s1', opts.loaded]] : []),
  }
  return {
    messages,
    clipboard,
    installer: () =>
      installCopyMaterialize(runtime as never, { current: state } as never, (message: string) =>
        messages.push(message),
      ),
  }
}

describe('copy materialize screen extent', () => {
  beforeEach(() => {
    mockEnsure.mockClear()
  })

  it('clamps to the screen extent after row inserts, not the file extent', async () => {
    // file 10 rows + 5 inserted at top = 15 screen rows; selecting screen
    // rows 10-14 must load through row 14 (file clamping would invert to 10..9)
    const h = harness({
      fileRows: 10,
      fileCols: 8,
      ops: [{ kind: 'insert-rows', index: 0, count: 5 }],
      selection: { row: 10, column: 0, height: 5, width: 2 },
    })
    const { dispose } = h.installer()
    await h.clipboard.copy()
    expect(mockEnsure).toHaveBeenCalledTimes(1)
    const range = mockEnsure.mock.calls[0]![3] as {
      startRow: number
      endRow: number
      startColumn: number
      endColumn: number
    }
    expect(range).toMatchObject({ startRow: 10, endRow: 14, startColumn: 0, endColumn: 1 })
    dispose()
  })

  it('does nothing for selections wholly past the extent after deletes', async () => {
    // file 10 rows - 5 deleted = 5 screen rows; a stale anchor at row 20
    // inverts the range and must not reach the loader
    const h = harness({
      fileRows: 10,
      fileCols: 8,
      ops: [{ kind: 'remove-rows', index: 0, count: 5 }],
      selection: { row: 20, column: 0, height: 5, width: 2 },
    })
    const { dispose } = h.installer()
    await h.clipboard.copy()
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(h.messages).toHaveLength(0)
    dispose()
  })

  it('keeps file-extent clamping when no structural ops exist', async () => {
    const h = harness({
      fileRows: 10,
      fileCols: 8,
      ops: [],
      selection: { row: 8, column: 0, height: 5, width: 2 },
    })
    const { dispose } = h.installer()
    await h.clipboard.copy()
    expect(mockEnsure).toHaveBeenCalledTimes(1)
    const range = mockEnsure.mock.calls[0]![3] as { startRow: number; endRow: number }
    expect(range).toMatchObject({ startRow: 8, endRow: 9 })
    dispose()
  })
})
