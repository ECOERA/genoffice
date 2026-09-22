/**
 * Document parsing for the knowledge base on a worker thread (kb-worker.ts):
 * one request at a time, a deadline per file, and a fresh worker after a
 * timeout or crash. Pure Node so tests can pass an inline worker.
 */
import { Worker } from 'node:worker_threads'
import type { ParsedText } from './hosted/kb'

export interface WorkerParserOptions {
  /** creates the worker (the app: new Worker(join(__dirname, 'kb-worker.js'))) */
  makeWorker: () => Worker
  timeoutMs?: number
  log?: (message: string) => void
}

interface Reply {
  id: number
  ok: boolean
  text: string
  error?: string
}

export class WorkerParser {
  private worker: Worker | null = null
  private nextId = 1
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly opts: WorkerParserOptions) {}

  private spawn(): Worker {
    if (this.worker) return this.worker
    const w = this.opts.makeWorker()
    w.on('error', (err) => this.opts.log?.(`kb worker: ${String(err)}`))
    w.on('exit', () => {
      if (this.worker === w) this.worker = null
    })
    w.unref()
    this.worker = w
    return w
  }

  /** parse one file; resolves ok:false with an error message on timeout or crash, never rejects */
  parse(path: string): Promise<ParsedText> {
    const run = () => this.parseNow(path)
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  private parseNow(path: string): Promise<ParsedText> {
    return new Promise((resolve) => {
      const id = this.nextId++
      let worker: Worker
      try {
        worker = this.spawn()
      } catch (err) {
        resolve({ ok: false, text: '', error: `worker unavailable: ${String(err)}` })
        return
      }
      const timeout = this.opts.timeoutMs ?? 90_000
      const done = (r: ParsedText) => {
        clearTimeout(timer)
        worker.off('message', onMessage)
        worker.off('exit', onExit)
        resolve(r)
      }
      const onMessage = (m: Reply) => {
        if (m.id === id) done({ ok: m.ok, text: m.text, error: m.error })
      }
      const onExit = () => done({ ok: false, text: '', error: 'parser crashed' })
      const timer = setTimeout(() => {
        this.opts.log?.(
          `kb: parsing ${path} took more than ${Math.round(timeout / 1000)} s; skipped`,
        )
        void worker.terminate()
        this.worker = null
        done({
          ok: false,
          text: '',
          error: `parse timed out after ${Math.round(timeout / 1000)} s`,
        })
      }, timeout)
      worker.on('message', onMessage)
      worker.on('exit', onExit)
      worker.postMessage({ id, path })
    })
  }

  async close(): Promise<void> {
    const w = this.worker
    this.worker = null
    if (w) await w.terminate()
  }
}
