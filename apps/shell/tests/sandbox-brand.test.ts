import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brand, createBrandServer } from '../src/main/hosted/brand'
import { createSandboxServer, Sandbox } from '../src/main/hosted/sandbox'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

describe('sandbox', () => {
  const tools = createSandboxServer(new Sandbox({ defaultTimeoutMs: 2000 })).tools
  const ctx = { env: {}, log: () => {} }
  const run = (name: string, args: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.run(args, ctx)

  it('runs JavaScript with input, console output and a returned value', async () => {
    const r = await run('run_javascript', {
      code: 'console.log("rows", input.rows.length); return input.rows.reduce((s, r) => s + r.v, 0)',
      input: { rows: [{ v: 1.5 }, { v: 2.5 }] },
    })
    expect(r).toMatchObject({ isError: false })
    expect((r as { text: string }).text).toBe('rows 2\nResult: 4')
    const str = await run('run_javascript', {
      code: 'return input.a',
      input: '{"a": "from json string"}',
    })
    expect((str as { text: string }).text).toBe('Result: from json string')
  })

  it('has no require/process/fetch and stops runaway code', async () => {
    const r = await run('run_javascript', {
      code: 'return typeof require + typeof process + typeof fetch',
    })
    expect((r as { text: string }).text).toBe('Result: undefinedundefinedundefined')
    const loop = await run('run_javascript', { code: 'while (true) {}', timeout_ms: 300 })
    expect(loop).toMatchObject({ isError: true })
    expect((loop as { text: string }).text).toContain('Timed out after 300 ms')
    const thrown = await run('run_javascript', { code: 'throw new Error("nope")' })
    expect((thrown as { text: string }).text).toContain('Error: nope')
  })

  it('runs Python when available, otherwise says so', async () => {
    const sb = new Sandbox()
    if (!sb.python()) {
      const r = await run('run_python', { code: 'print(1)' })
      expect(r).toMatchObject({ isError: true })
      return
    }
    const r = await run('run_python', {
      code: 'import json, sys\nd = json.load(sys.stdin)\nprint(sum(d["v"]))',
      input: { v: [1, 2, 3.5] },
    })
    expect(r).toMatchObject({ isError: false })
    expect((r as { text: string }).text).toBe('6.5')
    const bad = await run('run_python', { code: 'raise SystemExit("boom")' })
    expect(bad).toMatchObject({ isError: true })
    expect((bad as { text: string }).text).toContain('boom')
    const slow = await run('run_python', { code: 'import time\ntime.sleep(5)', timeout_ms: 300 })
    expect((slow as { text: string }).text).toContain('Timed out')
  })

  it('reports a missing interpreter cleanly', async () => {
    const t = createSandboxServer(new Sandbox({ python: '/definitely/not/python' })).tools
    const r = await t.find((x) => x.name === 'run_python')!.run({ code: 'print(1)' }, ctx)
    expect(r).toMatchObject({ isError: true })
    expect((r as { text: string }).text).toContain('not installed')
  })
})

describe('brand kit', () => {
  it('guides when empty, saves and merges, serves the logo through the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const logo = join(dir, 'logo.png')
    writeFileSync(logo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const saved: { mime: string; bytes: number }[] = []
    const brand = new Brand({
      path: join(dir, 'cfg', 'brand.json'),
      imageUrlFor: (data, mime) => {
        saved.push({ mime, bytes: data.length })
        return `http://127.0.0.1:1/tok/logo-${saved.length}.png`
      },
    })
    const tools = createBrandServer(brand).tools
    const ctx = { env: {}, log: () => {} }
    const run = (name: string, args: Record<string, unknown> = {}) =>
      tools.find((t) => t.name === name)!.run(args, ctx)

    expect(String(await run('brand_get'))).toContain('No brand kit yet')
    const bad = await run('brand_set', { kit: { colors: { primary: 'green' } } })
    expect(bad).toMatchObject({ isError: true })

    const first = String(
      await run('brand_set', {
        kit: {
          name: 'Ecoera',
          fonts: { heading: 'Montserrat', body: 'Source Sans 3' },
          colors: { primary: '#2E6B3F' },
          logo: { path: logo, alt: 'Ecoera' },
        },
      }),
    )
    expect(first).toContain('Brand: Ecoera')
    expect(first).toContain('Fonts: heading Montserrat, body Source Sans 3')
    expect(first).toContain('Colours: primary #2E6B3F')
    expect(first).toContain('Logo: http://127.0.0.1:1/tok/logo-1.png (alt: Ecoera)')
    expect(saved).toEqual([{ mime: 'image/png', bytes: 7 }])

    // merge keeps earlier fields; the logo URL is cached, not re-saved
    const second = String(
      await run('brand_set', {
        kit: { colors: { accent: '#1F4E8C' }, footer: 'Ecoera AB · Falkenberg' },
      }),
    )
    expect(second).toContain('Colours: primary #2E6B3F, accent #1F4E8C')
    expect(second).toContain('Footer: Ecoera AB · Falkenberg')
    expect(second).toContain('logo-1.png')
    expect(saved).toHaveLength(1)
    const file = JSON.parse(readFileSync(join(dir, 'cfg', 'brand.json'), 'utf8')) as {
      fonts: { heading: string }
    }
    expect(file.fonts.heading).toBe('Montserrat')
    expect(String(await run('brand_get'))).toContain('Raw kit:')
  })
})
