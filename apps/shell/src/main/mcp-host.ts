/**
 * Loopback host for MCP servers that live inside the shell main process.
 *
 * The built-in `.mjs` servers (nano-banana, veo, web) run as separate Node
 * processes and must stay dependency-free. Servers that need the app's own
 * libraries — the document parsers, SQLite, the Drive login, a hidden
 * window — are written in TypeScript here instead and served over HTTP on
 * 127.0.0.1 behind a random token. A `builtin` entry in mcp.json resolves to
 * `http://127.0.0.1:<port>/<token>/<name>`, so the app's own MCP client and
 * the Claude Code CLI (Agent SDK `mcpServers`) reach the same endpoint.
 *
 * Each request gets a fresh stateless MCP server instance (the SDK's
 * recommended shape for stateless Streamable HTTP); the tool implementations
 * hold whatever state they need themselves.
 */
import { randomBytes } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpBuiltinSpec, McpRemoteSpec } from '@genoffice/mcp-client'

export interface HostedContext {
  /** the `env` block of the mcp.json entry that enabled this server */
  env: Record<string, string>
  log: (message: string) => void
}

export type HostedContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export type HostedResult =
  string | { text: string; isError?: boolean } | { content: HostedContent[]; isError?: boolean }

export interface HostedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>, ctx: HostedContext) => Promise<HostedResult> | HostedResult
}

export interface HostedServer {
  name: string
  version?: string
  tools: HostedTool[]
}

export interface HostedCallResult {
  content: HostedContent[]
  isError: boolean
  /** the text parts joined, for callers that only want text */
  text: string
}

export function textResult(text: string, isError = false): HostedResult {
  return { text, isError }
}

function normalize(result: HostedResult): { content: HostedContent[]; isError: boolean } {
  if (typeof result === 'string')
    return { content: [{ type: 'text', text: result }], isError: false }
  if ('content' in result) return { content: result.content, isError: result.isError === true }
  return { content: [{ type: 'text', text: result.text }], isError: result.isError === true }
}

export class McpHost {
  private readonly servers = new Map<string, HostedServer>()
  private readonly env = new Map<string, Record<string, string>>()
  private readonly token = randomBytes(16).toString('hex')
  private http: HttpServer | null = null
  /** `http://127.0.0.1:<port>/<token>` once started */
  urlBase = ''

  constructor(private readonly log: (message: string) => void = () => {}) {}

  register(server: HostedServer): void {
    this.servers.set(server.name, server)
  }

  has(name: string): boolean {
    return this.servers.has(name)
  }

  names(): string[] {
    return [...this.servers.keys()]
  }

  async start(): Promise<string> {
    if (this.http) return this.urlBase
    const http = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        this.log(`mcp host: ${String(err)}`)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => {
        http.off('error', reject)
        resolve()
      })
    })
    this.http = http
    const { port } = http.address() as AddressInfo
    this.urlBase = `http://127.0.0.1:${port}/${this.token}`
    return this.urlBase
  }

  async stop(): Promise<void> {
    const http = this.http
    this.http = null
    this.urlBase = ''
    if (!http) return
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }

  /**
   * The remote spec a `builtin` mcp.json entry resolves to when this host
   * serves that server; null when it does not (a script may still).
   */
  specFor(spec: McpBuiltinSpec): McpRemoteSpec | null {
    if (!this.urlBase || !this.servers.has(spec.builtin)) return null
    this.env.set(spec.builtin, { ...spec.env })
    return {
      name: spec.name,
      type: 'http',
      url: `${this.urlBase}/${spec.builtin}`,
      headers: {},
      disabled: spec.disabled,
    }
  }

  /** the env block last configured for a hosted server (empty before any entry resolved it) */
  envFor(name: string): Record<string, string> {
    return this.env.get(name) ?? {}
  }

  /** Runs a tool directly, bypassing HTTP (tests, and in-app callers such as the digest job). */
  async call(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<HostedCallResult> {
    const def = this.servers.get(serverName)
    if (!def)
      return {
        content: [{ type: 'text', text: `unknown server ${serverName}` }],
        isError: true,
        text: `unknown server ${serverName}`,
      }
    const r = await this.runTool(def, toolName, args)
    return {
      ...r,
      text: r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n'),
    }
  }

  private async runTool(
    def: HostedServer,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: HostedContent[]; isError: boolean }> {
    const tool = def.tools.find((t) => t.name === toolName)
    if (!tool)
      return { content: [{ type: 'text', text: `unknown tool ${toolName}` }], isError: true }
    const ctx: HostedContext = {
      env: this.envFor(def.name),
      log: (m) => this.log(`[${def.name}] ${m}`),
    }
    try {
      return normalize(await tool.run(args ?? {}, ctx))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: message }], isError: true }
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parts = (req.url ?? '').split('?')[0]!.split('/').filter(Boolean)
    const def =
      parts.length === 2 && parts[0] === this.token ? this.servers.get(parts[1]!) : undefined
    if (!def) {
      res.writeHead(404)
      res.end()
      return
    }
    const server = new Server(
      { name: def.name, version: def.version ?? '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: def.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.runTool(
        def,
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      ),
    )
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }
}
