import JSZip from 'jszip'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const DOCUMENT = 'word/document.xml'
/** A runaway document must not be taken apart forever. */
const MAX_SPLITS_PER_PARAGRAPH = 500

function breaksIn(paragraph: Element): Element[] {
  return Array.from(paragraph.getElementsByTagNameNS(W, 'lastRenderedPageBreak'))
}

/**
 * Cut one paragraph at each page break it carries, so every piece ends with a
 * real page break of its own.
 */
function splitParagraph(paragraph: Element): void {
  let current = paragraph
  for (let split = 0; split < MAX_SPLITS_PER_PARAGRAPH; split++) {
    const marker = breaksIn(current)[0]
    if (!marker || !current.lastChild) return
    const doc = current.ownerDocument

    // Everything after the break becomes the next paragraph. A range is what
    // does the work: the break sits deep inside a run, and extracting through
    // it splits the runs around it exactly as Word's own layout did.
    const range = doc.createRange()
    range.setStartAfter(marker)
    range.setEndAfter(current.lastChild)
    const tail = range.extractContents()

    // The break Word only recorded becomes one the renderer acts on.
    const pageBreak = doc.createElementNS(W, 'w:br')
    pageBreak.setAttributeNS(W, 'w:type', 'page')
    marker.replaceWith(pageBreak)

    if (!tail.firstElementChild) return
    const next = doc.createElementNS(W, 'w:p')
    const props = current.firstElementChild
    if (props?.localName === 'pPr') next.appendChild(props.cloneNode(true))
    next.appendChild(tail)
    current.after(next)
    current = next
  }
}

/**
 * How far each drawing in the document is turned, in degrees, in document
 * order. Word keeps a picture's rotation in the drawing's transform rather than
 * in the image itself, so a photo shot sideways and straightened in Word is
 * stored still-sideways — a renderer that ignores the transform shows it lying
 * on its side.
 */
function readRotations(xml: Document): number[] {
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  return Array.from(xml.getElementsByTagNameNS(W, 'drawing')).map((drawing) => {
    const transform = Array.from(drawing.getElementsByTagNameNS(A, 'xfrm')).find((x) =>
      x.hasAttribute('rot')
    )
    // Stored in sixtieths of a degree.
    const rot = Number.parseInt(transform?.getAttribute('rot') ?? '0', 10)
    return Number.isFinite(rot) ? (((rot / 60000) % 360) + 360) % 360 : 0
  })
}

export interface PreparedDocx {
  bytes: ArrayBuffer
  /** Degrees of rotation per drawing, in document order. */
  rotations: number[]
}

/**
 * Prepare a .docx for rendering: one page break per paragraph, plus the picture
 * rotations the renderer does not read for itself.
 *
 * Word records where it last broke the pages inside the paragraphs themselves,
 * and one paragraph can carry many of them — a page of notes followed by
 * fifteen photos is a single paragraph with fifteen page breaks in it. Renderers
 * split a paragraph at its first break only, so such a document collapses into
 * one enormous page. Moving each break to the end of a paragraph of its own
 * gives the renderer Word's pagination in the form it can act on; the content
 * itself is untouched.
 */
export async function prepareDocx(bytes: ArrayBuffer): Promise<PreparedDocx> {
  const zip = await JSZip.loadAsync(bytes)
  const part = zip.file(DOCUMENT)
  if (!part) return { bytes, rotations: [] }

  const xml = new DOMParser().parseFromString(await part.async('string'), 'application/xml')
  const rotations = readRotations(xml)
  // Snapshot first: splitting inserts paragraphs, and the live list would grow
  // under the loop.
  const paragraphs = Array.from(xml.getElementsByTagNameNS(W, 'p'))
  const carryingBreaks = paragraphs.filter((p) => breaksIn(p).length > 0)
  if (carryingBreaks.length === 0) return { bytes, rotations }
  for (const paragraph of carryingBreaks) splitParagraph(paragraph)

  zip.file(DOCUMENT, new XMLSerializer().serializeToString(xml))
  // Stored, not deflated: the bulk of a photo-heavy file is already-compressed
  // images, and re-deflating megabytes of them would stall the viewer.
  const prepared = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
  return { bytes: prepared, rotations }
}

/**
 * Wait for the rendered pictures, since an image has no height until it has
 * decoded — but never for longer than `timeoutMs`.
 *
 * A browser is free to defer decoding while nothing is being painted, so in a
 * background tab these promises can stay pending indefinitely. The document
 * must appear either way; a late decode only means the fallback pagination
 * measures again when it lands.
 */
export function settleImages(root: HTMLElement, timeoutMs = 3000): Promise<unknown> {
  const images = Array.from(root.querySelectorAll('img'))
  if (images.length === 0) return Promise.resolve()
  const decoded = Promise.all(images.map((image) => image.decode().catch(() => {})))
  return Promise.race([decoded, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
}

/**
 * Give pages to a document that has never been through Word.
 *
 * Pagination comes from the breaks Word recorded, so a file written by a
 * generator — an exported report, anything not saved by Word itself — has none
 * and renders as one endless sheet. Only then is the overlong sheet cut into
 * page-height ones. A document that carries its own pagination never reaches
 * this, so nothing Word decided is ever second-guessed.
 */
export function paginateUnbrokenSections(root: HTMLElement): void {
  for (const section of Array.from(root.querySelectorAll<HTMLElement>('section.docx'))) {
    const style = getComputedStyle(section)
    // Computed, not the inline value: the renderer writes the page size in
    // points and everything measured here is in pixels.
    const pageHeight = Number.parseFloat(style.minHeight)
    if (!pageHeight || section.offsetHeight <= pageHeight + 1) continue

    // The flow sits inside the section's own wrapper; descend to the level
    // whose children are the document's blocks.
    const chain: HTMLElement[] = []
    let holder = section
    while (holder.children.length === 1) {
      holder = holder.children[0] as HTMLElement
      chain.push(holder)
    }
    const blocks = Array.from(holder.children) as HTMLElement[]
    if (blocks.length < 2) continue

    const limit =
      pageHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)
    const pages: HTMLElement[][] = [[]]
    let pageTop = 0

    for (const block of blocks) {
      const current = pages[pages.length - 1]
      if (current.length === 0) pageTop = block.offsetTop
      else if (block.offsetTop + block.offsetHeight - pageTop > limit) {
        pages.push([])
        pageTop = block.offsetTop
      }
      pages[pages.length - 1].push(block)
    }

    // Each sheet is a copy of the section's own shell, so it keeps the paper
    // size, margins and styling the renderer gave it.
    section.replaceWith(
      ...pages.map((page) => {
        const sheet = section.cloneNode(false) as HTMLElement
        let cursor = sheet
        for (const level of chain) {
          const clone = level.cloneNode(false) as HTMLElement
          cursor.appendChild(clone)
          cursor = clone
        }
        for (const block of page) cursor.appendChild(block)
        return sheet
      })
    )
  }
}

/**
 * Turn each rendered picture the way Word turns it.
 *
 * A rotated picture also occupies a different footprint than its own box — a
 * quarter turn swaps width for height — so the image is placed inside a holder
 * of the size the page expects and rotated within it, instead of overflowing
 * onto the text around it.
 */
export function applyRotations(root: HTMLElement, rotations: number[]): void {
  Array.from(root.querySelectorAll('img')).forEach((image, i) => {
    const degrees = rotations[i] ?? 0
    // Already turned by an earlier pass over this same render.
    if (degrees === 0 || image.parentElement?.dataset.docxRotated) return
    // The layout box, not getBoundingClientRect: that one reports the box the
    // rotation produces, which is the very thing being computed here.
    const width = image.offsetWidth
    const height = image.offsetHeight
    if (width === 0 || height === 0) return
    const quarterTurn = degrees === 90 || degrees === 270

    const holder = document.createElement('span')
    holder.dataset.docxRotated = String(degrees)
    holder.style.display = 'inline-block'
    holder.style.position = 'relative'
    holder.style.width = `${quarterTurn ? height : width}px`
    holder.style.height = `${quarterTurn ? width : height}px`

    image.replaceWith(holder)
    holder.appendChild(image)
    image.style.position = 'absolute'
    // The holder is the turned footprint and so is narrower than the picture
    // itself; without this the stylesheet's max-width would squeeze the picture
    // to fit it and flatten the aspect ratio.
    image.style.maxWidth = 'none'
    image.style.maxHeight = 'none'
    image.style.left = '50%'
    image.style.top = '50%'
    image.style.transform = `translate(-50%, -50%) rotate(${degrees}deg)`
  })
}
