import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createBlankPptx, templateToPresentation, openPptx } from '../src'

async function asTemplate(macro: boolean): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  let ct = await zip.file('[Content_Types].xml')!.async('string')
  ct = ct.replace(
    'presentationml.presentation.main+xml',
    macro
      ? 'presentationml.template.macroEnabledTemplate.main+xml'
      : 'presentationml.template.main+xml',
  )
  if (macro) {
    ct = ct.replace('</Types>', '<Override PartName="/ppt/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>')
    zip.file('ppt/vbaProject.bin', 'x')
  }
  zip.file('[Content_Types].xml', ct)
  return zip.generateAsync({ type: 'uint8array' })
}

describe('templateToPresentation', () => {
  for (const macro of [false, true]) {
    it(`rewrites the content type (macro=${macro}) and still opens`, async () => {
      const out = await templateToPresentation(await asTemplate(macro))
      const zip = await JSZip.loadAsync(out)
      const ct = await zip.file('[Content_Types].xml')!.async('string')
      expect(ct).toContain('presentationml.presentation.main+xml')
      expect(ct).not.toContain('template')
      expect(ct).not.toContain('vbaProject')
      expect(zip.file('ppt/vbaProject.bin')).toBeNull()
      await expect(openPptx(out)).resolves.toBeTruthy()
    })
  }
  it('rejects non-PowerPoint packages', async () => {
    const z = new JSZip()
    z.file('[Content_Types].xml', '<Types/>')
    await expect(
      templateToPresentation(await z.generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow()
  })
})
