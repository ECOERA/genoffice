/**
 * Mail and calendar — a hosted MCP server (see mcp-host.ts) on the same
 * Google sign-in as Drive: search and read Gmail, save drafts (never send),
 * list and create Calendar events, find free slots. The access token and the
 * granted scopes are injected by the shell (GoogleDriveService); the HTTP
 * client is injectable for tests.
 */
import { textResult, type HostedServer, type HostedTool } from '../mcp-host'

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
]
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
]

export interface GoogleOptions {
  /** a valid access token, or throws when not signed in */
  token: () => Promise<string>
  /** scopes the stored grant covers ([] when unknown) */
  scopes: () => string[]
  fetchImpl?: typeof fetch
  gmailBase?: string
  calendarBase?: string
  /** IANA zone for free-slot maths, default the machine's */
  timezone?: string
}

type Json = Record<string, unknown>
const asRecord = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export const REAUTH_HINT =
  'Sign in to Google again (Home → Google Drive → sign out, then sign in) so the mail and calendar permissions are granted.'

function b64url(s: string | Buffer): string {
  return Buffer.from(s)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
function fromB64url(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function htmlToText(html: string): string {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** the text of a Gmail payload: text/plain preferred, else text/html converted */
export function bodyOf(payload: Json): { text: string; attachments: string[] } {
  const attachments: string[] = []
  let plain = ''
  let html = ''
  const visit = (part: Json) => {
    const mime = String(part.mimeType ?? '')
    const body = asRecord(part.body)
    if (part.filename)
      attachments.push(`${String(part.filename)} (${Math.round(Number(body.size ?? 0) / 1024)} KB)`)
    else if (typeof body.data === 'string') {
      if (mime === 'text/plain' && !plain) plain = fromB64url(body.data)
      else if (mime === 'text/html' && !html) html = fromB64url(body.data)
    }
    for (const p of asArray(part.parts)) visit(asRecord(p))
  }
  visit(payload)
  return { text: plain || htmlToText(html), attachments }
}

/** RFC 2822 message with UTF-8 text body, base64url-encoded for the Gmail API */
export function buildRawMessage(m: {
  to: string
  cc?: string
  subject: string
  body: string
  inReplyTo?: string
}): string {
  const subject = `=?UTF-8?B?${Buffer.from(m.subject).toString('base64')}?=`
  const lines = [
    `To: ${m.to}`,
    ...(m.cc ? [`Cc: ${m.cc}`] : []),
    `Subject: ${subject}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.body).toString('base64'),
  ]
  return b64url(lines.join('\r\n'))
}

export class GoogleTools {
  private readonly gmail: string
  private readonly calendar: string
  private readonly fetchImpl: typeof fetch
  constructor(private readonly opts: GoogleOptions) {
    this.gmail = (opts.gmailBase ?? 'https://gmail.googleapis.com/gmail/v1/users/me').replace(
      /\/+$/,
      '',
    )
    this.calendar = (opts.calendarBase ?? 'https://www.googleapis.com/calendar/v3').replace(
      /\/+$/,
      '',
    )
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private need(scopes: string[]): string | null {
    const have = this.opts.scopes()
    if (!have.length) return null // unknown: let the API decide
    return scopes.some((s) => have.includes(s)) ? null : REAUTH_HINT
  }

  private async api(url: string, init: RequestInit = {}): Promise<Json> {
    let token: string
    try {
      token = await this.opts.token()
    } catch (err) {
      throw new Error(
        `Not signed in to Google: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    })
    const body = asRecord(await res.json().catch(() => ({})))
    if (!res.ok) {
      const message = String(asRecord(body.error).message ?? res.statusText)
      if (res.status === 403 && /insufficient|scope/i.test(message))
        throw new Error(`${message}. ${REAUTH_HINT}`)
      if (res.status === 403 && /not been used|disabled|enable it/i.test(message))
        throw new Error(
          `${message.split('.')[0]}. Enable the API in the Google Cloud project that owns the OAuth client.`,
        )
      throw new Error(`Google API ${res.status}: ${message}`)
    }
    return body
  }

  async gmailSearch(query: string, max: number): Promise<string> {
    const denied = this.need([GMAIL_SCOPES[0]!])
    if (denied) return denied
    const list = await this.api(
      `${this.gmail}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
    )
    const ids = asArray(list.messages).map((m) => String(asRecord(m).id ?? ''))
    if (!ids.length) return `No messages match "${query}".`
    const lines = [
      `Messages matching "${query}"${list.resultSizeEstimate ? ` (about ${String(list.resultSizeEstimate)} in total)` : ''}:`,
    ]
    for (const id of ids) {
      const m = await this.api(
        `${this.gmail}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      )
      const headers = Object.fromEntries(
        asArray(asRecord(m.payload).headers).map((h) => [
          String(asRecord(h).name).toLowerCase(),
          String(asRecord(h).value),
        ]),
      )
      lines.push(
        `- ${headers.date ?? ''} | ${headers.from ?? ''} | ${headers.subject ?? '(no subject)'} | id ${id}${m.snippet ? `\n  ${String(m.snippet)}` : ''}`,
      )
    }
    lines.push('', 'Use gmail_read with an id for the full text.')
    return lines.join('\n')
  }

  async gmailRead(id: string, maxChars: number): Promise<string> {
    const denied = this.need([GMAIL_SCOPES[0]!])
    if (denied) return denied
    const m = await this.api(`${this.gmail}/messages/${encodeURIComponent(id)}?format=full`)
    const payload = asRecord(m.payload)
    const headers = Object.fromEntries(
      asArray(payload.headers).map((h) => [
        String(asRecord(h).name).toLowerCase(),
        String(asRecord(h).value),
      ]),
    )
    const { text, attachments } = bodyOf(payload)
    const head = [
      `From: ${headers.from ?? ''}`,
      `To: ${headers.to ?? ''}`,
      ...(headers.cc ? [`Cc: ${headers.cc}`] : []),
      `Date: ${headers.date ?? ''}`,
      `Subject: ${headers.subject ?? ''}`,
      `Thread: ${String(m.threadId ?? '')} · Message-Id: ${headers['message-id'] ?? ''}`,
      ...(attachments.length ? [`Attachments: ${attachments.join(', ')}`] : []),
    ]
    const body =
      text.length > maxChars
        ? `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} more characters]`
        : text
    return `${head.join('\n')}\n\n${body || '(empty body)'}`
  }

  async gmailDraft(m: {
    to: string
    cc?: string
    subject: string
    body: string
    threadId?: string
    inReplyTo?: string
  }): Promise<string> {
    const denied = this.need([GMAIL_SCOPES[1]!])
    if (denied) return denied
    const raw = buildRawMessage(m)
    const draft = await this.api(`${this.gmail}/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { raw, ...(m.threadId ? { threadId: m.threadId } : {}) } }),
    })
    return `Draft saved in Gmail (draft id ${String(draft.id ?? '?')}) to ${m.to}: "${m.subject}". It is not sent; the user reviews and sends it from Gmail.`
  }

  async calendarList(from: string, to: string, calendar: string, max: number): Promise<string> {
    const denied = this.need(CALENDAR_SCOPES)
    if (denied) return denied
    const u = new URL(`${this.calendar}/calendars/${encodeURIComponent(calendar)}/events`)
    u.searchParams.set('timeMin', new Date(from).toISOString())
    u.searchParams.set('timeMax', new Date(to).toISOString())
    u.searchParams.set('singleEvents', 'true')
    u.searchParams.set('orderBy', 'startTime')
    u.searchParams.set('maxResults', String(max))
    const r = await this.api(u.toString())
    const items = asArray(r.items).map(asRecord)
    if (!items.length) return `No events between ${from} and ${to} in ${calendar}.`
    const lines = [`Events in ${calendar} (${String(r.timeZone ?? '')}):`]
    for (const e of items) {
      const start = asRecord(e.start)
      const end = asRecord(e.end)
      const when = start.dateTime
        ? `${String(start.dateTime)} → ${String(end.dateTime ?? '')}`
        : `${String(start.date ?? '')} (all day)`
      const who = asArray(e.attendees).length ? ` · ${asArray(e.attendees).length} attendees` : ''
      lines.push(
        `- ${when} | ${String(e.summary ?? '(no title)')}${e.location ? ` @ ${String(e.location)}` : ''}${who} | id ${String(e.id ?? '')}`,
      )
    }
    return lines.join('\n')
  }

  async calendarCreate(ev: {
    title: string
    start: string
    end: string
    description?: string
    location?: string
    attendees?: string[]
    calendar: string
    timezone?: string
  }): Promise<string> {
    const denied = this.need([CALENDAR_SCOPES[0]!])
    if (denied) return denied
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(ev.start)
    const tz = ev.timezone ?? this.opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const body: Json = {
      summary: ev.title,
      ...(ev.description ? { description: ev.description } : {}),
      ...(ev.location ? { location: ev.location } : {}),
      start: allDay ? { date: ev.start } : { dateTime: ev.start, timeZone: tz },
      end: allDay ? { date: ev.end } : { dateTime: ev.end, timeZone: tz },
      ...(ev.attendees?.length ? { attendees: ev.attendees.map((email) => ({ email })) } : {}),
    }
    const r = await this.api(
      `${this.calendar}/calendars/${encodeURIComponent(ev.calendar)}/events?sendUpdates=none`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    return `Event created: ${String(r.summary ?? ev.title)} (${ev.start} → ${ev.end}), id ${String(r.id ?? '')}${r.htmlLink ? `, ${String(r.htmlLink)}` : ''}. Invitations were not emailed; the user can send them from Google Calendar.`
  }

  async freeSlots(opts: {
    from: string
    to: string
    durationMin: number
    calendar: string
    dayStart: string
    dayEnd: string
    max: number
  }): Promise<string> {
    const denied = this.need(CALENDAR_SCOPES)
    if (denied) return denied
    const tz = this.opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const r = await this.api(`${this.calendar}/freeBusy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timeMin: new Date(opts.from).toISOString(),
        timeMax: new Date(opts.to).toISOString(),
        timeZone: tz,
        items: [{ id: opts.calendar }],
      }),
    })
    const busy = asArray(asRecord(asRecord(r.calendars)[opts.calendar]).busy)
      .map((b) => ({
        start: new Date(String(asRecord(b).start)).getTime(),
        end: new Date(String(asRecord(b).end)).getTime(),
      }))
      .sort((a, b) => a.start - b.start)
    const slots: string[] = []
    const dur = opts.durationMin * 60_000
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    const hm = (s: string) => s.split(':').map(Number) as [number, number]
    const [sh, sm] = hm(opts.dayStart)
    const [eh, em] = hm(opts.dayEnd)
    // walk day by day in the zone: build the workday window from the zone's local date
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const localDate = (t: number) =>
      parts
        .formatToParts(new Date(t))
        .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {})
    const zoneOffsetMs = (t: number) => {
      const p = localDate(t)
      const asUtc = Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour) % 24,
        Number(p.minute),
      )
      return asUtc - t
    }
    const start = new Date(opts.from).getTime()
    const end = new Date(opts.to).getTime()
    for (let t = start; t < end && slots.length < opts.max;) {
      const p = localDate(t)
      const off = zoneOffsetMs(t)
      const dayStart = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), sh, sm) - off
      const dayEnd = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), eh, em) - off
      const weekday = new Date(t + off).getUTCDay()
      let cursor = Math.max(dayStart, start)
      if (weekday !== 0 && weekday !== 6) {
        for (const b of busy) {
          if (b.end <= cursor) continue
          if (b.start >= dayEnd) break
          if (b.start - cursor >= dur)
            slots.push(`${fmt.format(new Date(cursor))} – ${fmt.format(new Date(cursor + dur))}`)
          cursor = Math.max(cursor, b.end)
          if (slots.length >= opts.max) break
        }
        if (slots.length < opts.max && Math.min(dayEnd, end) - cursor >= dur)
          slots.push(`${fmt.format(new Date(cursor))} – ${fmt.format(new Date(cursor + dur))}`)
      }
      t = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + 1, 0, 0) - off
    }
    if (!slots.length)
      return `No free ${opts.durationMin}-minute slot on workdays between ${opts.dayStart} and ${opts.dayEnd} in that range.`
    return `Free ${opts.durationMin}-minute slots (${tz}, workdays ${opts.dayStart}–${opts.dayEnd}), earliest first:\n${slots.map((s) => `- ${s}`).join('\n')}`
  }
}

export function createGoogleServer(g: GoogleTools): HostedServer {
  const tools: HostedTool[] = [
    {
      name: 'gmail_search',
      description:
        "Search the user's Gmail with Gmail query syntax (from:, to:, subject:, newer_than:7d, has:attachment, label:…). Returns date, sender, subject, snippet and id per message.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          max: { type: 'integer', description: '1–25, default 10' },
        },
        required: ['query'],
      },
      run: (args) => {
        const q = String(args.query ?? '').trim()
        if (!q) return textResult('query is required', true)
        return g.gmailSearch(q, clamp(Number(args.max) || 10, 1, 25))
      },
    },
    {
      name: 'gmail_read',
      description:
        'Read one email (headers, text body, attachment names) by the id from gmail_search.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          max_chars: { type: 'integer', description: 'default 20000' },
        },
        required: ['id'],
      },
      run: (args) => {
        const id = String(args.id ?? '').trim()
        if (!id) return textResult('id is required', true)
        return g.gmailRead(id, clamp(Number(args.max_chars) || 20_000, 500, 100_000))
      },
    },
    {
      name: 'gmail_draft',
      description:
        'Save an email as a Gmail draft for the user to review and send (this tool never sends). Reply in a thread by passing thread_id and in_reply_to (Message-Id) from gmail_read.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          cc: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain text' },
          thread_id: { type: 'string' },
          in_reply_to: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
      run: (args) => {
        const to = String(args.to ?? '').trim()
        const subject = String(args.subject ?? '').trim()
        const body = String(args.body ?? '')
        if (!to || !subject || !body.trim())
          return textResult('to, subject and body are required', true)
        return g.gmailDraft({
          to,
          cc: typeof args.cc === 'string' && args.cc.trim() ? args.cc.trim() : undefined,
          subject,
          body,
          threadId:
            typeof args.thread_id === 'string' && args.thread_id ? args.thread_id : undefined,
          inReplyTo:
            typeof args.in_reply_to === 'string' && args.in_reply_to ? args.in_reply_to : undefined,
        })
      },
    },
    {
      name: 'calendar_list',
      description: "List the user's calendar events in a date range (ISO dates or date-times).",
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          calendar: { type: 'string', description: 'default primary' },
          max: { type: 'integer', description: 'default 50' },
        },
        required: ['from', 'to'],
      },
      run: (args) => {
        const from = String(args.from ?? '').trim()
        const to = String(args.to ?? '').trim()
        if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
          return textResult('from and to must be ISO dates', true)
        return g.calendarList(
          from,
          to,
          String(args.calendar ?? 'primary') || 'primary',
          clamp(Number(args.max) || 50, 1, 250),
        )
      },
    },
    {
      name: 'calendar_create_event',
      description:
        'Create a calendar event (start/end as ISO date-times, or dates for all-day). Attendees are added without emailing invitations.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          description: { type: 'string' },
          location: { type: 'string' },
          attendees: { type: 'array', items: { type: 'string' } },
          calendar: { type: 'string', description: 'default primary' },
          timezone: { type: 'string', description: "IANA zone, default the machine's" },
        },
        required: ['title', 'start', 'end'],
      },
      run: (args) => {
        const title = String(args.title ?? '').trim()
        const start = String(args.start ?? '').trim()
        const end = String(args.end ?? '').trim()
        if (!title || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)))
          return textResult('title, start and end (ISO) are required', true)
        return g.calendarCreate({
          title,
          start,
          end,
          description: typeof args.description === 'string' ? args.description : undefined,
          location: typeof args.location === 'string' ? args.location : undefined,
          attendees: asArray(args.attendees).map(String).filter(Boolean),
          calendar: String(args.calendar ?? 'primary') || 'primary',
          timezone: typeof args.timezone === 'string' && args.timezone ? args.timezone : undefined,
        })
      },
    },
    {
      name: 'calendar_free_slots',
      description:
        "Find free slots of a given length on workdays within a date range, from the calendar's busy times.",
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          duration_minutes: { type: 'integer', description: 'default 60' },
          calendar: { type: 'string', description: 'default primary' },
          workday_start: { type: 'string', description: 'HH:MM, default 09:00' },
          workday_end: { type: 'string', description: 'HH:MM, default 17:00' },
          max: { type: 'integer', description: 'default 10' },
        },
        required: ['from', 'to'],
      },
      run: (args) => {
        const from = String(args.from ?? '').trim()
        const to = String(args.to ?? '').trim()
        if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
          return textResult('from and to must be ISO dates', true)
        const hhmm = (v: unknown, d: string) =>
          typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v) ? v : d
        return g.freeSlots({
          from,
          to,
          durationMin: clamp(Number(args.duration_minutes) || 60, 5, 8 * 60),
          calendar: String(args.calendar ?? 'primary') || 'primary',
          dayStart: hhmm(args.workday_start, '09:00'),
          dayEnd: hhmm(args.workday_end, '17:00'),
          max: clamp(Number(args.max) || 10, 1, 50),
        })
      },
    },
  ]
  return { name: 'google', version: '1.0.0', tools }
}
