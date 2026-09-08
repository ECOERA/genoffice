// A minimal MCP server over stdio for the manager tests: three tools with
// plain JSON-schema inputs (no zod), like the servers people actually run.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'echo-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes the text back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'env',
      description: 'Reports an environment variable of the server process',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${args.text}` }] }
  if (name === 'fail') return { content: [{ type: 'text', text: 'boom' }], isError: true }
  if (name === 'env') return { content: [{ type: 'text', text: process.env[args.name] ?? '' }] }
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
})

await server.connect(new StdioServerTransport())
