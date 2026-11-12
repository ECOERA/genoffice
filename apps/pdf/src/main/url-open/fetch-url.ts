/**
 * "Open from URL": download a PDF, or turn a webpage into a PDF with
 * selectable text. Both run in a throwaway in-memory session behind the
 * pinned-address guard (network-guard.ts).
 *
 * Ported from Folio's electron/main.cjs (downloadPdf) and electron/webpage.cjs
 * (https://github.com/Forward-Future/folio, MIT, © Matthew Berman / Forward
 * Future) — see NOTICE.
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, app, net, session } from 'electron'
import { guardSession, type Destination } from './network-guard'

export const MAX_URL_PDF_BYTES = 300 * 1024 * 1024
const SILENCE_TIMEOUT_MS = 60_000
const WEBPAGE_TIMEOUT_MS = 60_000
const SCROLL_TIMEOUT_MS = 15_000
// Pages are laid out like a desktop browser window: 1280 CSS px wide, no margins.
const PAGE_WIDTH_PX = 1280
const PAGE_HEIGHT_PX = 1664
const CSS_PX_PER_INCH = 96

/** Machine-readable failure; the renderer turns it into a message in the UI language */
export type FetchFailure =
  | 'local-refused'
  | 'unreachable'
  | 'http-status'
  | 'redirects'
  | 'too-large'
  | 'not-pdf'
  | 'timeout'
  | 'interrupted'
  | 'webpage-failed'

export type FetchResult =
  | { name: string; data: Buffer }
  | { webpage: string }
  | { failure: FetchFailure; detail?: string }
  | { cancelled: true }

// Windows can't create files named after devices — "CON.pdf" included.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** `name` with everything a file system refuses taken out, ending in .pdf; `fallback` when nothing is left. */
export function safePdfName(name: string | null | undefined, fallback: string): string {
  const clean =
    String(name || '')
      // eslint-disable-next-line no-control-regex -- control chars are illegal in file names
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || fallback
  const stem = clean.replace(/\.pdf$/i, '')
  const safe = WINDOWS_DEVICE_NAME.test(stem) ? `${stem}_` : clean
  return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`
}

/** The name a download gets: from Content-Disposition when the server sends one, else the URL's last segment. */
export function pdfNameFromResponse(url: URL, disposition: string | undefined): string {
  const match = /filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i.exec(disposition || '')
  let name = (match?.[1] || match?.[2] || '').trim()
  try {
    name = decodeURIComponent(name || url.pathname.split('/').filter(Boolean).pop() || '')
  } catch {
    /* keep the raw name */
  }
  return safePdfName(name, url.hostname)
}

/** Whether the first bytes look like a PDF, an HTML page, or neither. */
export function sniff(head: Buffer): 'pdf' | 'html' | 'other' {
  if (head.subarray(0, 1024).indexOf('%PDF-') >= 0) return 'pdf'
  if (/^\s*(<!doctype html|<html|<head|<body)/i.test(head.subarray(0, 512).toString('latin1'))) {
    return 'html'
  }
  return 'other'
}

/**
 * Download `url`. Resolves to the PDF, to `{ webpage }` when the address serves
 * HTML (the caller captures it instead), or to a failure.
 */
export async function downloadPdf(
  startUrl: URL,
  approvedLocal: Destination | null,
  signal: AbortSignal,
): Promise<FetchResult> {
  const ses = session.fromPartition(`pdf-download-${randomUUID()}`) // in-memory only
  const guard = await guardSession(ses, session.defaultSession, approvedLocal, app)
  if (signal.aborted) {
    guard.close()
    return { cancelled: true }
  }
  let url = startUrl
  return new Promise<FetchResult>((resolve) => {
    let done = false
    const request = net.request({
      url: url.toString(),
      redirect: 'manual',
      session: ses,
      cache: 'no-store',
    })
    let timer: NodeJS.Timeout | undefined
    const finish = (result: FetchResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (!('data' in result)) request.abort()
      resolve(result)
    }
    // The minute is for a silent connection, not the whole file: a large PDF on a slow
    // connection keeps going for as long as data arrives.
    const alive = () => {
      clearTimeout(timer)
      if (!done) timer = setTimeout(() => finish({ failure: 'timeout' }), SILENCE_TIMEOUT_MS)
    }
    alive()
    signal.addEventListener('abort', () => finish({ cancelled: true }), { once: true })
    let hops = 0
    request.setHeader('Accept', 'application/pdf,*/*;q=0.8')
    // Track redirects ourselves: the final address usually carries the real file name.
    request.on('redirect', (_status, _method, redirectUrl) => {
      alive()
      const next = new URL(redirectUrl, url)
      if (++hops > 10 || (next.protocol !== 'http:' && next.protocol !== 'https:')) {
        finish({ failure: 'redirects' })
        return
      }
      url = next
      request.followRedirect()
    })
    request.on('error', () =>
      finish({
        failure: guard.refusedLocal() ? 'local-refused' : 'unreachable',
        detail: url.hostname,
      }),
    )
    request.on('response', (response) => {
      alive()
      if (response.statusCode < 200 || response.statusCode >= 300) {
        finish({ failure: 'http-status', detail: String(response.statusCode) })
        return
      }
      const header = (key: string) => ([] as string[]).concat(response.headers[key] ?? [])[0]
      // A webpage: stop downloading and let the caller render it to PDF instead.
      if (/\b(text\/html|application\/xhtml\+xml)\b/i.test(header('content-type') ?? '')) {
        finish({ webpage: url.toString() })
        return
      }
      if (Number(header('content-length')) > MAX_URL_PDF_BYTES) {
        finish({ failure: 'too-large' })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let verified = false
      const check = (head: Buffer): boolean => {
        const kind = sniff(head)
        if (kind === 'pdf') return true
        // Some servers don't label HTML; recognize it by its start.
        finish(kind === 'html' ? { webpage: url.toString() } : { failure: 'not-pdf' })
        return false
      }
      response.on('data', (chunk: Buffer) => {
        alive()
        if (done) return
        size += chunk.byteLength
        if (size > MAX_URL_PDF_BYTES) {
          finish({ failure: 'too-large' })
          return
        }
        chunks.push(chunk)
        if (!verified && size >= 1024) {
          verified = true
          check(Buffer.concat(chunks))
        }
      })
      response.on('error', () => finish({ failure: 'interrupted' }))
      response.on('end', () => {
        if (done) return
        const data = Buffer.concat(chunks)
        if (!verified && !check(data)) return
        finish({ name: pdfNameFromResponse(url, header('content-disposition')), data })
      })
    })
    request.end()
  }).finally(() => guard.close())
}

// Print exactly what the screen shows: every background, color, and translucent layer.
// (User-origin !important rules beat the site's own, including print-only overrides.)
const FIDELITY_CSS = `
*, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
@page { margin: 0 !important; }
`

// Scrolls through the page so lazy-loaded images load, then back to the top; finishes
// animations, drops decorative blend layers and pins fixed bars once (they would
// otherwise repeat on every printed page).
const PREPARE_PAGE = `(async () => {
  const pause = () => new Promise((r) => setTimeout(r, 120));
  document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = "eager"; });
  for (let y = 0; y < document.documentElement.scrollHeight && y < 60000; y += Math.max(400, innerHeight * 0.8)) {
    scrollTo(0, y);
    await pause();
  }
  scrollTo(0, 0);
  await pause();
  for (const animation of document.getAnimations()) {
    try {
      const timing = animation.effect?.getComputedTiming?.();
      if (timing && Number.isFinite(timing.endTime)) animation.finish();
      else animation.pause();
    } catch {}
  }
  for (const el of document.querySelectorAll("body *")) {
    if (getComputedStyle(el).mixBlendMode === "normal") continue;
    if (el.textContent.trim() || el.querySelector("img, svg, video, canvas, picture") || /^(IMG|SVG|VIDEO|CANVAS|PICTURE)$/i.test(el.tagName)) continue;
    el.style.setProperty("visibility", "hidden", "important");
  }
  for (const el of document.querySelectorAll("body *")) {
    const position = getComputedStyle(el).position;
    if (position === "fixed") el.style.setProperty("position", "absolute", "important");
    else if (position === "sticky") el.style.setProperty("position", "relative", "important");
  }
  return true;
})()`

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Load `url` in a hidden, locked-down window (own throwaway session, sandboxed,
 * no Node, no permissions, pop-ups or downloads) and print it with its screen
 * styles.
 */
export async function captureWebpage(
  rawUrl: string,
  approvedLocal: Destination | null,
  signal: AbortSignal,
): Promise<FetchResult> {
  if (signal.aborted) return { cancelled: true }
  const url = new URL(rawUrl)
  const ses = session.fromPartition(`pdf-webpage-${randomUUID()}`) // in-memory only
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
  const guard = await guardSession(ses, session.defaultSession, approvedLocal, app)
  let win: BrowserWindow | undefined
  const cancelled = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
  )
  cancelled.catch(() => {}) // only matters while it is being raced
  try {
    win = new BrowserWindow({
      show: false,
      width: PAGE_WIDTH_PX,
      height: PAGE_HEIGHT_PX,
      useContentSize: true,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        disableDialogs: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    })
    const contents = win.webContents
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.setAudioMuted(true)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Lay the page out with its screen styles, not its print stylesheet. (Emulation
    // needs a loaded document first: setting it on a fresh window can crash Electron.)
    try {
      await contents.loadURL('about:blank')
      contents.debugger.attach('1.3')
      await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'screen' })
    } catch {
      /* falls back to print styles */
    }
    if (signal.aborted) return { cancelled: true }
    return await Promise.race([
      cancelled,
      withTimeout(
        (async (): Promise<FetchResult> => {
          try {
            await contents.loadURL(url.toString())
          } catch (error) {
            // Pages that keep redirecting or abort a subresource can reject even though they loaded.
            if (!contents.getURL() || contents.getURL() === 'about:blank') throw error
          }
          await contents.insertCSS(FIDELITY_CSS, { cssOrigin: 'user' }).catch(() => {})
          await delay(800)
          await withTimeout(
            contents.executeJavaScript(PREPARE_PAGE, false),
            SCROLL_TIMEOUT_MS,
          ).catch(() => {})
          await delay(600)
          const data = await contents.printToPDF({
            printBackground: true,
            pageSize: {
              width: PAGE_WIDTH_PX / CSS_PX_PER_INCH,
              height: PAGE_HEIGHT_PX / CSS_PX_PER_INCH,
            },
            margins: { marginType: 'none' },
            preferCSSPageSize: false,
            generateDocumentOutline: true,
            generateTaggedPDF: true,
          })
          if (data.length > MAX_URL_PDF_BYTES) return { failure: 'too-large' }
          const finalUrl = new URL(contents.getURL() || url.toString())
          return { name: safePdfName(contents.getTitle(), finalUrl.hostname), data }
        })(),
        WEBPAGE_TIMEOUT_MS,
      ),
    ])
  } catch (error) {
    if (signal.aborted) return { cancelled: true }
    if (error instanceof Error && error.message === 'timeout') return { failure: 'timeout' }
    return {
      failure: guard.refusedLocal() ? 'local-refused' : 'webpage-failed',
      detail: url.hostname,
    }
  } finally {
    win?.destroy()
    guard.close()
    void ses.clearStorageData().catch(() => {})
  }
}
