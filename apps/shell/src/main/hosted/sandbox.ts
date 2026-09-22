/**
 * Sandbox — a hosted MCP server (see mcp-host.ts) that runs small programs
 * for data work: JavaScript in a fresh `node:vm` context with a time limit
 * and no access to require/process/network, and Python 3 through the
 * system interpreter when one is installed. Input data goes in as JSON, the
 * program prints or returns its result, and the assistant writes it into
 * the document or sheet.
 *
 * `node:vm` is a convenience boundary, not a security one: the permission
 * prompt on this server is the user's gate.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { textResult, type HostedServer, type HostedTool } from '../mcp-host'

export interface SandboxOptions {
  /** python executable, default python3 (resolved on PATH); '' disables */
  python?: string
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  maxOutputChars?: number
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function cap(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[output truncated at ${max} characters]` : s
}

function parseInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function stringify(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 1) ?? String(v)
  } catch {
    return String(v)
  }
}

export class Sandbox {
  private pythonPath: string | null | undefined
  constructor(private readonly opts: SandboxOptions = {}) {}

  get defaultTimeout(): number {
    return this.opts.defaultTimeoutMs ?? 10_000
  }
  get maxTimeout(): number {
    return this.opts.maxTimeoutMs ?? 120_000
  }
  get maxOutput(): number {
    return this.opts.maxOutputChars ?? 20_000
  }

  runJavaScript(
    code: string,
    input: unknown,
    timeoutMs: number,
  ): { output: string; isError: boolean } {
    const logs: string[] = []
    const log =
      (level: string) =>
      (...args: unknown[]) => {
        logs.push((level ? `[${level}] ` : '') + args.map(stringify).join(' '))
      }
    const sandbox = {
      input,
      console: {
        log: log(''),
        info: log(''),
        warn: log('warn'),
        error: log('error'),
        table: log(''),
      },
    }
    try {
      const result = runInNewContext(`(() => {\n${code}\n})()`, sandbox, {
        timeout: timeoutMs,
        filename: 'sandbox.js',
      }) as unknown
      const parts = [...logs]
      if (result !== undefined) parts.push(`Result: ${stringify(result)}`)
      return {
        output: cap(
          parts.join('\n') || '(no output; use console.log or return a value)',
          this.maxOutput,
        ),
        isError: false,
      }
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      const timeout = /Script execution timed out/i.test(message)
      return {
        output: cap(
          [...logs, timeout ? `Timed out after ${timeoutMs} ms` : message].join('\n'),
          this.maxOutput,
        ),
        isError: true,
      }
    }
  }

  python(): string | null {
    if (this.pythonPath !== undefined) return this.pythonPath
    const candidate = this.opts.python ?? 'python3'
    if (!candidate) return (this.pythonPath = null)
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 })
    this.pythonPath = probe.status === 0 ? candidate : null
    return this.pythonPath
  }

  async runPython(
    code: string,
    input: unknown,
    timeoutMs: number,
  ): Promise<{ output: string; isError: boolean }> {
    const py = this.python()
    if (!py)
      return {
        output: 'Python 3 is not installed on this machine; run_javascript works without it.',
        isError: true,
      }
    const dir = mkdtempSync(join(tmpdir(), 'duneoffice-py-'))
    try {
      return await new Promise((resolve) => {
        const child = spawn(py, ['-I', '-c', code], {
          cwd: dir,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: dir,
            LANG: 'C.UTF-8',
            PYTHONIOENCODING: 'utf-8',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let out = ''
        let errText = ''
        let killed = false
        const timer = setTimeout(() => {
          killed = true
          child.kill('SIGKILL')
        }, timeoutMs)
        child.stdout.on('data', (c: Buffer) => (out += c.toString()))
        child.stderr.on('data', (c: Buffer) => (errText += c.toString()))
        child.on('error', (err) => {
          clearTimeout(timer)
          resolve({ output: `Could not start Python: ${err.message}`, isError: true })
        })
        child.on('close', (status) => {
          clearTimeout(timer)
          if (killed)
            resolve({
              output: cap(`${out}\nTimed out after ${timeoutMs} ms`, this.maxOutput),
              isError: true,
            })
          else if (status !== 0)
            resolve({
              output: cap(
                `${out}${out && errText ? '\n' : ''}${errText}`.trim() || `exit status ${status}`,
                this.maxOutput,
              ),
              isError: true,
            })
          else
            resolve({
              output: cap(
                `${out}${errText ? `\n[stderr]\n${errText}` : ''}`.trim() ||
                  '(no output; print the result)',
                this.maxOutput,
              ),
              isError: false,
            })
        })
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify(input ?? null))
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export function createSandboxServer(sandbox: Sandbox): HostedServer {
  const timeoutArg = (args: Record<string, unknown>) =>
    clamp(Number(args.timeout_ms) || sandbox.defaultTimeout, 100, sandbox.maxTimeout)
  const tools: HostedTool[] = [
    {
      name: 'run_javascript',
      description:
        'Run a JavaScript snippet for calculations and data transformation (sums, pivots, statistics, date maths, reshaping tables before writing them into a sheet). The snippet runs in an isolated context with a time limit: `input` holds the data you pass, console.log prints, and a `return` value is shown as JSON. No require, fetch or file access.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Function body; use `input`, console.log and return',
          },
          input: {
            description: 'JSON data available as `input` (any JSON value, or a JSON string)',
          },
          timeout_ms: { type: 'integer', description: 'default 10000' },
        },
        required: ['code'],
      },
      run: (args) => {
        const code = String(args.code ?? '')
        if (!code.trim()) return textResult('code must not be empty', true)
        const r = sandbox.runJavaScript(code, parseInput(args.input), timeoutArg(args))
        return { text: r.output, isError: r.isError }
      },
    },
    {
      name: 'run_python',
      description:
        "Run a Python 3 script with the machine's own interpreter (only libraries installed there are available; the standard library always is). The JSON `input` arrives on stdin (`json.load(sys.stdin)`); print the result. Use for heavier analysis than run_javascript; falls back with a clear error when Python is missing.",
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          input: { description: 'JSON data written to stdin' },
          timeout_ms: { type: 'integer', description: 'default 10000' },
        },
        required: ['code'],
      },
      run: async (args) => {
        const code = String(args.code ?? '')
        if (!code.trim()) return textResult('code must not be empty', true)
        const r = await sandbox.runPython(code, parseInput(args.input), timeoutArg(args))
        return { text: r.output, isError: r.isError }
      },
    },
  ]
  return { name: 'sandbox', version: '1.0.0', tools }
}
