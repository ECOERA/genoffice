/**
 * Mermaid renderer for the hidden diagram window (main/diagram-window.ts
 * calls window.renderDiagram through executeJavaScript). Renders the
 * diagram to SVG, then rasterises it on a canvas so the result is a PNG the
 * editors can insert. htmlLabels is off: foreignObject labels would taint
 * the canvas and block toDataURL.
 */
import mermaid from 'mermaid'

export interface RenderedDiagram {
  /** base64 PNG */
  png: string
  svg: string
  width: number
  height: number
}

const THEMES = new Set(['default', 'neutral', 'dark', 'forest', 'base'])

async function renderDiagram(code: string, theme: string, scale: number): Promise<RenderedDiagram> {
  mermaid.initialize({
    startOnLoad: false,
    theme: (THEMES.has(theme) ? theme : 'default') as 'default',
    securityLevel: 'strict',
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    flowchart: { htmlLabels: false },
    sequence: { useMaxWidth: false },
    gantt: { useMaxWidth: false },
  })
  const holder = document.createElement('div')
  document.body.appendChild(holder)
  try {
    const { svg } = await mermaid.render(`d${Date.now()}`, code)
    holder.innerHTML = svg
    const el = holder.querySelector('svg')
    if (!el) throw new Error('mermaid produced no SVG')
    const box = el.viewBox.baseVal
    const rect = el.getBoundingClientRect()
    const width = Math.ceil(box.width || rect.width || 800)
    const height = Math.ceil(box.height || rect.height || 600)
    el.setAttribute('width', String(width))
    el.setAttribute('height', String(height))
    el.removeAttribute('style')
    if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const xml = new XMLSerializer().serializeToString(el)
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('the SVG could not be rasterised'))
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(width * scale)
    canvas.height = Math.ceil(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0)
    const png = canvas.toDataURL('image/png').split(',')[1] ?? ''
    return { png, svg: xml, width, height }
  } finally {
    holder.remove()
  }
}

declare global {
  interface Window {
    renderDiagram: typeof renderDiagram
  }
}
window.renderDiagram = renderDiagram
