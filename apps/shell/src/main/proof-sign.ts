/**
 * Wallet signing round-trip.
 *
 * MetaMask is a browser extension; an Electron renderer has no `window.ethereum`
 * and cannot reach the user's extension. So signing happens where the wallet
 * actually lives: a one-shot page served from 127.0.0.1 is opened in the
 * default browser, it asks the extension to sign, and posts the result back to
 * the same loopback server. Same shape as the Google OAuth loopback already in
 * google-drive-api.ts — no third-party relay, no WalletConnect project id, and
 * nothing leaves the machine.
 *
 * The server lives only for the duration of one signature: it binds to a random
 * port on 127.0.0.1, every request must carry a per-run token, and it closes on
 * success, cancel, timeout or abort.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { typedDataJson, type ProofMessage } from '@genoffice/doc-proof'

/**
 * Placeholder signer in the payload handed to the browser. The app cannot know
 * which account the user will pick until the wallet connects, so the page fills
 * this in with the connected address and the app rebuilds the message around
 * whatever came back. That is safe because `signer` is inside the signed struct:
 * if the page lied about the address, recovery produces a different one and
 * verification fails.
 */
const UNKNOWN_SIGNER = '0x0000000000000000000000000000000000000000' as const

export class ProofSignError extends Error {}

export interface SignRequestOptions {
  /** opens the URL in the user's default browser (shell.openExternal) */
  readonly openExternal: (url: string) => Promise<void>
  /** how the page is labelled; shown to the user in the browser tab */
  readonly documentName: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface SignResult {
  readonly address: `0x${string}`
  readonly signature: `0x${string}`
}

/** constant-time token compare; both sides are hex of the same length */
function tokenMatches(expected: string, given: string | null): boolean {
  if (given === null || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given))
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/

/**
 * Serve the signing page, wait for the browser to post a signature back.
 *
 * Resolves with the address the wallet signed as; the caller still verifies
 * that the signature recovers to it rather than trusting the page.
 */
export function requestWalletSignature(
  message: Omit<ProofMessage, 'signer'>,
  opts: SignRequestOptions,
): Promise<SignResult> {
  const token = randomBytes(24).toString('hex')
  const payload = typedDataJson({ ...message, signer: UNKNOWN_SIGNER })

  return new Promise<SignResult>((resolve, reject) => {
    let server: Server | null = null
    let settled = false

    const timer = setTimeout(
      () => finish(new ProofSignError('Signing timed out — the browser never came back.')),
      opts.timeoutMs ?? 5 * 60_000,
    )
    const onAbort = () => finish(new ProofSignError('Signing cancelled.'))
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    function finish(err: Error | null, result?: SignResult) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      server?.close()
      if (err) reject(err)
      else resolve(result!)
    }

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!tokenMatches(token, url.searchParams.get('t'))) {
        res.writeHead(403).end('forbidden')
        return
      }

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          // the page holds the document hash; never let it be cached or framed
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
        })
        res.end(signPage(payload, token, opts.documentName))
        return
      }

      if (req.method === 'POST' && url.pathname === '/result') {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += chunk
          // the payload is one small JSON object; anything larger is not ours
          if (body.length > 4096) req.destroy()
        })
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
          try {
            const parsed: unknown = JSON.parse(body)
            const data = parsed as { address?: unknown; signature?: unknown; error?: unknown }
            if (typeof data.error === 'string' && data.error) {
              finish(new ProofSignError(data.error))
              return
            }
            const address = String(data.address ?? '')
            const signature = String(data.signature ?? '')
            if (!ADDRESS_RE.test(address) || !SIGNATURE_RE.test(signature)) {
              finish(new ProofSignError('The browser returned an unusable signature.'))
              return
            }
            finish(null, {
              address: address as `0x${string}`,
              signature: signature as `0x${string}`,
            })
          } catch {
            finish(new ProofSignError('The browser returned an unreadable response.'))
          }
        })
        return
      }

      res.writeHead(404).end('not found')
    })

    server.on('error', (err) =>
      finish(new ProofSignError(`Could not start signing: ${err.message}`)),
    )
    // 127.0.0.1 only: never reachable from the network
    server.listen(0, '127.0.0.1', () => {
      const port = (server!.address() as AddressInfo).port
      void opts
        .openExternal(`http://127.0.0.1:${port}/?t=${token}`)
        .catch((err: unknown) =>
          finish(new ProofSignError(`Could not open the browser: ${String(err)}`)),
        )
    })
  })
}

/**
 * The one-shot signing page.
 *
 * Deliberately a single self-contained document with no external resources: it
 * runs on loopback with a document hash in it, so it must not fetch anything.
 * The typed data is injected as JSON and handed to the wallet untouched — the
 * page never reconstructs it, so what the user sees in MetaMask is exactly what
 * the app asked for.
 */
function signPage(typedData: string, token: string, documentName: string): string {
  const esc = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    )
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'">
<title>Sign ${esc(documentName)} — DuneOffice</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.55 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  .card { width: min(440px, calc(100vw - 48px)); padding: 28px; text-align: center;
          border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 14px; }
  h1 { margin: 0 0 6px; font-size: 18px; }
  .doc { font-weight: 600; }
  .hash { margin: 14px 0 0; font: 12px ui-monospace, monospace; word-break: break-all;
          opacity: .65; }
  button { margin-top: 20px; padding: 10px 20px; font: inherit; font-weight: 600;
           border: 0; border-radius: 9px; background: #e8663f; color: #fff; cursor: pointer; }
  button[disabled] { opacity: .5; cursor: default; }
  .msg { margin-top: 16px; min-height: 1.5em; }
  .err { color: #d13438; }
  .ok { color: #107c41; }
</style></head>
<body><div class="card">
  <h1>Sign with your wallet</h1>
  <p>DuneOffice is asking you to sign <span class="doc">${esc(documentName)}</span>.</p>
  <p class="hash" id="hash"></p>
  <button id="go">Sign</button>
  <p class="msg" id="msg"></p>
</div>
<script>
const TYPED = ${typedData};
const TOKEN = ${JSON.stringify(token)};
const msg = document.getElementById('msg');
const go = document.getElementById('go');
document.getElementById('hash').textContent = TYPED.message.contentHash;

function say(text, cls) { msg.textContent = text; msg.className = 'msg ' + (cls || ''); }
async function report(body) {
  try {
    await fetch('/result?t=' + encodeURIComponent(TOKEN), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { /* the app may already have given up; nothing useful to do here */ }
}

if (!window.ethereum) {
  say('No wallet found. Install MetaMask in this browser, then try again.', 'err');
  go.disabled = true;
}

go.addEventListener('click', async () => {
  go.disabled = true;
  say('Check your wallet…');
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const from = accounts && accounts[0];
    if (!from) throw new Error('No account was selected.');
    // the app sent a placeholder signer because it cannot know the account in
    // advance; stamp in the one the user actually picked. The app rebuilds the
    // message around this address and verifies by recovery, so a wrong value
    // here fails verification rather than forging a proof.
    TYPED.message.signer = from;
    const signature = await window.ethereum.request({
      method: 'eth_signTypedData_v4', params: [from, JSON.stringify(TYPED)],
    });
    say('Signed. You can close this tab.', 'ok');
    await report({ address: from, signature });
  } catch (err) {
    const text = (err && (err.message || err.code)) || 'Signing failed.';
    say(String(text), 'err');
    go.disabled = false;
    await report({ error: String(text) });
  }
});
</script></body></html>`
}
