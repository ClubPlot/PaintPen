import "./style.css";
import { createConnection, DEFAULT_URL, type Connection } from "./plot.ts";

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const pads = document.querySelector<HTMLParagraphElement>("#pads")!;
const state = document.querySelector<HTMLPreElement>("#state")!;
const log = document.querySelector<HTMLPreElement>("#log")!;

urlInput.value = DEFAULT_URL;

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

function setStatus(kind: "idle" | "pending" | "live", text: string) {
  status.className = `status ${kind}`;
  status.textContent = text;

  connectButton.textContent = kind === "live" ? "Disconnect" : "Connect";
  connectButton.disabled = kind === "pending";
  urlInput.disabled = kind !== "idle";
}

/** Drains the incoming queue until the socket closes. */
async function pump(active: Connection) {
  for (; ;) {
    const { value, done } = await active.read();
    if (done) break;
    write("recv", `< ${value}`);
  }
  if (connection === active) {
    connection = null;
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
  setStatus("live", "connected");
  write("info", "connection open");
  void pump(pending);
}

/* The pad polls at frame rate, so anything it drives will send far too often
   to log every instruction — those go out quiet, as on the paint canvas. */
export function send(data: string, quiet = false) {
  if (!connection) return;
  connection.write(data);
  if (!quiet) write("sent", `> ${data}`);
}

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

function describe(pad: Gamepad): string {
  const buttons = pad.buttons.map((b) => (b.pressed ? "1" : "0")).join(" ");
  const axes = pad.axes.map((a) => a.toFixed(2)).join(" ");
  return `[${pad.index}] ${pad.id}\n  buttons: ${buttons}\n  axes:    ${axes}`;
}

let polling = false;

function render() {
  const connected = navigator
    .getGamepads()
    .filter((p): p is Gamepad => p !== null);
  if (connected.length === 0) {
    /* Nothing left to poll for — let the loop end and wait for the next
       gamepadconnected to restart it. */
    polling = false;
    pads.textContent = "Press a button on a controller to connect it.";
    state.textContent = "";
    return;
  }
  pads.textContent = `${connected.length} gamepad(s) connected`;
  state.textContent = connected.map(describe).join("\n\n");
  requestAnimationFrame(render);
}

let plotting = false;

async function plot(reach: number = 10) {
  const connected = navigator
    .getGamepads()
    .filter((p): p is Gamepad => p !== null);

  if (connected.length > 0 && connection !== null) {

    if (plotting === false) {
      // Hardcoded init command; should edit later
      connection.write(`IN;SP4;`);
      plotting = true;
    }

    const pad = connected[0];

    const [y, x] = pad.axes;

    const dx = Math.trunc(x * reach);
    const dy = Math.trunc(y * reach);

    console.log(x, y, dx, dy, reach);

    if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
      const cmd = `PR ${dx},${dy};`

      console.log('CMD:', cmd);

      connection.write(cmd);
      // Not sure reading after OA; actually works.
      // await connection.read();

    }
  }

  requestAnimationFrame(() => plot());
}

window.addEventListener("gamepadconnected", () => {
  /* A second pad joining must not start a second loop. */
  if (polling) return;
  polling = true;
  requestAnimationFrame(render);
});

window.addEventListener("gamepadconnected", async () => {
  requestAnimationFrame(() => plot());
});

pads.textContent = "Press a button on a controller to connect it.";

setStatus("idle", "disconnected");
