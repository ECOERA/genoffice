import { describe, expect, it } from 'vitest'
import { createDiagramServer } from '../src/main/hosted/diagram'

/** The diagram tool around a fake renderer: arguments, storage, error wording. */
describe('diagram MCP tool', () => {
  it('renders, stores and returns the URL; reports Mermaid errors readably', async () => {
    const calls: [string, string, number][] = []
    const saved: string[] = []
    const tools = createDiagramServer({
      render: async (code, theme, scale) => {
        calls.push([code, theme, scale])
        if (code.includes('bad')) throw new Error('Parse error on line 2:\n...')
        return { png: Buffer.from('png'), svg: '<svg/>', width: 640, height: 320 }
      },
      saveImage: (data, mime) => {
        saved.push(`${mime}:${data.length}`)
        return 'http://127.0.0.1:1/tok/diagram.png'
      },
    }).tools
    const ctx = { env: {}, log: () => {} }
    const ok = String(
      await tools[0]!.run({ code: 'flowchart LR\n A --> B', theme: 'forest', scale: 9 }, ctx),
    )
    expect(ok).toContain('Diagram rendered (640×320 px at 4x): http://127.0.0.1:1/tok/diagram.png')
    expect(calls[0]).toEqual(['flowchart LR\n A --> B', 'forest', 4])
    expect(saved).toEqual(['image/png:3'])
    const dflt = await tools[0]!.run({ code: 'pie\n "a": 1', theme: 'purple' }, ctx)
    expect(calls[1]).toEqual(['pie\n "a": 1', 'default', 2])
    expect(String(dflt)).toContain('at 2x')
    const bad = await tools[0]!.run({ code: 'bad' }, ctx)
    expect(bad).toMatchObject({ isError: true })
    expect((bad as { text: string }).text).toBe(
      'Mermaid could not render the diagram: Parse error on line 2:. Fix the syntax and try again.',
    )
    expect(await tools[0]!.run({ code: '' }, ctx)).toMatchObject({ isError: true })
  })
})
