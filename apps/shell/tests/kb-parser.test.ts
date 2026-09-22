import { afterEach, describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { WorkerParser } from '../src/main/kb-parser'

/** The worker-thread parser: replies, a hang cut off by the deadline, a fresh worker afterwards. */

const GOOD = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (m) => {
  if (m.path.endsWith('hang')) return
  if (m.path.endsWith('crash')) process.exit(1)
  parentPort.postMessage({ id: m.id, ok: true, text: 'text of ' + m.path })
})`

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

describe('WorkerParser', () => {
  it('parses through the worker, times out a hang, and recovers', async () => {
    let spawned = 0
    const p = new WorkerParser({
      makeWorker: () => {
        spawned++
        return new Worker(GOOD, { eval: true })
      },
      timeoutMs: 300,
    })
    cleanup.push(() => p.close())
    expect(await p.parse('/a.docx')).toEqual({
      ok: true,
      text: 'text of /a.docx',
      error: undefined,
    })
    expect(await p.parse('/b.docx')).toEqual({
      ok: true,
      text: 'text of /b.docx',
      error: undefined,
    })
    expect(spawned).toBe(1)
    const hung = await p.parse('/slow.hang')
    expect(hung.ok).toBe(false)
    expect(hung.error).toContain('timed out')
    // the next file gets a new worker and works again
    expect((await p.parse('/c.docx')).text).toBe('text of /c.docx')
    expect(spawned).toBe(2)
    const crashed = await p.parse('/x.crash')
    expect(crashed).toMatchObject({ ok: false, error: 'parser crashed' })
    expect((await p.parse('/d.docx')).text).toBe('text of /d.docx')
    expect(spawned).toBe(3)
  })
})
