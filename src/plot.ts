export const DSC = {
    OutputBufferSpace: "\x1b.B",
    OutputIdentification: "\x1b.A",
} as const;

const BEGIN_LABEL = "LB";
const LABEL_TERMINATOR = "\x03";

/* Anything the stick font has no glyph for, and the control characters that
   would move the pen behind our back. */
const strip = (text: string) => text.replace(/[^\x20-\x7e]/g, '');

/* Plain HP-GL instructions, as opposed to the ESC-prefixed device controls
   above. Terminated with `;` since the plotter has no other cue that a
   parameterless instruction has ended. */
export const HPGL = {
    OutputActualPosition: "OA;",
    Initialize: "IN;",
    PenUp: "PU;",
    PenDown: "PD;",
    selectPen: (pen: number) => `SP${pen};`,
    /* `PU` with coordinates is a move; `PA` after a `PD` is a draw. Both take
       any number of pairs, so a whole polyline can travel as one message. */
    moveTo: ({ x, y }: Point) => `PU${x},${y};`,
    plotAbsolute: (points: readonly Point[]) =>
        `PA${points.map(({ x, y }) => `${x},${y}`).join(',')};`,
    /* Edge Rectangle Absolute: outlines the box between the current pen
       position and the given corner, handling its own pen up/down. */
    edgeRectangle: ({ x, y }: Point) => `EA${x},${y};`,
    /* Character size in centimetres, which is how the plotter is told how big
       a label should be. It then spaces characters 1.5x the width apart and
       baselines 2x the height apart — the geometry the canvas mirrors. */
    characterSize: (width: number, height: number) =>
        `SI${width.toFixed(3)},${height.toFixed(3)};`,
    /* `LB` draws from the current pen position and reads raw bytes until its
       terminator, so ETX is the one character a label cannot contain —
       everything else is literal, semicolons included. Control characters are
       dropped rather than sent: `CR`/`LF` would move the pen by rules of the
       plotter's own, and we would no longer know where the text sits. */
    label: (text: string) => BEGIN_LABEL + strip(text) + LABEL_TERMINATOR,
    /* The same two halves apart, for typing a label live. Between them the
       plotter is in label mode and draws each byte as it arrives, which is
       what lets a character reach the paper the moment it is pressed. */
    BeginLabel: BEGIN_LABEL,
    LabelTerminator: LABEL_TERMINATOR,
    stripUnprintable: strip,
} as const;

export type Point = { x: number, y: number };

/* The plotting area, in HP-GL plotter units of 0.025 mm: 250 x 187.5 mm. That
   is 4:3, and fits inside the hard-clip limits of an A4 carriage with room to
   spare, so nothing we send lands outside the paper. HP-GL's origin is the
   lower-left corner, not the upper-left. */
export const PLOT_WIDTH = 10000;
export const PLOT_HEIGHT = 7500;

/* 0.025 mm to the plotter unit is 400 to the centimetre, and centimetres are
   what `SI` speaks. */
export const PLOTTER_UNITS_PER_CM = 400;

/* The carousel. A plotter draws with the pens it physically holds, so this is
   the whole colour space available to anything upstream of it. */
export const PENS = [
    { name: "black", color: "#000000" },
    { name: "red", color: "#cc2222" },
    { name: "blue", color: "#2244cc" },
    { name: "green", color: "#118844" },
    { name: "magenta", color: "#b3179c" },
    { name: "cyan", color: "#0d9bb5" },
    { name: "orange", color: "#e07000" },
    { name: "brown", color: "#7a4a12" },
] as const;

/* Slots 1-3 are out of service on the machine, so drawing starts on the green
   pen. This is an index into `PENS`, so it reads one less than its `SP`
   number: 3 here is `SP4;` on the wire. */
export const DEFAULT_PEN = 3;

export const DEFAULT_URL = "ws://plotpi.cymric-logarithm.ts.net:8181";

export type Connection = ReturnType<typeof createConnection>;

export function createConnection(url: string | URL) {

    /* Receive Queue */

    let controller!: ReadableStreamDefaultController<string>;

    const incoming = new ReadableStream<string>({
        start(c) { controller = c }
    });

    const ws = new WebSocket(url);

    ws.addEventListener('message', ({ data }) => controller.enqueue(String(data)));
    ws.addEventListener('close', () => {
        try { controller.close() } catch { /* already closed */ }
    });

    const reader = incoming.getReader();

    /* Readiness */

    const { promise, resolve, reject } = Promise.withResolvers<true>();

    /* A failed handshake surfaces as `error` with no detail, so the close code
       is the only diagnostic we can hand the user. */
    ws.addEventListener('close', ({ code, reason }) => {
        reject(new Error(`closed (${code})${reason ? `: ${reason}` : ''}`));
    });
    ws.addEventListener('open', () => resolve(true));
    promise.catch(() => { /* reported by whoever awaits ready() */ });

    return {
        ready() {
            return promise;
        },
        read() {
            return reader.read();
        },
        write(data: string) {
            ws.send(data);
        },
        close() {
            ws.close();
        },
        get state() {
            return ws.readyState;
        }
    }
}
