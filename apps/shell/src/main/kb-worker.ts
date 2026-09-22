/**
 * Worker thread for the knowledge base: parses one document per message
 * with @genoffice/file-parse, off the main thread, so a slow or pathological
 * file never freezes the app and can be cut off (kb-parser.ts terminates the
 * worker on timeout). Bundled as a second main-process entry by
 * electron.vite.config.ts.
 */
import { parentPort } from 'node:worker_threads'
import { parseFileToText } from '@genoffice/file-parse'

interface Request {
  id: number
  path: string
}

parentPort?.on('message', (msg: Request) => {
  void parseFileToText(msg.path)
    .then((r) =>
      parentPort?.postMessage({ id: msg.id, ok: r.ok, text: r.text ?? '', error: r.error }),
    )
    .catch((err: unknown) =>
      parentPort?.postMessage({
        id: msg.id,
        ok: false,
        text: '',
        error: err instanceof Error ? err.message : String(err),
      }),
    )
})
