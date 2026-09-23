import "./style.css";
import {
  createConnection,
  DEFAULT_URL,
  DSC,
  HPGL,
  type Connection,
} from "./plot.ts";
import { mountPaint } from "./paint.ts";

const icon = (body: string) =>
  `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">${body}</svg>`;

const PEN_ICON = icon(`<path d="M3 13l1-3 7-7 2 2-7 7z"/><path d="M10 5l2 2"/>`);

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<div class="window" id="shell">
  <div class="titlebar">
    <span class="title-icon">${PEN_ICON}</span>
    <h1 class="title-text">Paint Pen — HP-GL Plotter Terminal</h1>
    <span class="title-buttons">
      <button type="button" data-window="collapse" title="Minimize"><i>_</i></button>
      <button type="button" data-window="collapse" title="Maximize"><i>□</i></button>
      <button type="button" data-window="collapse" title="Close"><i>✕</i></button>
    </span>
  </div>

  <div class="window-body">
    <fieldset class="group">
      <legend>Plotter</legend>
      <div class="row">
        <label for="url">Address:</label>
        <input id="url" type="text" spellcheck="false" value="${DEFAULT_URL}" />
        <button id="connect" type="button">Connect</button>
        <span id="status" class="status idle">disconnected</span>
      </div>
    </fieldset>

    <section id="paint"></section>

    <fieldset class="group">
      <legend>Send command</legend>
      <form id="command-form">
        <input id="command" type="text" spellcheck="false" autocomplete="off"
               placeholder="Command to send…" disabled />
        <button id="send" type="submit" disabled>Send</button>
        <button id="ping" type="button" disabled title="Sends an ESC . A identification request">Test</button>
        <button id="oa" type="button" disabled title="Sends OA; — output actual pen position">OA</button>
      </form>
    </fieldset>

    <fieldset class="group">
      <legend>Session log</legend>
      <pre id="log"></pre>
    </fieldset>
  </div>

  <div class="statusbar">
    <span class="pane hint">Ready</span>
    <span class="pane">HP 7475A</span>
  </div>
</div>
`;

/* The desktop furniture: a Start button that is chrome rather than a control,
   a task button that raises the window it names, and a tray clock. */
document.body.insertAdjacentHTML(
  "beforeend",
  `
<div class="taskbar">
  <span class="start">
    ${icon(`<path d="M2 4.2l5-1v4H2zM8 3l6-1.2v5.2H8zM2 8.8h5v4l-5-1zM8 8.8h6V14L8 12.8z" fill="currentColor" stroke="none"/>`)}
    Start
  </span>
  <span class="divider"></span>
  <button type="button" class="task">
    ${PEN_ICON}<span>Paint Pen</span>
  </button>
  <span class="tray">
    ${PEN_ICON}
    <span id="clock"></span>
  </span>
</div>`,
);

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const form = document.querySelector<HTMLFormElement>("#command-form")!;
const commandInput = document.querySelector<HTMLInputElement>("#command")!;
const sendButton = document.querySelector<HTMLButtonElement>("#send")!;
const pingButton = document.querySelector<HTMLButtonElement>("#ping")!;
const oaButton = document.querySelector<HTMLButtonElement>("#oa")!;
const log = document.querySelector<HTMLPreElement>("#log")!;
const shell = document.querySelector<HTMLDivElement>("#shell")!;
const shellHint = document.querySelector<HTMLSpanElement>(".window > .statusbar .hint")!;
const clock = document.querySelector<HTMLSpanElement>("#clock")!;
const paintHost = document.querySelector<HTMLElement>("#paint")!;

let connection: Connection | null = null;

/** Renders control characters so an ESC-prefixed reply is legible in the log. */
function printable(text: string) {
  return text.replace(/[\x00-\x1f\x7f]/g, (c) =>
    c === "\n" ? "\n" : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

function write(kind: "sent" | "recv" | "info" | "error", text: string) {
  const line = document.createElement("div");
  line.className = `line ${kind}`;
  line.textContent = `${new Date().toLocaleTimeString()}  ${printable(text)}`;
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

const HINTS = {
  idle: "Ready — enter an address and connect",
  pending: "Working…",
  live: "Connected to the plotter",
};

function setStatus(state: "idle" | "pending" | "live", text: string) {
  status.className = `status ${state}`;
  status.textContent = text;
  shellHint.textContent = HINTS[state];

  const live = state === "live";
  for (const el of [commandInput, sendButton, pingButton, oaButton])
    el.disabled = !live;
  connectButton.textContent = live ? "Disconnect" : "Connect";
  connectButton.disabled = state === "pending";
  urlInput.disabled = state !== "idle";
}

/** Drains the incoming queue until the socket closes. */
async function pump(active: Connection) {
  for (;;) {
    const { value, done } = await active.read();
    if (done) break;
    write("recv", `< ${value}`);
  }
  if (connection === active) {
    connection = null;
    paint.connectionChanged();
    setStatus("idle", "disconnected");
    write("info", "connection closed");
  }
}

async function connect() {
  const url = urlInput.value.trim();
  if (!url) return;

  setStatus("pending", "connecting…");
  write("info", `connecting to ${url}`);

  let pending: Connection;
  try {
    pending = createConnection(url);
  } catch (error) {
    setStatus("idle", "disconnected");
    write(
      "error",
      `invalid URL: ${error instanceof Error ? error.message : error}`,
    );
    return;
  }

  try {
    await pending.ready();
  } catch (error) {
    setStatus("idle", "disconnected");
    write(
      "error",
      `could not connect: ${error instanceof Error ? error.message : error}`,
    );
    return;
  }

  connection = pending;
  paint.connectionChanged();
  setStatus("live", "connected");
  write("info", "connection open");
  void pump(pending);
}

/* Freehand drawing emits an instruction every few frames, which would bury the
   log — those go out quietly and are summarised once the stroke ends. */
function send(data: string, quiet = false) {
  if (!connection) return;
  connection.write(data);
  if (!quiet) write("sent", `> ${data}`);
}

const paint = mountPaint(paintHost, {
  send,
  note: (text) => write("info", text),
  isLive: () => connection !== null,
});

connectButton.addEventListener("click", () => {
  if (connection) {
    /* The socket stays open until the peer answers the close frame, so hold a
       pending state rather than claiming we are already disconnected. */
    setStatus("pending", "disconnecting…");
    connection.close();
  } else {
    void connect();
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = commandInput.value;
  if (!command) return;
  send(command);
  commandInput.value = "";
});

pingButton.addEventListener("click", () => send(DSC.OutputIdentification));
oaButton.addEventListener("click", () => send(HPGL.OutputActualPosition));

/* The shell's window buttons roll it up to its title bar, which then restores
   it — the same gesture Paint's own buttons make. One handler, taking the
   buttons before the bar they sit in, so a collapse is not undone by the click
   that made it; Paint's chrome is nested in here and keeps itself to itself. */
shell.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("#paint")) return;
  if (target.closest("[data-window]")) shell.classList.toggle("collapsed");
  else if (target.closest(".titlebar")) shell.classList.remove("collapsed");
});

document
  .querySelector<HTMLButtonElement>(".taskbar .task")!
  .addEventListener("click", () => shell.classList.toggle("collapsed"));

function tick() {
  clock.textContent = new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
tick();
setInterval(tick, 15_000);

setStatus("idle", "disconnected");
