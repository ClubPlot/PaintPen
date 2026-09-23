import {
  DEFAULT_PEN, DSC, HPGL, PENS, PLOT_HEIGHT, PLOT_WIDTH, PLOTTER_UNITS_PER_CM,
  type Point,
} from './plot.ts'

/* 640 x 480: the shape of the plotting area, and the screen MS Paint grew up
   on. Canvas pixels are the drawing's own unit system — everything is kept in
   them and converted to plotter units only on the way out. */
const CANVAS_W = 640
const CANVAS_H = 480

/* A period plotter's input buffer is around a kilobyte, so a polyline goes out
   as several short instructions rather than one long one. */
const MAX_PAIRS_PER_MESSAGE = 24

/* Freehand samples closer together than this cost plotter traffic without
   adding ink a pen could resolve — 2 px is 31 plotter units, well under a
   0.3 mm nib. */
const MIN_SEND_DISTANCE = 2

/* Text. The plotter's stick font is fixed-pitch and sized in centimetres by
   `SI`; it then advances 1.5x that width between characters and 2x that height
   between baselines. The canvas lays labels out on the same two multiples, so
   the box you type into stands where the ink will go. Width is held at 0.7 of
   height, the proportion of the plotter's own default cell. */
const CHAR_ASPECT = 0.7
const CHAR_ADVANCE = 1.5 * CHAR_ASPECT
const LINE_ADVANCE = 2

/* The keys that would move the caret off the end of a live label. */
const CARET_KEYS = /^(Arrow|Home$|End$|Page)/

/* Character heights the text tool offers, in canvas pixels. */
const TEXT_SIZES = [8, 12, 18, 26]
const DEFAULT_TEXT_SIZE = 12

/* A browser's monospace face stands in for the stick font. Capitals in it run
   about 0.72em, which is all this ratio is for: turning a character height
   into a font-size for the preview. The plotter is told centimetres. */
const CAP_RATIO = 0.72
const TEXT_FONT = 'monospace'
const fontFor = (size: number) => `${size / CAP_RATIO}px ${TEXT_FONT}`

const CM_PER_PIXEL = PLOT_WIDTH / CANVAS_W / PLOTTER_UNITS_PER_CM

/** How a stroke is sent, and where its progress is reported. */
export interface PaintPort {
  /** `quiet` keeps the per-frame freehand batches out of the log. */
  send(data: string, quiet?: boolean): void
  note(text: string): void
  isLive(): boolean
}

type Stroke =
  | { tool: 'pencil', pen: number, points: Point[] }
  | { tool: 'line' | 'rect' | 'ellipse', pen: number, from: Point, to: Point }
  /* `at` is the top-left of the first character's cell, so a label reads like
     any other box on screen; the baseline `LB` needs is derived from it. */
  | { tool: 'text', pen: number, at: Point, size: number, lines: string[] }

type ToolId = Stroke['tool']

/** Where a label starts and how tall its characters are. */
type LabelBox = { at: Point, size: number }

const icon = (body: string) =>
  `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">${body}</svg>`

/* The 16 tools of the real toolbox, in their row-major order. Five of them
   have an honest HP-GL equivalent; the rest are drawn but inert rather than
   silently doing something the plotter cannot reproduce. */
const TOOLS: { id: string, name: string, svg: string, tool?: ToolId, why?: string }[] = [
  { id: 'freeselect', name: 'Free-Form Select', why: 'nothing to select — strokes leave as they are drawn', svg: icon(`<path d="M3 9c-1-4 3-7 6-5s6 5 3 8-8 2-9-3z" stroke-dasharray="2 1.5"/>`) },
  { id: 'select', name: 'Select', why: 'nothing to select — strokes leave as they are drawn', svg: icon(`<rect x="2.5" y="3.5" width="11" height="9" stroke-dasharray="2 1.5"/>`) },
  { id: 'eraser', name: 'Eraser', why: 'ink already on paper cannot be recalled', svg: icon(`<path d="M2 12l5-5 4 4-2 2H3z"/><path d="M7 7l3-3 4 4-3 3"/>`) },
  { id: 'fill', name: 'Fill With Color', why: 'a pen fills by hatching — not implemented', svg: icon(`<path d="M7 2l6 6-5 5-6-6z"/><path d="M13 10c1 1.5 1.5 2.3 1.5 3a1.5 1.5 0 1 1-3 0c0-.7.5-1.5 1.5-3z"/>`) },
  { id: 'pick', name: 'Pick Color', why: 'pick a pen from the carousel below instead', svg: icon(`<path d="M11 2l3 3-7 7-3 1 1-3z"/>`) },
  { id: 'magnify', name: 'Magnifier', why: 'the canvas is fixed at 640 x 480', svg: icon(`<circle cx="7" cy="7" r="4"/><path d="M10 10l4 4"/>`) },
  { id: 'pencil', name: 'Pencil', tool: 'pencil', svg: icon(`<path d="M2 14l1-3 8-8 2 2-8 8z"/><path d="M10 4l2 2"/>`) },
  { id: 'brush', name: 'Brush', why: 'a wide nib means repeated offset passes — not implemented', svg: icon(`<path d="M3 13c2 0 3-1 3-2s-1-2-2-2-2 1-2 2 0 2 1 2z"/><path d="M6 10l7-7 1 1-7 7"/>`) },
  { id: 'airbrush', name: 'Airbrush', why: 'stippling is not implemented', svg: icon(`<path d="M4 12V7h4v5z"/><path d="M8 8l3-2"/><circle cx="13" cy="4" r=".6" fill="currentColor"/><circle cx="11" cy="7" r=".6" fill="currentColor"/><circle cx="14" cy="8" r=".6" fill="currentColor"/>`) },
  { id: 'text', name: 'Text', tool: 'text', svg: icon(`<path d="M3 4V2.5h10V4M8 2.5v11M5.5 13.5h5"/>`) },
  { id: 'line', name: 'Line', tool: 'line', svg: icon(`<path d="M2.5 13.5L13.5 2.5"/>`) },
  { id: 'curve', name: 'Curve', why: 'no control points yet', svg: icon(`<path d="M2.5 13.5C3 6 7 2.5 13.5 2.5"/>`) },
  { id: 'rect', name: 'Rectangle', tool: 'rect', svg: icon(`<rect x="2.5" y="4.5" width="11" height="7"/>`) },
  { id: 'polygon', name: 'Polygon', why: 'no click-to-click sequence yet', svg: icon(`<path d="M8 2.5l5.5 4-2 6.5h-7l-2-6.5z"/>`) },
  { id: 'ellipse', name: 'Ellipse', tool: 'ellipse', svg: icon(`<ellipse cx="8" cy="8" rx="5.5" ry="4"/>`) },
  { id: 'roundrect', name: 'Rounded Rectangle', why: 'not implemented', svg: icon(`<rect x="2.5" y="4.5" width="11" height="7" rx="2.5"/>`) },
]

type MenuItem = { label: string, action?: string, accel?: string, separator?: never }
  | { separator: true, label?: never, action?: never, accel?: never }

/* Everything the real Paint offers is listed; only what this app can honestly
   do is enabled. The last menu is ours. */
const MENUS: { name: string, items: MenuItem[] }[] = [
  {
    name: 'File', items: [
      { label: 'New', action: 'new', accel: 'Ctrl+N' },
      { label: 'Open...' }, { label: 'Save' }, { label: 'Save As...' },
      { separator: true },
      { label: 'Print...' },
    ]
  },
  {
    name: 'Edit', items: [
      { label: 'Undo', action: 'undo', accel: 'Ctrl+Z' },
      { label: 'Repeat' },
      { separator: true },
      { label: 'Cut' }, { label: 'Copy' }, { label: 'Paste' },
    ]
  },
  {
    name: 'View', items: [
      { label: 'Tool Box' }, { label: 'Color Box' }, { label: 'Status Bar' },
    ]
  },
  {
    name: 'Image', items: [
      { label: 'Clear Image', action: 'new' },
      { label: 'Flip/Rotate...' }, { label: 'Attributes...' },
    ]
  },
  {
    name: 'Colors', items: [{ label: 'Edit Colors...' }]
  },
  {
    name: 'Plotter', items: [
      { label: 'Initialize', action: 'initialize' },
      { label: 'Pen Up', action: 'penup' },
      { separator: true },
      { label: 'Replot Canvas', action: 'replot' },
      { separator: true },
      { label: 'Identify Device', action: 'identify' },
      { label: 'Report Position', action: 'position' },
    ]
  },
  {
    name: 'Help', items: [{ label: 'Help Topics' }, { label: 'About Paint' }]
  },
]

/* The pane rests empty; the tools fill it while they are being used. */
const DEFAULT_HINT = ''

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

/** Canvas pixels to plotter units, flipping Y onto HP-GL's bottom-left origin. */
function toPlotter({ x, y }: Point): Point {
  return {
    x: Math.round(clamp(x, 0, CANVAS_W) / CANVAS_W * PLOT_WIDTH),
    y: Math.round((1 - clamp(y, 0, CANVAS_H) / CANVAS_H) * PLOT_HEIGHT),
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** An ellipse as a closed polyline — HP-GL's `CI` only draws true circles. */
function ellipsePoints(a: Point, b: Point, steps = 72): Point[] {
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2
  const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = i / steps * 2 * Math.PI
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
  })
}

/** Baseline of a label's nth line, in canvas pixels. */
const baselineOf = ({ at, size }: LabelBox, line: number) =>
  at.y + size + line * size * LINE_ADVANCE

/** A whole stroke as instructions, pen selection aside. */
function instructionsFor(stroke: Stroke): string[] {
  if (stroke.tool === 'text') {
    const height = stroke.size * CM_PER_PIXEL
    /* A `PU` per line rather than `CR`/`LF` inside one label: where the
       plotter returns to is state of its own, and this way every line starts
       at the pixel the canvas shows it starting at. Blank lines are skipped
       but still count, since the baseline comes from the line's index. */
    return [
      HPGL.characterSize(height * CHAR_ASPECT, height),
      ...stroke.lines.flatMap((line, index) => line.trim() ? [
        HPGL.moveTo(toPlotter({ x: stroke.at.x, y: baselineOf(stroke, index) })),
        HPGL.label(line),
      ] : []),
      HPGL.PenUp,
    ]
  }

  if (stroke.tool === 'rect') {
    /* `EA` needs the pen parked at one corner; it draws the other three sides
       itself and leaves the pen up. */
    return [HPGL.moveTo(toPlotter(stroke.from)), HPGL.edgeRectangle(toPlotter(stroke.to))]
  }

  const path = stroke.tool === 'pencil' ? stroke.points
    : stroke.tool === 'line' ? [stroke.from, stroke.to]
      : ellipsePoints(stroke.from, stroke.to)

  const [first, ...rest] = path.map(toPlotter)
  return [
    HPGL.moveTo(first), HPGL.PenDown,
    ...chunk(rest, MAX_PAIRS_PER_MESSAGE).map(HPGL.plotAbsolute),
    HPGL.PenUp,
  ]
}

export function mountPaint(host: HTMLElement, port: PaintPort) {
  host.innerHTML = `
<div class="paint">
  <div class="titlebar">
    <span class="title-icon">${icon(`<path d="M3 13l1-3 7-7 2 2-7 7z"/><path d="M10 5l2 2"/>`)}</span>
    <span class="title-text">Paint Pen</span>
    <span class="title-buttons">
      <button type="button" data-window="collapse" title="Minimize"><i>_</i></button>
    </span>
  </div>

  <div class="menubar">
    ${MENUS.map(({ name, items }) => `
      <div class="menu">
        <button type="button" class="menu-title" data-menu="${name}">${name}</button>
        <div class="dropdown" hidden>
          ${items.map((item) => item.separator ? `<hr />` : `
            <button type="button" class="menu-item" ${item.action ? `data-action="${item.action}"` : 'disabled'}>
              <span>${item.label}</span><span class="accel">${item.accel ?? ''}</span>
            </button>`).join('')}
        </div>
      </div>`).join('')}
  </div>

  <div class="workspace">
    <div class="toolbox">
      <div class="tools">
        ${TOOLS.map(({ id, name, svg, tool, why }) => `
          <button type="button" class="tool" data-tool="${tool ?? ''}" data-id="${id}"
                  ${tool ? '' : 'disabled'} title="${name}${why ? ` — ${why}` : ''}">${svg}</button>`).join('')}
      </div>
      <div class="tool-options"></div>
    </div>
    <div class="canvas-well">
      <canvas width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
    </div>
  </div>

  <div class="palette">
    <div class="current" title="Current pen over paper">
      <span class="swatch-fg"></span><span class="swatch-bg"></span>
    </div>
    <div class="swatches">
      ${PENS.map(({ name, color }, index) => `
        <button type="button" class="swatch" data-pen="${index}"
                style="--ink:${color}" title="Pen ${index + 1} — ${name} (SP${index + 1})"></button>`).join('')}
    </div>
    <span class="palette-note">8-pen carousel</span>
  </div>

  <div class="statusbar">
    <span class="pane hint">${DEFAULT_HINT}</span>
    <span class="pane coords"></span>
    <span class="pane plu"></span>
    <span class="pane pen"></span>
  </div>
</div>`

  const root = host.querySelector<HTMLDivElement>('.paint')!
  const canvas = host.querySelector('canvas')!
  const context = canvas.getContext('2d')!
  const hint = host.querySelector<HTMLSpanElement>('.hint')!
  const coords = host.querySelector<HTMLSpanElement>('.coords')!
  const plu = host.querySelector<HTMLSpanElement>('.plu')!
  const penPane = host.querySelector<HTMLSpanElement>('.pen')!
  const toolOptions = host.querySelector<HTMLDivElement>('.tool-options')!
  const currentSwatch = host.querySelector<HTMLSpanElement>('.swatch-fg')!

  const strokes: Stroke[] = []
  let tool: ToolId = 'pencil'
  let pen = DEFAULT_PEN

  /* The plotter holds its own pen selection, so we only send `SP` when ours
     drifts from what the device was last told — and forget that across a
     reconnect, since a fresh socket says nothing about carousel state. */
  let selectedPen: number | null = null

  /* Rubber-band shapes repaint from a snapshot of the committed drawing rather
     than replaying every stroke on each pointer move. */
  let snapshot: ImageData | null = null

  type Live = {
    stroke: Stroke
    /* Freehand only: samples not yet flushed, and the last one that was. */
    queued: Point[]
    lastSent: Point
    sent: number
    frame: number
  }
  let live: Live | null = null

  /* Rendering */

  function paintStroke(stroke: Stroke) {
    if (stroke.tool === 'text') {
      /* A character at a time, at the plotter's own cell pitch — no browser
         font advances the way the stick font does. */
      context.fillStyle = PENS[stroke.pen].color
      context.font = fontFor(stroke.size)
      context.textBaseline = 'alphabetic'
      stroke.lines.forEach((line, index) => {
        const y = baselineOf(stroke, index)
        for (let i = 0; i < line.length; i++) {
          context.fillText(line[i], stroke.at.x + i * stroke.size * CHAR_ADVANCE, y)
        }
      })
      return
    }

    context.strokeStyle = PENS[stroke.pen].color
    context.beginPath()

    if (stroke.tool === 'pencil') {
      const [first, ...rest] = stroke.points
      context.moveTo(first.x, first.y)
      for (const point of rest) context.lineTo(point.x, point.y)
      /* A single click is a dot: a zero-length path draws nothing, so nudge it. */
      if (!rest.length) context.lineTo(first.x + 0.01, first.y)
    } else if (stroke.tool === 'line') {
      context.moveTo(stroke.from.x, stroke.from.y)
      context.lineTo(stroke.to.x, stroke.to.y)
    } else if (stroke.tool === 'rect') {
      context.rect(stroke.from.x, stroke.from.y,
        stroke.to.x - stroke.from.x, stroke.to.y - stroke.from.y)
    } else {
      context.ellipse((stroke.from.x + stroke.to.x) / 2, (stroke.from.y + stroke.to.y) / 2,
        Math.abs(stroke.to.x - stroke.from.x) / 2, Math.abs(stroke.to.y - stroke.from.y) / 2,
        0, 0, 2 * Math.PI)
    }

    context.stroke()
  }

  function repaint() {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, CANVAS_W, CANVAS_H)
    for (const stroke of strokes) paintStroke(stroke)
  }

  /* Sending */

  function emit(instructions: string[], quiet = false) {
    for (const instruction of instructions) port.send(instruction, quiet)
  }

  /** Selects the pen only when the plotter is not already holding it. */
  function usePen(index: number) {
    if (selectedPen === index) return []
    selectedPen = index
    return [HPGL.selectPen(index + 1)]
  }

  function describe(stroke: Stroke, messages: number) {
    const detail = stroke.tool === 'pencil' ? `, ${stroke.points.length} points`
      : stroke.tool === 'text' ? `, ${stroke.lines.length} line${stroke.lines.length === 1 ? '' : 's'}`
        : ''
    return `${stroke.tool}${detail} → ${messages} instruction${messages === 1 ? '' : 's'} on pen ${stroke.pen + 1}`
  }

  /* Text entry */

  /* The box is a real textarea laid over the canvas on the same cell grid the
     label will be drawn on, so the caret sits where the pen will. */
  type Editing = LabelBox & {
    pen: number
    field: HTMLTextAreaElement
    /* Whether this label is being streamed to the pen as it is typed. Fixed
       when the box opens: a character already drawn cannot change its mind. */
    live: boolean
    /* Exactly the text the plotter has been sent for this box. */
    streamed: string
    /* Which line an `LB` is open on, and whether one is open at all. */
    line: number
    open: boolean
    /* `SI` holds for the whole box, so it goes out only once. */
    sized: boolean
    /* Messages sent for this label, for the summary at the end. */
    sent: number
  }

  let editing: Editing | null = null
  let textSize = DEFAULT_TEXT_SIZE
  /* A mode of the text tool, remembered between labels. */
  let liveTyping = false

  function layOutField() {
    if (!editing) return
    const { at, pen, size, field } = editing
    const lineHeight = size * LINE_ADVANCE
    const cell = size * CHAR_ADVANCE

    context.save()
    context.font = fontFor(size)
    const { width, fontBoundingBoxAscent, fontBoundingBoxDescent } = context.measureText('M')
    context.restore()

    /* A textarea centres the font box within the line box, so its first
       baseline falls this far below the top edge — offsetting by it puts that
       baseline on the one `LB` will print from. */
    const firstBaseline =
      (lineHeight - fontBoundingBoxAscent - fontBoundingBoxDescent) / 2 + fontBoundingBoxAscent
    const lines = field.value.split('\n')

    field.style.font = `${size / CAP_RATIO}px/${lineHeight}px ${TEXT_FONT}`
    /* Letter-spacing pulls the browser's advance out to the plotter's cell. */
    field.style.letterSpacing = `${cell - width}px`
    field.style.color = PENS[pen].color
    field.style.caretColor = PENS[pen].color
    /* The canvas is displayed at its natural size, so canvas pixels are CSS
       pixels and its offset within the well is the whole conversion. */
    field.style.left = `${canvas.offsetLeft + at.x}px`
    field.style.top = `${canvas.offsetTop + at.y + size - firstBaseline}px`
    /* A spare cell so the caret past the last character stays visible. */
    field.style.width = `${(Math.max(...lines.map((line) => line.length)) + 1) * cell}px`
    field.style.height = `${lines.length * lineHeight}px`
  }

  /* Live typing. `LB` puts the plotter in label mode until the terminator,
     so a label can be opened once and then fed a character at a time — which
     is the whole trick: the pen draws each letter as the key is pressed. */

  function openLabel() {
    if (!editing || editing.open) return
    const height = editing.size * CM_PER_PIXEL
    const opening = [
      ...usePen(editing.pen),
      ...(editing.sized ? [] : [HPGL.characterSize(height * CHAR_ASPECT, height)]),
      HPGL.moveTo(toPlotter({ x: editing.at.x, y: baselineOf(editing, editing.line) })),
      HPGL.BeginLabel,
    ]
    emit(opening)
    editing.sized = true
    editing.open = true
    editing.sent += opening.length
  }

  function closeLabel() {
    if (!editing?.open) return
    port.send(HPGL.LabelTerminator)
    editing.open = false
    editing.sent += 1
  }

  /** Sends what was typed since the last keystroke, and puts back whatever
      the box did that paper cannot follow. */
  function stream() {
    const box = editing
    if (!box) return

    /* The plotter has no way to unsee a character, so the box can only grow:
       a deletion, an IME rewrite or a paste over a selection is reverted to
       what is already on the paper. */
    const typed = box.field.value.startsWith(box.streamed)
      ? box.field.value.slice(box.streamed.length) : ''
    /* Newlines move the pen; everything else must be a glyph the pen has. */
    const added = typed.replace(/[^\n\x20-\x7e]/g, '')
    if (box.field.value !== box.streamed + added) {
      box.field.value = box.streamed + added
      box.field.setSelectionRange(box.field.value.length, box.field.value.length)
    }
    if (!added) return

    added.split('\n').forEach((part, index) => {
      /* A newline ends the label; the next character opens another one line
         down, which is where the canvas draws it too. */
      if (index) {
        closeLabel()
        box.line += 1
      }
      if (!part) return
      openLabel()
      port.send(part, true)
      box.sent += 1
    })
    box.streamed = box.field.value
  }

  function openText(at: Point) {
    const field = document.createElement('textarea')
    field.className = 'text-entry'
    field.spellcheck = false
    /* Streaming needs a socket. Without one the box behaves as it always has:
       held back, and drawn in one piece when it is committed. */
    const live = liveTyping && port.isLive()
    editing = {
      at, pen, size: textSize, field, live,
      streamed: '', line: 0, open: false, sized: false, sent: 0,
    }
    layOutField()
    canvas.parentElement!.append(field)
    field.focus()

    field.addEventListener('input', () => {
      if (editing?.live) stream()
      layOutField()
    })
    field.addEventListener('beforeinput', (event) => {
      /* Ink cannot be taken back, so a live box never shrinks. `stream` would
         put the character back anyway; cancelling here saves it the flicker. */
      if (editing?.live && /^(delete|history)/.test(event.inputType)) event.preventDefault()
    })
    /* The pen is at the end of what has been typed and cannot go back, so in
       live mode the caret is held there — otherwise the next character would
       land in the middle, where `stream` could only refuse it. */
    const toEnd = () => {
      if (editing?.live) field.setSelectionRange(field.value.length, field.value.length)
    }
    field.addEventListener('pointerup', toEnd)
    field.addEventListener('select', toEnd)
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeText(false)
      /* Enter is a newline inside the box, so committing takes a modifier. */
      else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) closeText(true)
      else if (editing?.live && CARET_KEYS.test(event.key)) toEnd()
      else return
      event.preventDefault()
    })

    hint.textContent = live
      ? 'Live — each character goes to the pen as you type. Esc or Ctrl+Enter ends the label.'
      : liveTyping
        ? 'Not connected — this label will be held back until you commit it.'
        : 'Type the label — Ctrl+Enter or a click elsewhere draws it, Esc cancels.'
  }

  /** Commits the open label, or discards it. Safe to call when none is open. */
  function closeText(commit: boolean) {
    if (!editing) return
    const { at, pen: inkPen, size, field, live, streamed } = editing

    /* A live label is already on the paper, so it ends where it ends — `Esc`
       can only stop it, not take it back. */
    const drawn = live && streamed !== ''
    if (drawn) {
      closeLabel()
      port.send(HPGL.PenUp)
      editing.sent += 1
    }
    const sent = editing.sent
    editing = null
    field.remove()
    hint.textContent = DEFAULT_HINT

    /* Trailing blank lines would only walk the pen down past the last word. */
    const lines = (drawn ? streamed : field.value).split('\n')
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    if ((!commit && !drawn) || !lines.length) return

    const stroke: Stroke = { tool: 'text', pen: inkPen, at, size, lines }
    strokes.push(stroke)
    paintStroke(stroke)

    if (drawn) {
      port.note(`text, ${lines.length} line${lines.length === 1 ? '' : 's'} → ${sent} message${sent === 1 ? '' : 's'} on pen ${inkPen + 1}, drawn as you typed`)
      return
    }
    const instructions = [...usePen(inkPen), ...instructionsFor(stroke)]
    emit(instructions)
    if (port.isLive()) port.note(describe(stroke, instructions.length))
  }

  /* Pointer handling */

  function positionOf(event: PointerEvent): Point {
    const bounds = canvas.getBoundingClientRect()
    return {
      x: clamp((event.clientX - bounds.left) * (CANVAS_W / bounds.width), 0, CANVAS_W),
      y: clamp((event.clientY - bounds.top) * (CANVAS_H / bounds.height), 0, CANVAS_H),
    }
  }

  /** Sends the freehand samples gathered since the last frame. */
  function flush(stroke: Live) {
    for (const part of chunk(stroke.queued, MAX_PAIRS_PER_MESSAGE)) {
      port.send(HPGL.plotAbsolute(part.map(toPlotter)), true)
      stroke.sent += 1
    }
    stroke.queued = []
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || live) return
    /* Any click on the canvas ends an open label, wherever it lands — and the
       same click may go on to start the next one. */
    closeText(true)
    const at = positionOf(event)

    if (tool === 'text') {
      /* The canvas cannot hold focus, so letting the click keep its default
         behaviour would move focus off the box the moment we open it. */
      event.preventDefault()
      openText(at)
      return
    }

    canvas.setPointerCapture(event.pointerId)

    if (tool === 'pencil') {
      const stroke: Stroke = { tool, pen, points: [at] }
      const opening = [...usePen(pen), HPGL.moveTo(toPlotter(at)), HPGL.PenDown]
      emit(opening)
      live = { stroke, queued: [], lastSent: at, sent: opening.length, frame: 0 }
    } else {
      snapshot = context.getImageData(0, 0, canvas.width, canvas.height)
      live = { stroke: { tool, pen, from: at, to: at }, queued: [], lastSent: at, sent: 0, frame: 0 }
    }

    hint.textContent = port.isLive()
      ? 'Drawing — instructions are going out as you move.'
      : 'Drawing locally. Connect, then Plotter ▸ Replot Canvas to send it.'
  })

  canvas.addEventListener('pointermove', (event) => {
    const at = positionOf(event)
    coords.textContent = `${Math.round(at.x)}, ${Math.round(at.y)}`
    const units = toPlotter(at)
    plu.textContent = `${units.x}, ${units.y} plu`

    if (!live) return

    if (live.stroke.tool === 'pencil') {
      /* Draw every sample the browser has, but only send the ones far enough
         apart to matter to a pen. Coalescing is empty for synthetic events, so
         fall back to the event's own position. */
      const coalesced = event.getCoalescedEvents?.() ?? []
      const samples = coalesced.length ? coalesced.map(positionOf) : [at]
      for (const sample of samples) {
        const previous = live.stroke.points[live.stroke.points.length - 1]
        context.strokeStyle = PENS[live.stroke.pen].color
        context.beginPath()
        context.moveTo(previous.x, previous.y)
        context.lineTo(sample.x, sample.y)
        context.stroke()
        live.stroke.points.push(sample)

        if (Math.hypot(sample.x - live.lastSent.x, sample.y - live.lastSent.y) >= MIN_SEND_DISTANCE) {
          live.queued.push(sample)
          live.lastSent = sample
        }
      }
      const pending = live
      pending.frame ||= requestAnimationFrame(() => {
        pending.frame = 0
        flush(pending)
      })
    } else {
      live.stroke = { ...live.stroke, to: at } as Stroke
      context.putImageData(snapshot!, 0, 0)
      paintStroke(live.stroke)
    }
  })

  function finish(event: PointerEvent) {
    if (!live) return
    const finished = live
    live = null
    /* `pointercancel` has already dropped the capture, and releasing one we do
       not hold throws. */
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    hint.textContent = DEFAULT_HINT

    if (finished.stroke.tool === 'pencil') {
      if (finished.frame) cancelAnimationFrame(finished.frame)
      const last = finished.stroke.points[finished.stroke.points.length - 1]
      /* The pen must end where the drawing does, however short the last hop. */
      if (last !== finished.lastSent) finished.queued.push(last)
      flush(finished)
      port.send(HPGL.PenUp)
      finished.sent += 1
    } else {
      snapshot = null
      const instructions = [...usePen(finished.stroke.pen), ...instructionsFor(finished.stroke)]
      emit(instructions)
      finished.sent = instructions.length
      paintStroke(finished.stroke)
    }

    strokes.push(finished.stroke)
    if (port.isLive()) port.note(describe(finished.stroke, finished.sent))
  }

  canvas.addEventListener('pointerup', finish)
  canvas.addEventListener('pointercancel', finish)
  canvas.addEventListener('pointerleave', () => {
    if (!live) { coords.textContent = ''; plu.textContent = '' }
  })

  /* Chrome */

  function selectTool(next: ToolId) {
    closeText(true)
    tool = next
    canvas.classList.toggle('typing', next === 'text')
    for (const button of host.querySelectorAll<HTMLButtonElement>('.tool')) {
      button.classList.toggle('active', button.dataset.tool === next)
    }
    renderToolOptions()
  }

  /* Only the text tool has options; for the rest the box stays empty, as it
     does in Paint. */
  function renderToolOptions() {
    if (tool !== 'text') {
      toolOptions.innerHTML = ''
      return
    }
    toolOptions.innerHTML = `
      ${TEXT_SIZES.map((size) => `
        <button type="button" class="text-size" data-size="${size}"
                style="font-size:${Math.min(size, 15)}px"
                title="${size} px tall — SI${(size * CM_PER_PIXEL * CHAR_ASPECT).toFixed(2)},${(size * CM_PER_PIXEL).toFixed(2)} in cm">A</button>`).join('')}
      <button type="button" class="live-toggle" aria-pressed="false"
              title="Live typing — each character goes to the pen as it is pressed. Nothing can be edited or taken back, and the mode a label opens with is the one it keeps.">Live</button>`
    selectTextSize(textSize)
    markLive()
  }

  function markLive() {
    const button = host.querySelector<HTMLButtonElement>('.live-toggle')
    button?.classList.toggle('active', liveTyping)
    button?.setAttribute('aria-pressed', String(liveTyping))
  }

  function selectTextSize(next: number) {
    textSize = next
    /* Resize what is already being typed, the way Paint does — unless some of
       it is already drawn, in which case the size it went out at stands. */
    if (editing && !editing.streamed) {
      editing.size = next
      layOutField()
      editing.field.focus()
    }
    for (const button of host.querySelectorAll<HTMLButtonElement>('.text-size')) {
      button.classList.toggle('active', Number(button.dataset.size) === next)
    }
  }

  function selectPen(next: number) {
    pen = next
    /* Same as the size: a label being streamed keeps the pen it started on. */
    if (editing && !editing.streamed) {
      editing.pen = next
      layOutField()
      editing.field.focus()
    }
    currentSwatch.style.setProperty('--ink', PENS[next].color)
    penPane.textContent = `Pen ${next + 1} — ${PENS[next].name}`
    for (const button of host.querySelectorAll<HTMLButtonElement>('.swatch')) {
      button.classList.toggle('active', Number(button.dataset.pen) === next)
    }
  }

  function closeMenus() {
    for (const dropdown of host.querySelectorAll<HTMLDivElement>('.dropdown')) dropdown.hidden = true
    for (const title of host.querySelectorAll<HTMLButtonElement>('.menu-title')) title.classList.remove('open')
  }

  const actions: Record<string, () => void> = {
    new() {
      strokes.length = 0
      repaint()
      port.note('canvas cleared — paper on the plotter is untouched')
    },
    undo() {
      if (!strokes.pop()) return
      repaint()
      port.note('undone on screen only — plotted ink cannot be recalled')
    },
    initialize() {
      selectedPen = null
      emit([HPGL.Initialize, ...usePen(pen)])
    },
    penup: () => emit([HPGL.PenUp]),
    identify: () => emit([DSC.OutputIdentification]),
    position: () => emit([HPGL.OutputActualPosition]),
    replot() {
      if (!strokes.length) return port.note('nothing to replot')
      selectedPen = null
      let count = 0
      for (const stroke of strokes) {
        const instructions = [...usePen(stroke.pen), ...instructionsFor(stroke)]
        emit(instructions, true)
        count += instructions.length
      }
      port.note(`replotted ${strokes.length} stroke${strokes.length === 1 ? '' : 's'} — ${count} instructions`)
    },
  }

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const menu = target.closest<HTMLButtonElement>('.menu-title')
    if (menu) {
      const dropdown = menu.nextElementSibling as HTMLDivElement
      /* `hidden` widens to `"until-found"`, so compare rather than assign. */
      const opening = dropdown.hidden !== false
      closeMenus()
      dropdown.hidden = !opening
      menu.classList.toggle('open', opening)
      return
    }

    const item = target.closest<HTMLButtonElement>('.menu-item')
    if (item?.dataset.action) {
      closeMenus()
      /* A half-typed label is part of the drawing the command acts on. */
      closeText(true)
      actions[item.dataset.action]?.()
      return
    }

    closeMenus()

    const toolButton = target.closest<HTMLButtonElement>('.tool')
    if (toolButton?.dataset.tool) selectTool(toolButton.dataset.tool as ToolId)

    const swatch = target.closest<HTMLButtonElement>('.swatch')
    if (swatch) selectPen(Number(swatch.dataset.pen))

    const sizeButton = target.closest<HTMLButtonElement>('.text-size')
    if (sizeButton) selectTextSize(Number(sizeButton.dataset.size))

    if (target.closest('.live-toggle')) {
      liveTyping = !liveTyping
      markLive()
      /* The open box keeps the mode it was opened with, so this is the next
         label's setting — but the caret should stay where it was. */
      editing?.field.focus()
    }

    if (target.closest('[data-window]')) {
      /* The buttons live inside the title bar, so take them first — otherwise
         the restore-on-title-bar-click below would undo the collapse. */
      root.classList.toggle('collapsed')
    } else if (target.closest('.titlebar')) {
      root.classList.remove('collapsed')
    }
  })

  document.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement
    if (!target.closest('.menubar')) closeMenus()
    /* Clicking away commits the label, as in Paint. The canvas commits in its
       own handler, since the same click may open the next box; the controls
       that restyle a label in place are left alone to do it. */
    if (editing && !target.closest('.text-entry, canvas, .swatch, .text-size, .live-toggle')) {
      closeText(true)
    }
  })

  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey && !event.metaKey) return
    /* Leave the command box its own undo. */
    if ((event.target as HTMLElement).closest('input, textarea')) return
    const action = event.key === 'z' ? 'undo' : event.key === 'n' ? 'new' : null
    if (!action) return
    event.preventDefault()
    actions[action]()
  })

  context.lineWidth = 1
  context.lineCap = 'round'
  context.lineJoin = 'round'
  repaint()
  selectTool('pencil')
  selectPen(DEFAULT_PEN)

  return {
    /** A new socket knows nothing of the carousel, so re-send `SP` next stroke. */
    connectionChanged() {
      selectedPen = null
    },
  }
}
