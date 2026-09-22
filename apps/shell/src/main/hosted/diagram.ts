/**
 * Diagrams — a hosted MCP server (see mcp-host.ts) that renders Mermaid
 * (flowcharts, sequence, class, state, ER, Gantt, pie, mindmap, timeline…)
 * to a PNG in the media store, so the assistant can insert process and
 * system diagrams into documents and slides with the editors' image tools.
 * The renderer is injected: in the app it is the hidden Mermaid window
 * (main/diagram-window.ts); tests pass a fake.
 */
import { textResult, type HostedServer, type HostedTool } from '../mcp-host'

export interface DiagramImage {
  png: Buffer
  svg: string
  width: number
  height: number
}

export type DiagramRenderer = (code: string, theme: string, scale: number) => Promise<DiagramImage>

export interface DiagramOptions {
  render: DiagramRenderer
  /** stores the PNG and returns its http URL (the media store) */
  saveImage: (data: Buffer, mimeType: string) => string | null
}

const THEMES = ['default', 'neutral', 'dark', 'forest']

export function createDiagramServer(opts: DiagramOptions): HostedServer {
  const tools: HostedTool[] = [
    {
      name: 'render_diagram',
      description:
        "Render a Mermaid diagram (flowchart, sequence, class, state, ER, Gantt, pie, mindmap, timeline, quadrant) to a PNG and return its URL for the editor's image tool. Use it for processes, systems, org charts and timelines; use nano-banana for photos and illustrations, and the editors' chart tools for data charts. Keep labels short; Swedish is fine.",
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Mermaid source, e.g. "flowchart LR\\n  A[Soil sample] --> B[Lab]"',
          },
          theme: {
            type: 'string',
            enum: THEMES,
            description: 'default (light), neutral (grey), dark, forest',
          },
          scale: { type: 'number', description: 'Pixel density 1–4, default 2 (crisp in print)' },
        },
        required: ['code'],
      },
      run: async (args) => {
        const code = String(args.code ?? '').trim()
        if (!code) return textResult('code must not be empty', true)
        const theme = THEMES.includes(String(args.theme)) ? String(args.theme) : 'default'
        const scale = Math.max(1, Math.min(4, Number(args.scale) || 2))
        let image: DiagramImage
        try {
          image = await opts.render(code, theme, scale)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return textResult(
            `Mermaid could not render the diagram: ${message.split('\n')[0]}. Fix the syntax and try again.`,
            true,
          )
        }
        const url = opts.saveImage(image.png, 'image/png')
        if (!url) return textResult('The image store is not available', true)
        return `Diagram rendered (${image.width}×${image.height} px at ${scale}x): ${url}\nInsert it with the editor's image tool using this URL; a width of about ${Math.min(image.width, 640)} px fits a page column.`
      },
    },
  ]
  return { name: 'diagram', version: '1.0.0', tools }
}
