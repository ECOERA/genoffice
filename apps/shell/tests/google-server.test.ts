import { describe, expect, it } from 'vitest'
import {
  bodyOf,
  buildRawMessage,
  CALENDAR_SCOPES,
  createGoogleServer,
  GMAIL_SCOPES,
  GoogleTools,
  REAUTH_HINT,
} from '../src/main/hosted/google'

/** Mail and calendar tools against a fake Gmail / Calendar API (fetch injected). */

type Call = { url: string; method: string; auth: string | undefined; body: unknown }

function fakeFetch(calls: Call[], fail?: { status: number; message: string }): typeof fetch {
  const b64url = (s: string) =>
    Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  return async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      auth: headers.get('authorization') ?? undefined,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    if (fail) return json(fail.status, { error: { message: fail.message } })
    if (url.includes('/messages?q='))
      return json(200, { messages: [{ id: 'm1' }, { id: 'm2' }], resultSizeEstimate: 2 })
    if (
      url.includes('/messages/m1?format=metadata') ||
      url.includes('/messages/m2?format=metadata')
    ) {
      const id = url.includes('m1') ? 'm1' : 'm2'
      return json(200, {
        id,
        snippet: `snippet ${id}`,
        payload: {
          headers: [
            { name: 'From', value: 'palle@example.org' },
            { name: 'Subject', value: `Hello ${id}` },
            { name: 'Date', value: 'Mon, 22 Sep 2026 10:00:00 +0200' },
          ],
        },
      })
    }
    if (url.includes('/messages/m1?format=full')) {
      return json(200, {
        id: 'm1',
        threadId: 't1',
        payload: {
          headers: [
            { name: 'From', value: 'palle@example.org' },
            { name: 'To', value: 'david@example.org' },
            { name: 'Subject', value: 'Hello m1' },
            { name: 'Message-Id', value: '<abc@mail>' },
          ],
          mimeType: 'multipart/mixed',
          parts: [
            {
              mimeType: 'text/html',
              body: { data: b64url('<p>Hej <b>David</b>,</p><p>MRV-rapporten &amp; bilagan.</p>') },
            },
            { mimeType: 'application/pdf', filename: 'rapport.pdf', body: { size: 204800 } },
          ],
        },
      })
    }
    if (url.endsWith('/drafts')) return json(200, { id: 'd1' })
    if (url.includes('/events?timeMin')) {
      return json(200, {
        timeZone: 'Europe/Stockholm',
        items: [
          {
            id: 'e1',
            summary: 'Standup',
            start: { dateTime: '2026-09-23T09:00:00+02:00' },
            end: { dateTime: '2026-09-23T09:30:00+02:00' },
            attendees: [{}, {}],
          },
          {
            id: 'e2',
            summary: 'Field day',
            start: { date: '2026-09-24' },
            end: { date: '2026-09-25' },
            location: 'Falkenberg',
          },
        ],
      })
    }
    if (url.includes('/events?sendUpdates=none'))
      return json(200, {
        id: 'e3',
        summary: 'Planning',
        htmlLink: 'https://calendar.google.com/e3',
      })
    if (url.endsWith('/freeBusy')) {
      return json(200, {
        calendars: {
          primary: {
            busy: [
              { start: '2026-09-23T07:00:00Z', end: '2026-09-23T09:00:00Z' },
              { start: '2026-09-23T11:00:00Z', end: '2026-09-23T14:00:00Z' },
            ],
          },
        },
      })
    }
    return json(404, { error: { message: `no route ${url}` } })
  }
}

function tools(
  calls: Call[],
  scopes: string[] = [...GMAIL_SCOPES, ...CALENDAR_SCOPES],
  fail?: { status: number; message: string },
) {
  const g = new GoogleTools({
    token: async () => 'tok',
    scopes: () => scopes,
    fetchImpl: fakeFetch(calls, fail),
    gmailBase: 'http://fake/gmail',
    calendarBase: 'http://fake/cal',
    timezone: 'Europe/Stockholm',
  })
  const defs = createGoogleServer(g).tools
  const ctx = { env: {}, log: () => {} }
  return (name: string, args: Record<string, unknown>) =>
    defs.find((t) => t.name === name)!.run(args, ctx)
}

describe('helpers', () => {
  it('extracts text and attachments from a payload and builds RFC 2822 drafts', () => {
    const { text, attachments } = bodyOf({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/html', body: { data: Buffer.from('<p>Hi</p>').toString('base64') } },
        { mimeType: 'image/png', filename: 'a.png', body: { size: 2048 } },
      ],
    })
    expect(text).toBe('Hi')
    expect(attachments).toEqual(['a.png (2 KB)'])
    const raw = Buffer.from(
      buildRawMessage({ to: 'p@x.org', subject: 'Möte', body: 'Hej!', inReplyTo: '<abc@mail>' })
        .replace(/-/g, '+')
        .replace(/_/g, '/'),
      'base64',
    ).toString()
    expect(raw).toContain('To: p@x.org')
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('Möte').toString('base64')}?=`)
    expect(raw).toContain('In-Reply-To: <abc@mail>')
    expect(raw).toContain(Buffer.from('Hej!').toString('base64'))
  })
})

describe('google MCP tools', () => {
  it('searches and reads mail, saves drafts without sending', async () => {
    const calls: Call[] = []
    const run = tools(calls)
    const search = String(await run('gmail_search', { query: 'from:palle newer_than:7d', max: 2 }))
    expect(search).toContain('Messages matching "from:palle newer_than:7d" (about 2 in total):')
    expect(search).toContain('palle@example.org | Hello m1 | id m1')
    expect(search).toContain('snippet m2')
    expect(calls[0]!.auth).toBe('Bearer tok')
    expect(calls[0]!.url).toContain('/messages?q=from%3Apalle%20newer_than%3A7d&maxResults=2')
    const read = String(await run('gmail_read', { id: 'm1' }))
    expect(read).toContain('From: palle@example.org')
    expect(read).toContain('Thread: t1 · Message-Id: <abc@mail>')
    expect(read).toContain('Attachments: rapport.pdf (200 KB)')
    expect(read).toContain('Hej David,\nMRV-rapporten & bilagan.')
    const draft = String(
      await run('gmail_draft', {
        to: 'palle@example.org',
        subject: 'Re: Hello',
        body: 'Tack!',
        thread_id: 't1',
        in_reply_to: '<abc@mail>',
      }),
    )
    expect(draft).toContain('Draft saved in Gmail (draft id d1)')
    expect(draft).toContain('not sent')
    const post = calls.at(-1)!
    expect(post.method).toBe('POST')
    expect(post.url).toBe('http://fake/gmail/drafts')
    expect((post.body as { message: { threadId: string; raw: string } }).message.threadId).toBe(
      't1',
    )
    expect(calls.some((c) => c.url.includes('/send'))).toBe(false)
  })

  it('lists and creates calendar events and finds free slots', async () => {
    const calls: Call[] = []
    const run = tools(calls)
    const list = String(await run('calendar_list', { from: '2026-09-23', to: '2026-09-26' }))
    expect(list).toContain('Events in primary (Europe/Stockholm):')
    expect(list).toContain(
      '2026-09-23T09:00:00+02:00 → 2026-09-23T09:30:00+02:00 | Standup · 2 attendees | id e1',
    )
    expect(list).toContain('2026-09-24 (all day) | Field day @ Falkenberg | id e2')
    const created = String(
      await run('calendar_create_event', {
        title: 'Planning',
        start: '2026-09-25T13:00:00',
        end: '2026-09-25T14:00:00',
        attendees: ['palle@example.org'],
      }),
    )
    expect(created).toContain('Event created: Planning')
    expect(created).toContain('Invitations were not emailed')
    const post = calls.at(-1)!
    expect(post.url).toContain('/calendars/primary/events?sendUpdates=none')
    expect(post.body).toMatchObject({
      summary: 'Planning',
      start: { dateTime: '2026-09-25T13:00:00', timeZone: 'Europe/Stockholm' },
      attendees: [{ email: 'palle@example.org' }],
    })
    const slots = String(
      await run('calendar_free_slots', {
        from: '2026-09-23T00:00:00+02:00',
        to: '2026-09-24T00:00:00+02:00',
        duration_minutes: 60,
      }),
    )
    // busy 09:00–11:00 and 13:00–16:00 local; workday 09–17 → free 11:00–13:00 and 16:00–17:00
    expect(slots).toContain('Free 60-minute slots (Europe/Stockholm, workdays 09:00–17:00)')
    expect(slots).toMatch(/11:00 – .*12:00/)
    expect(slots).toMatch(/16:00 – .*17:00/)
    expect(slots).not.toMatch(/09:00 – /)
  })

  it('explains missing scopes and API errors', async () => {
    const calls: Call[] = []
    const noScopes = tools(calls, ['https://www.googleapis.com/auth/drive'])
    expect(String(await noScopes('gmail_search', { query: 'x' }))).toBe(REAUTH_HINT)
    expect(String(await noScopes('calendar_list', { from: '2026-01-01', to: '2026-01-02' }))).toBe(
      REAUTH_HINT,
    )
    const failing = tools([], [], {
      status: 403,
      message:
        'Gmail API has not been used in project 123 before or it is disabled. Enable it by visiting …',
    })
    await expect(failing('gmail_search', { query: 'x' })).rejects.toThrow(
      /Enable the API in the Google Cloud project/,
    )
    const insufficient = tools([], [], {
      status: 403,
      message: 'Request had insufficient authentication scopes.',
    })
    await expect(
      insufficient('calendar_list', { from: '2026-01-01', to: '2026-01-02' }),
    ).rejects.toThrow(new RegExp(REAUTH_HINT.slice(0, 20)))
  })
})
