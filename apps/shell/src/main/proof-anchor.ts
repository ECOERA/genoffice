/**
 * Publishing a proof on-chain.
 *
 * The same loopback round-trip as signing, and for the same reason: the wallet
 * lives in the browser. The difference is that this one spends money, so the
 * division of labour is stricter — the app prepares every byte of calldata
 * here, where it is typed and tested, and the page is reduced to "ask the
 * wallet to send this to that address". A page that cannot build a transaction
 * cannot build a different one than the user agreed to.
 *
 * Nothing the page reports is trusted. It comes back with a transaction hash;
 * the app then reads the chain itself, decodes the attestation, and checks it
 * describes this exact proof before anything is written to disk.
 *
 * The page never waits for a transaction either. Asking the wallet whether
 * something confirmed answers for whichever network the wallet happens to have
 * selected, which is not necessarily the one we just sent to — a first version
 * polled MetaMask and hung after a transaction that had in fact succeeded. So
 * the page posts each hash the moment it has one and blocks on our reply; the
 * app watches the chain it chose, over its own RPC, and tells the page when to
 * carry on.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { createPublicClient, http, parseEventLogs, type Hex } from 'viem'
import {
  anchorMatches,
  attestCalldata,
  decodeProofData,
  EAS_ABI,
  proofSchemaUid,
  registerSchemaCalldata,
  SCHEMA_REGISTRY_ABI,
  type AnchorRecord,
  type EasChain,
  type ProofRecord,
} from '@genoffice/doc-proof'

export class ProofAnchorError extends Error {}

const ATTESTED_EVENT = EAS_ABI.find(
  (entry): entry is Extract<(typeof EAS_ABI)[number], { type: 'event' }> =>
    entry.type === 'event' && entry.name === 'Attested',
)!

/** one transaction the page is asked to send, in order */
interface AnchorStep {
  readonly to: string
  readonly data: string
  /** shown in the page while the wallet is open */
  readonly label: string
}

export interface AnchorOptions {
  readonly openExternal: (url: string) => Promise<void>
  readonly documentName: string
  readonly chain: EasChain
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

const TX_RE = /^0x[0-9a-fA-F]{64}$/

function tokenMatches(expected: string, given: string | null): boolean {
  if (given === null || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given))
}

function clientFor(chain: EasChain) {
  return createPublicClient({ transport: http(chain.rpcUrl) })
}

/** wait for one transaction on the chain we actually sent to */
async function waitForSuccess(chain: EasChain, hash: Hex) {
  const receipt = await clientFor(chain)
    .waitForTransactionReceipt({ hash, timeout: 180_000 })
    .catch((err: Error) => {
      throw new ProofAnchorError(`The transaction never confirmed: ${err.message}`)
    })
  if (receipt.status !== 'success') {
    throw new ProofAnchorError('The transaction was reverted by the chain.')
  }
  return receipt
}

/**
 * Is our schema registered on this chain yet?
 *
 * The UID is derived from the schema text, so it is known before anyone has
 * registered anything: an unregistered schema reads back as the zero UID.
 * Whoever anchors first on a given chain pays to register it, once, for
 * everybody.
 */
export async function schemaIsRegistered(chain: EasChain): Promise<boolean> {
  const uid = proofSchemaUid()
  try {
    const record = await clientFor(chain).readContract({
      address: chain.schemaRegistry,
      abi: SCHEMA_REGISTRY_ABI,
      functionName: 'getSchema',
      args: [uid],
    })
    return record.uid.toLowerCase() === uid.toLowerCase()
  } catch (err) {
    throw new ProofAnchorError(`Could not reach ${chain.name}: ${(err as Error).message}`)
  }
}

/**
 * Has this proof already been published, whether or not we recorded it?
 *
 * Publishing costs money, and a flow that is interrupted between "the wallet
 * sent it" and "we wrote it down" would otherwise charge the user twice for the
 * same attestation — which is exactly what happened the first time this feature
 * met a real wallet. So a publish starts by looking for its own result.
 *
 * The EAS index is used to find candidates because it can answer "every
 * attestation for this signer under this schema" in one request; the chain is
 * then asked about each candidate, and only the chain's answer is believed. If
 * the index is unreachable, a bounded scan of recent blocks covers the case
 * this is really for: a publish that happened moments ago.
 */
export async function findExistingAnchor(
  record: ProofRecord,
  chain: EasChain,
): Promise<AnchorRecord | null> {
  const uids = await candidateUids(record, chain)
  const client = clientFor(chain)
  for (const uid of uids) {
    const attestation = await client
      .readContract({
        address: chain.eas,
        abi: EAS_ABI,
        functionName: 'getAttestation',
        args: [uid],
      })
      .catch(() => null)
    if (!attestation || attestation.revocationTime !== 0n) continue
    if (attestation.schema.toLowerCase() !== proofSchemaUid().toLowerCase()) continue
    const decoded = decodeProofData(attestation.data)
    if (!decoded || !anchorMatches(record, decoded)) continue
    return {
      chainId: chain.chainId,
      uid: attestation.uid,
      // the index knows the transaction; the chain does not store it, and it is
      // a convenience for the user rather than part of the proof
      txHash: (await txHashFor(chain, attestation.uid)) ?? attestation.uid,
      attester: attestation.attester,
      anchoredAt: new Date(Number(attestation.time) * 1000).toISOString(),
    }
  }
  return null
}

/** ask EAS's index which attestations this signer has under our schema */
async function candidateUids(record: ProofRecord, chain: EasChain): Promise<Hex[]> {
  const query = {
    query:
      'query($schema: String!, $recipient: String!) { attestations(where: { schemaId: { equals: $schema }, recipient: { equals: $recipient } }, orderBy: { time: desc }, take: 25) { id } }',
    variables: { schema: proofSchemaUid(), recipient: record.signer },
  }
  try {
    const res = await fetch(chain.graphql, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json()) as { data?: { attestations?: { id?: unknown }[] } }
    const ids = (body.data?.attestations ?? [])
      .map((a) => String(a.id ?? ''))
      .filter((id): id is Hex => /^0x[0-9a-fA-F]{64}$/.test(id))
    if (ids.length > 0) return ids
  } catch {
    // the index is a convenience; fall through to the chain
  }
  return scanRecentUids(record, chain)
}

/** the fallback: our own Attested logs over the last few thousand blocks */
async function scanRecentUids(record: ProofRecord, chain: EasChain): Promise<Hex[]> {
  const client = clientFor(chain)
  const uids: Hex[] = []
  try {
    const head = await client.getBlockNumber()
    // public RPCs cap getLogs at 2000 blocks, so walk a few windows back
    for (let i = 0; i < 3; i++) {
      const to = head - BigInt(i * 2000)
      const from = to > 1999n ? to - 1999n : 0n
      const logs = await client.getLogs({
        address: chain.eas,
        event: ATTESTED_EVENT,
        args: { schemaUID: proofSchemaUid(), recipient: record.signer },
        fromBlock: from,
        toBlock: to,
      })
      for (const log of logs) if (log.args.uid) uids.push(log.args.uid)
    }
  } catch {
    // no index and no logs: treat it as "not published", and the worst case is
    // the user is asked to publish something that is already out there
  }
  return uids
}

/** the transaction an attestation came in, from the index; null if unknown */
async function txHashFor(chain: EasChain, uid: Hex): Promise<Hex | null> {
  try {
    const res = await fetch(chain.graphql, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query($id: String!) { attestation(where: { id: $id }) { txid } }',
        variables: { id: uid },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json()) as { data?: { attestation?: { txid?: unknown } } }
    const txid = String(body.data?.attestation?.txid ?? '')
    return /^0x[0-9a-fA-F]{64}$/.test(txid) ? (txid as Hex) : null
  } catch {
    return null
  }
}

/**
 * Publish a proof and return where it landed.
 *
 * The record must already verify — this only republishes what was signed, and
 * the signature travels into the attestation so the chain copy stands alone.
 */
export async function anchorProof(record: ProofRecord, opts: AnchorOptions): Promise<AnchorRecord> {
  const { chain } = opts

  // never pay twice for the same attestation
  const already = await findExistingAnchor(record, chain)
  if (already) return already

  const steps: AnchorStep[] = []

  if (!(await schemaIsRegistered(chain))) {
    steps.push({
      to: chain.schemaRegistry,
      data: registerSchemaCalldata(),
      label: `Register the proof schema on ${chain.name} (one-off, for everyone)`,
    })
  }
  steps.push({
    to: chain.eas,
    data: attestCalldata(record),
    label: `Publish the proof for ${opts.documentName}`,
  })

  const { txHash } = await runInBrowser(steps, opts)
  return confirmAnchor(record, chain, txHash)
}

/**
 * Read back what actually landed on the chain.
 *
 * Everything here is a check the page could have lied about: that the
 * transaction succeeded, that it emitted an attestation under our schema, and
 * that the attested bytes are this proof rather than some other one.
 */
async function confirmAnchor(
  record: ProofRecord,
  chain: EasChain,
  txHash: Hex,
): Promise<AnchorRecord> {
  const client = clientFor(chain)
  const receipt = await waitForSuccess(chain, txHash)

  const schemaUid = proofSchemaUid()
  const attested = parseEventLogs({ abi: EAS_ABI, eventName: 'Attested', logs: receipt.logs }).find(
    (log) => log.args.schemaUID.toLowerCase() === schemaUid.toLowerCase(),
  )
  if (!attested) {
    throw new ProofAnchorError('That transaction did not publish a document proof.')
  }
  const uid = attested.args.uid

  const attestation = await client.readContract({
    address: chain.eas,
    abi: EAS_ABI,
    functionName: 'getAttestation',
    args: [uid],
  })
  const decoded = decodeProofData(attestation.data)
  if (!decoded || !anchorMatches(record, decoded)) {
    throw new ProofAnchorError('What was published does not match this document’s proof.')
  }

  return {
    chainId: chain.chainId,
    uid,
    // the attester is read off the attestation, not taken from what the page
    // reported: the wallet may route through another account, and the chain is
    // the only thing that settles who actually paid
    attester: attestation.attester,
    txHash,
    // the block's time, not the signer's claim — the whole point of anchoring
    anchoredAt: new Date(Number(attestation.time) * 1000).toISOString(),
  }
}

/** serve the one-shot page, wait for the browser to report a transaction */
function runInBrowser(steps: readonly AnchorStep[], opts: AnchorOptions): Promise<{ txHash: Hex }> {
  const token = randomBytes(24).toString('hex')

  return new Promise((resolve, reject) => {
    let server: Server | null = null
    let settled = false

    const timer = setTimeout(
      () => finish(new ProofAnchorError('Publishing timed out — the browser never came back.')),
      opts.timeoutMs ?? 10 * 60_000,
    )
    const onAbort = () => finish(new ProofAnchorError('Publishing cancelled.'))
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    function finish(err: Error | null, result?: { txHash: Hex }) {
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
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
        })
        res.end(anchorPage(steps, token, opts))
        return
      }

      // the page reports each hash as soon as the wallet returns it, and waits
      // here while we watch the chain; the reply is the page's go-ahead
      if (req.method === 'POST' && url.pathname === '/sent') {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += chunk
          if (body.length > 4096) req.destroy()
        })
        req.on('end', () => {
          void (async () => {
            let hash: Hex
            let index: number
            try {
              const data = JSON.parse(body) as { txHash?: unknown; index?: unknown }
              const txHash = String(data.txHash ?? '')
              if (!TX_RE.test(txHash)) throw new Error('bad hash')
              hash = txHash as Hex
              index = typeof data.index === 'number' ? data.index : -1
            } catch {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'Unusable transaction hash.' }))
              return
            }

            try {
              await waitForSuccess(opts.chain, hash)
            } catch (err) {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: (err as Error).message }))
              finish(err as Error)
              return
            }

            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
            // the last step is the attestation: that is the one we return
            if (index === steps.length - 1) finish(null, { txHash: hash })
          })()
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/result') {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += chunk
          if (body.length > 4096) req.destroy()
        })
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
          try {
            const data = JSON.parse(body) as { error?: unknown }
            // success comes back through /sent, which is the path that waited
            // for the chain; this one only ever carries a failure
            finish(
              new ProofAnchorError(
                typeof data.error === 'string' && data.error ? data.error : 'Publishing failed.',
              ),
            )
          } catch {
            finish(new ProofAnchorError('The browser returned an unreadable response.'))
          }
        })
        return
      }

      res.writeHead(404).end('not found')
    })

    server.on('error', (err) =>
      finish(new ProofAnchorError(`Could not start publishing: ${err.message}`)),
    )
    server.listen(0, '127.0.0.1', () => {
      const port = (server!.address() as AddressInfo).port
      void opts
        .openExternal(`http://127.0.0.1:${port}/?t=${token}`)
        .catch((err: unknown) =>
          finish(new ProofAnchorError(`Could not open the browser: ${String(err)}`)),
        )
    })
  })
}

/**
 * The one-shot publishing page.
 *
 * It builds no calldata of its own: the steps arrive fully encoded and it
 * forwards them. It switches the wallet to the right chain first, because a
 * transaction sent to the EAS predeploy address on the wrong chain would go
 * somewhere else entirely.
 */
function anchorPage(steps: readonly AnchorStep[], token: string, opts: AnchorOptions): string {
  const { chain } = opts
  const esc = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    )
  const chainParams = {
    chainIdHex: `0x${chain.chainId.toString(16)}`,
    chainName: chain.name,
    rpcUrls: [chain.rpcUrl],
    nativeCurrency: { name: chain.currencySymbol, symbol: chain.currencySymbol, decimals: 18 },
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'">
<title>Publish ${esc(opts.documentName)} — DuneOffice</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.55 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  .card { width: min(480px, calc(100vw - 48px)); padding: 28px; text-align: center;
          border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 14px; }
  h1 { margin: 0 0 6px; font-size: 18px; }
  .doc { font-weight: 600; }
  ol { text-align: left; margin: 18px 0 0; padding-left: 22px; }
  li { margin: 4px 0; opacity: .75; }
  li.now { opacity: 1; font-weight: 600; }
  li.done { opacity: .45; text-decoration: line-through; }
  .note { margin-top: 16px; font-size: 13px; opacity: .7; }
  button { margin-top: 20px; padding: 10px 20px; font: inherit; font-weight: 600;
           border: 0; border-radius: 9px; background: #e8663f; color: #fff; cursor: pointer; }
  button[disabled] { opacity: .5; cursor: default; }
  .msg { margin-top: 16px; min-height: 1.5em; }
  .err { color: #d13438; }
  .ok { color: #107c41; }
</style></head>
<body><div class="card">
  <h1>Publish this proof on ${esc(chain.name)}</h1>
  <p>DuneOffice wants to publish the proof for <span class="doc">${esc(opts.documentName)}</span>.</p>
  <ol id="steps"></ol>
  <p class="note">This costs a network fee and is permanent: the content hash and
     the signer's address become public. The document itself is never uploaded.</p>
  <button id="go">Publish</button>
  <p class="msg" id="msg"></p>
</div>
<script>
const STEPS = ${JSON.stringify(steps)};
const CHAIN = ${JSON.stringify(chainParams)};
const TOKEN = ${JSON.stringify(token)};
const msg = document.getElementById('msg');
const go = document.getElementById('go');
const list = document.getElementById('steps');
STEPS.forEach((s) => { const li = document.createElement('li'); li.textContent = s.label; list.appendChild(li) });

function say(text, cls) { msg.textContent = text; msg.className = 'msg ' + (cls || ''); }
function mark(i, cls) { if (list.children[i]) list.children[i].className = cls }
async function report(body) {
  try {
    await fetch('/result?t=' + encodeURIComponent(TOKEN), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { /* the app may already have given up */ }
}

if (!window.ethereum) {
  say('No wallet found. Install MetaMask in this browser, then try again.', 'err');
  go.disabled = true;
}

async function ensureChain() {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainIdHex }],
    });
  } catch (err) {
    // 4902: the wallet does not know this chain yet — offer to add it
    if (err && (err.code === 4902 || err.code === -32603)) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN.chainIdHex, chainName: CHAIN.chainName,
          rpcUrls: CHAIN.rpcUrls, nativeCurrency: CHAIN.nativeCurrency,
        }],
      });
    } else { throw err }
  }
}

// The app watches the chain, not the wallet: ask MetaMask whether something
// confirmed and it answers for whatever network it currently has selected.
// This resolves when DuneOffice has seen the transaction succeed.
async function confirmed(index, hash) {
  const res = await fetch('/sent?t=' + encodeURIComponent(TOKEN), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ index: index, txHash: hash }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'The transaction did not confirm.');
}

go.addEventListener('click', async () => {
  go.disabled = true;
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const from = accounts && accounts[0];
    if (!from) throw new Error('No account was selected.');
    say('Switching to ' + CHAIN.chainName + '…');
    await ensureChain();

    let last = null;
    for (let i = 0; i < STEPS.length; i++) {
      mark(i, 'now');
      say('Check your wallet…');
      last = await window.ethereum.request({
        method: 'eth_sendTransaction', params: [{ from: from, to: STEPS[i].to, data: STEPS[i].data }],
      });
      say('Waiting for the network…');
      // each step must land before the next: the attestation needs the schema
      await confirmed(i, last);
      mark(i, 'done');
    }
    say('Published. You can close this tab.', 'ok');
  } catch (err) {
    const text = (err && (err.message || err.code)) || 'Publishing failed.';
    say(String(text), 'err');
    go.disabled = false;
    await report({ error: String(text) });
  }
});
</script></body></html>`
}
