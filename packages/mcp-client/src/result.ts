/** Flattens an MCP tool result into the single text string the agent loops feed back to the model. */

export interface McpCallOutcome {
  output: string
  isError: boolean
}

interface ContentPart {
  type?: string
  text?: string
  mimeType?: string
  data?: string
  resource?: { uri?: string; text?: string; mimeType?: string }
}

/** Stores an image a tool returned and gives back a URL the editors can insert; null keeps a placeholder. */
export type McpImageSink = (data: Buffer, mimeType: string) => string | null

export function formatToolResult(result: unknown, imageSink?: McpImageSink): McpCallOutcome {
  const r = (result ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown }
  const parts: string[] = []
  if (Array.isArray(r.content)) {
    for (const item of r.content as ContentPart[]) {
      switch (item?.type) {
        case 'text':
          if (typeof item.text === 'string') parts.push(item.text)
          break
        case 'image': {
          const mime = item.mimeType ?? 'image/png'
          const url =
            imageSink && typeof item.data === 'string'
              ? imageSink(Buffer.from(item.data, 'base64'), mime)
              : null
          if (url) {
            parts.push(`[image saved: ${url}]`)
            break
          }
          parts.push(
            `[image ${item.mimeType ?? 'image'}: ${item.data?.length ?? 0} base64 chars, not shown]`,
          )
          break
        }
        case 'audio':
          parts.push(`[audio ${item.mimeType ?? ''}, not shown]`)
          break
        case 'resource': {
          const res = item.resource ?? {}
          if (typeof res.text === 'string')
            parts.push(res.uri ? `[${res.uri}]\n${res.text}` : res.text)
          else parts.push(`[resource ${res.uri ?? ''}${res.mimeType ? ` (${res.mimeType})` : ''}]`)
          break
        }
        case 'resource_link':
          parts.push(`[resource link ${(item as { uri?: string }).uri ?? ''}]`)
          break
        default:
          parts.push(JSON.stringify(item))
      }
    }
  }
  if (parts.length === 0 && r.structuredContent !== undefined) {
    parts.push(JSON.stringify(r.structuredContent, null, 2))
  }
  return { output: parts.join('\n'), isError: r.isError === true }
}
