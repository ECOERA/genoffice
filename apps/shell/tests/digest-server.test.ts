import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDigestServer, Digest } from '../src/main/hosted/digest'
import { KnowledgeBase } from '../src/main/hosted/kb'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

async function setup(summarize?: (title: string, text: string) => Promise<string>) {
  const dir = mkdtempSync(join(tmpdir(), 'digest-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'docs')
  mkdirSync(root)
  writeFileSync(join(root, 'report.md'), '# Soil report\n\nCarbon rose 12% in 2025.\n')
  writeFileSync(join(root, 'plan.txt'), 'Plan for Q4: sample 40 fields.')
  const notesDir = join(dir, 'kb')
  const kb = new KnowledgeBase({
    dbPath: join(dir, 'index.sqlite'),
    roots: [root],
    notesDir,
    watch: false,
  })
  cleanup.push(() => kb.close())
  await kb.start()
  const calls: string[] = []
  const digest = new Digest({
    kb,
    notesDir,
    statePath: join(dir, 'state', 'digest.json'),
    summarize:
      summarize ??
      (async (title, text) => {
        calls.push(title)
        return `- Summary of ${title} (${text.length} chars)`
      }),
  })
  cleanup.push(() => digest.stop())
  return { dir, root, kb, digest, calls }
}

describe('digest', () => {
  it('summarises new files into a dated note, indexes it, and skips unchanged files next time', async () => {
    const { root, kb, digest, calls } = await setup()
    const tools = createDigestServer(digest).tools
    const ctx = { env: {}, log: () => {} }
    const run = (name: string, args: Record<string, unknown> = {}) =>
      tools.find((t) => t.name === name)!.run(args, ctx)
    expect(String(await run('digest_status'))).toBe('The digest has not run yet.')
    const first = String(await run('digest_run'))
    expect(first).toContain('# Digest ')
    expect(first).toContain('2 documents since the beginning.')
    expect(first).toContain('## Soil report')
    expect(first).toContain('- Summary of Soil report')
    expect(first).toContain('Saved as ')
    expect(calls.sort()).toEqual(['Plan for Q4: sample 40 fields.', 'Soil report'])
    const day = new Date().toISOString().slice(0, 10)
    const path = join(digest['opts'].notesDir, `digest-${day}.md`)
    expect(existsSync(path)).toBe(true)
    // the digest is searchable and does not feed itself
    await kb.scan()
    expect(kb.search('"Summary of Soil report"').hits[0]!.path).toBe(path)
    expect(String(await run('digest_run'))).toContain('Nothing new to digest since')
    expect(String(await run('digest_status'))).toContain(`digest-${day}.md`)
    // a change makes a "later run" section in the same day's file
    await new Promise((r) => setTimeout(r, 5))
    writeFileSync(join(root, 'plan.txt'), 'Plan for Q4: sample 60 fields.')
    await kb.scan()
    const again = String(await run('digest_run'))
    expect(again).toContain('1 document since')
    expect(readFileSync(path, 'utf8')).toContain('## Later run (')
    expect(kb.recentFiles(0, 50).some((r) => r.path === path)).toBe(false)
  })

  it('stops early when the provider is unavailable and reports skips', async () => {
    const { digest } = await setup(async () => {
      throw new Error('No AI provider configured')
    })
    const r = await digest.run(0, 10)
    expect(r.summarized).toBe(0)
    expect(r.path).toBeNull()
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]).toContain('No AI provider configured')
    const tools = createDigestServer(digest).tools
    const out = await tools[0]!.run({ since: 'not-a-date' }, { env: {}, log: () => {} })
    expect(out).toMatchObject({ isError: true, text: 'since must be an ISO date' })
  })
})
