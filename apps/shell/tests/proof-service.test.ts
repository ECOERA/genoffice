/**
 * The whole flow, with a scripted wallet in place of MetaMask.
 *
 * `openExternal` is the seam: instead of launching a browser it fetches the
 * signing page, signs the typed data the page was given with a test key, and
 * posts the result back exactly as the real page does. That exercises the real
 * loopback server, the real token check and the real verify-before-store step —
 * everything except the extension itself.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { buildBlankDocx, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { canProve, contentHashOf, proofStatusOf, signDocument } from '../src/main/proof-service'
import {
  readEmbeddedProof,
  readSidecar,
  sidecarPathFor,
  writeSidecar,
} from '../src/main/proof-store'

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proof-service-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function docAt(name: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, await buildBlankDocx())
  return path
}

/** pull the typed-data payload out of the page the server served */
function typedDataFrom(html: string): Record<string, any> {
  const match = /const TYPED = ([\s\S]*?);\nconst TOKEN/.exec(html)
  if (!match) throw new Error('signing page did not carry typed data')
  return JSON.parse(match[1]!) as Record<string, any>
}

/**
 * Stand in for the browser + extension: load the page, sign as `signer`, post
 * back. `reportAs` misreports which address signed, `refuse` declines.
 */
function scriptedWallet(
  opts: { signer?: typeof account; reportAs?: string; refuse?: string } = {},
) {
  return async (url: string) => {
    const page = await fetch(url).then((r) => r.text())
    const typed = typedDataFrom(page)
    const token = new URL(url).searchParams.get('t')!
    const post = (body: unknown) =>
      fetch(`${new URL(url).origin}/result?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    if (opts.refuse) {
      await post({ error: opts.refuse })
      return
    }
    const who = opts.signer ?? account
    typed.message.signer = who.address
    const signature = await who.signTypedData({
      domain: typed.domain,
      types: { DocumentProof: typed.types.DocumentProof },
      primaryType: 'DocumentProof',
      message: { ...typed.message, signedAt: BigInt(typed.message.signedAt) },
    })
    await post({ address: opts.reportAs ?? who.address, signature })
  }
}

describe('canProve', () => {
  it('covers docx and nothing else yet', () => {
    expect(canProve('/a/report.docx')).toBe(true)
    expect(canProve('/a/REPORT.DOCX')).toBe(true)
    expect(canProve('/a/sheet.xlsx')).toBe(false)
    expect(canProve('/a/notes.md')).toBe(false)
  })
})

describe('signDocument', () => {
  it('signs, verifies and stores in both places', async () => {
    const path = await docAt('signed.docx')
    const record = await signDocument(path, 'signed.docx', 'approved', {
      openExternal: scriptedWallet(),
    })

    expect(record.signer).toBe(account.address)
    expect(record.intent).toBe('approved')
    // a fresh signature is stored unpublished: anchoring is a separate, paid act
    expect(await readSidecar(path)).toEqual({ record, anchor: null })
    expect(await readEmbeddedProof(await readFile(path))).toEqual({ record, anchor: null })
  })

  it('reports the document as validly signed afterwards', async () => {
    const path = await docAt('status.docx')
    await signDocument(path, 'status.docx', 'reviewed', { openExternal: scriptedWallet() })
    const status = await proofStatusOf(path)
    expect(status.state).toBe('valid')
    expect(status.record?.signer).toBe(account.address)
  })

  it('rejects a page that lies about which address signed', async () => {
    const path = await docAt('liar.docx')
    const impostor = '0x000000000000000000000000000000000000dEaD'
    await expect(
      signDocument(path, 'liar.docx', 'approved', {
        openExternal: scriptedWallet({ reportAs: impostor }),
      }),
    ).rejects.toThrow(/does not verify/)
    // nothing was stored
    expect(await readSidecar(path)).toBeNull()
  })

  it('surfaces a refusal from the wallet', async () => {
    const path = await docAt('refused.docx')
    await expect(
      signDocument(path, 'refused.docx', 'approved', {
        openExternal: scriptedWallet({ refuse: 'User rejected the request.' }),
      }),
    ).rejects.toThrow(/User rejected/)
  })

  it('refuses formats it cannot reduce to a canonical form', async () => {
    const path = join(dir, 'notes.md')
    await writeFile(path, '# hello', 'utf8')
    await expect(
      signDocument(path, 'notes.md', 'approved', { openExternal: scriptedWallet() }),
    ).rejects.toThrow(/Only .docx/)
  })

  it('can be cancelled', async () => {
    const path = await docAt('cancelled.docx')
    const controller = new AbortController()
    const signing = signDocument(path, 'cancelled.docx', 'approved', {
      openExternal: async () => {
        controller.abort()
      },
      signal: controller.signal,
    })
    await expect(signing).rejects.toThrow(/cancelled/i)
  })
})

describe('proofStatusOf', () => {
  it('says unsigned for a document nobody signed', async () => {
    expect((await proofStatusOf(await docAt('plain.docx'))).state).toBe('unsigned')
  })

  it('says unsigned for a path that does not exist', async () => {
    expect((await proofStatusOf(join(dir, 'ghost.docx'))).state).toBe('unsigned')
  })

  it('still says valid after the document is re-saved untouched', async () => {
    const path = await docAt('resaved.docx')
    await signDocument(path, 'resaved.docx', 'approved', { openExternal: scriptedWallet() })

    const parsed = await parseDocx(await readFile(path))
    const blocks = parsed.blocks
      .filter((b) => !b.hidden && b.docxIndex !== null)
      .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))
    await writeFile(path, await saveDocx(parsed, blocks, { removePersonalInfo: true }))

    // the bytes moved, the content did not — this is the whole point
    expect((await proofStatusOf(path)).state).toBe('valid')
  })

  it('says content-changed once the document is actually edited', async () => {
    const path = await docAt('edited.docx')
    await signDocument(path, 'edited.docx', 'approved', { openExternal: scriptedWallet() })
    const signedHash = await contentHashOf(path)

    // replace the file with different content, keeping the sidecar
    const { record } = (await readSidecar(path))!
    await writeFile(path, await buildBlankDocx())
    const parsed = await parseDocx(await readFile(path))
    const edited = parsed.blocks.map((b) => ({ ...b, runs: [{ text: 'different content' }] }))
    const blocks = edited
      .filter((b) => b.docxIndex !== null)
      .map((b) => ({ kind: 'generated' as const, block: { ...b, kind: 'paragraph' as const } }))
    // a generated-block save is the editor's own path for edited text
    await writeFile(path, await saveDocx(parsed, blocks))
    await writeSidecar(path, { record, anchor: null })

    expect(await contentHashOf(path)).not.toBe(signedHash)
    const status = await proofStatusOf(path)
    expect(status.state).toBe('content-changed')
    // the signer is still named: the proof was real, the document moved on
    expect(status.record?.signer).toBe(account.address)
  })

  it('says invalid for a tampered record', async () => {
    const path = await docAt('tampered.docx')
    await signDocument(path, 'tampered.docx', 'approved', { openExternal: scriptedWallet() })
    const { record } = (await readSidecar(path))!
    // strip the embedded copy so the doctored sidecar is what gets read
    await writeFile(path, await buildBlankDocx())
    await writeSidecar(path, { record: { ...record, intent: 'authored' }, anchor: null })
    expect((await proofStatusOf(path)).state).toBe('invalid')
  })

  it('rejects a sidecar whose hash does not describe the document', async () => {
    const mine = await docAt('mine.docx')
    const theirs = await docAt('theirs.docx')
    await signDocument(mine, 'mine.docx', 'approved', { openExternal: scriptedWallet() })
    const { record } = (await readSidecar(mine))!
    await writeSidecar(theirs, {
      record: { ...record, contentHash: `0x${'99'.repeat(32)}` },
      anchor: null,
    })
    // rewriting the hash breaks recovery, because the hash is inside the signed
    // struct — so this fails as a bad signature, not merely as a bad match
    expect((await proofStatusOf(theirs)).state).toBe('invalid')
  })

  it('accepts a proof moved onto a byte-different file with identical content', async () => {
    // Worth stating rather than hiding: a proof attests to content, not to a
    // path or a file name. Two documents that say the same thing share a
    // digest, so a sidecar copied between them verifies. The record carries the
    // name it was signed under, and the UI shows it, so a mismatch is visible —
    // but verification does not reject it, and should not: the signer did
    // attest to exactly this content.
    const mine = await docAt('original.docx')
    const copy = await docAt('copy.docx')
    await signDocument(mine, 'original.docx', 'approved', { openExternal: scriptedWallet() })
    await writeSidecar(copy, (await readSidecar(mine))!)

    const status = await proofStatusOf(copy)
    expect(status.state).toBe('valid')
    expect(status.record?.document).toBe('original.docx')
  })
})

describe('the sidecar path', () => {
  it('sits next to the document', async () => {
    const path = await docAt('neighbour.docx')
    await signDocument(path, 'neighbour.docx', 'approved', { openExternal: scriptedWallet() })
    expect(sidecarPathFor(path)).toBe(`${path}.sig.json`)
    await expect(readFile(sidecarPathFor(path), 'utf8')).resolves.toContain('"signature"')
  })
})
