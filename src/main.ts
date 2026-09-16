import "./style.css";
import {
  createConnection,
  DEFAULT_URL,
  DSC,
  HPGL,
  type Connection,
} from "./plot.ts";
import { mountPaint } from "./paint.ts";

const IDX_TO_KEY = {
  0: "A",
  1: "B",
  3: "Y",
  2: "X",
  13: "DOWN",
  15: "RIGHT",
  12: "UP",
  14: "LEFT",
  5: "R1",
  7: "R2",
  6: "L1",
  8: "L2",
};
//const BUTTON_TO_KEY

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<header>
  <div class="brand">
    <span class="logo" aria-hidden="true"></span>
    <h1>interplot</h1>
  </div>
  <div class="row">
    <input id="url" type="text" spellcheck="false" value="${DEFAULT_URL}" />
    <button id="connect" type="button" class="primary">Connect</button>
    <span id="status" class="status idle">disconnected</span>
  </div>
</header>

<form id="command-form">
  <input id="command" type="text" spellcheck="false" autocomplete="off"
         placeholder="Command to send…" disabled />
  <button id="send" type="submit" disabled>Send</button>
  <button id="ping" type="button" disabled title="Sends an ESC . A identification request">Test</button>
  <button id="oa" type="button" disabled title="Sends OA; — output actual pen position">OA</button>
</form>

<section id="paint"></section>

<pre id="log"></pre>
`;

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const form = document.querySelector<HTMLFormElement>("#command-form")!;
const commandInput = document.querySelector<HTMLInputElement>("#command")!;
const sendButton = document.querySelector<HTMLButtonElement>("#send")!;
const pingButton = document.querySelector<HTMLButtonElement>("#ping")!;
const oaButton = document.querySelector<HTMLButtonElement>("#oa")!;
const log = document.querySelector<HTMLPreElement>("#log")!;
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

function setStatus(state: "idle" | "pending" | "live", text: string) {
  status.className = `status ${state}`;
  status.textContent = text;

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

window.addEventListener("gamepadconnected", (e) => {
  console.log(
    "Gamepad connected at index %d: %s. %d buttons, %d axes.",
    e.gamepad.index,
    e.gamepad.id,
    e.gamepad.buttons.length,
    e.gamepad.axes.length,
  );
  const gp = navigator.getGamepads()[e.gamepad.index];
  console.log(gp);

  gameLoop();
});

let start;
let a = 0;
let b = 0;

function gameLoop() {
  const gamepads = navigator.getGamepads();
  if (!gamepads) {
    return;
  }

  const gp = gamepads[0];
  console.log(gp.axes);
  for (let i = 0; i < gp.buttons.length; i++) {
    if (gp.buttons[i].pressed) {
      //        console.log(i);
    }
  }

  start = requestAnimationFrame(gameLoop);
}

setStatus("idle", "disconnected");
