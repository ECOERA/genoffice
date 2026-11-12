// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, app: {}, net: {}, session: {} }))

const { pdfNameFromResponse, safePdfName, sniff } = await import('../src/main/url-open/fetch-url')
const { isLocalAddress, resolveDestination } = await import('../src/main/url-open/network-guard')

describe('open from URL: file names', () => {
  it('cleans names and always ends in .pdf', () => {
    expect(safePdfName('Report: Q3/Q4?', 'example.com')).toBe('Report Q3 Q4.pdf')
    expect(safePdfName('paper.PDF', 'x')).toBe('paper.PDF')
    expect(safePdfName('', 'example.com')).toBe('example.com.pdf')
    expect(safePdfName('CON', 'x')).toBe('CON_.pdf')
  })

  it('prefers Content-Disposition, then the last path segment', () => {
    const url = new URL('https://example.com/files/annual%20report.pdf?x=1')
    expect(pdfNameFromResponse(url, 'attachment; filename="Summary.pdf"')).toBe('Summary.pdf')
    expect(pdfNameFromResponse(url, "attachment; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf")).toBe(
      'Résumé.pdf',
    )
    expect(pdfNameFromResponse(url, undefined)).toBe('annual report.pdf')
    expect(pdfNameFromResponse(new URL('https://example.com/'), undefined)).toBe('example.com.pdf')
  })

  it('recognizes PDFs and unlabeled HTML by their first bytes', () => {
    expect(sniff(Buffer.from('%PDF-1.7\n...'))).toBe('pdf')
    expect(sniff(Buffer.from('  <!DOCTYPE html><html>'))).toBe('html')
    expect(sniff(Buffer.from('PK\u0003\u0004'))).toBe('other')
  })
})

describe('open from URL: local addresses', () => {
  it('treats loopback, private and link-local ranges as local', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.1.1', '::1']) {
      expect(isLocalAddress(ip), ip).toBe(true)
    }
    for (const ip of ['93.184.216.34', '2606:4700::1111']) {
      expect(isLocalAddress(ip), ip).toBe(false)
    }
  })

  it('flags local host names without resolving them', async () => {
    const resolver = {
      resolveHost: vi.fn(async () => ({ endpoints: [{ address: '93.184.216.34' }] })),
    }
    const dest = await resolveDestination(new URL('http://printer.local/'), resolver as never)
    expect(dest.local).toBe(true)
    const pub = await resolveDestination(new URL('https://example.com/a.pdf'), resolver as never)
    expect(pub).toMatchObject({ origin: 'https://example.com', local: false })
  })
})
