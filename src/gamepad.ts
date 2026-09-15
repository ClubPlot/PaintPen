import "./style.css";
import { trackHPGL } from "../track/trackhpgl.js"
import { startPoint, onTrack, finished } from "./track.ts";
import type { Point } from "./plot.ts";
import { createConnection, DEFAULT_URL, type Connection } from "./plot.ts";

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const pads = document.querySelector<HTMLParagraphElement>("#pads")!;
const state = document.querySelector<HTMLPreElement>("#state")!;
const log = document.querySelector<HTMLPreElement>("#log")!;
const drawTrackButton = document.querySelector<HTMLButtonElement>("#draw-track")!;

urlInput.value = DEFAULT_URL;

let connection: Connection | null = null;
const waiting: ((line: string | null) => void)[] = [];


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
function ask(active: Connection, query: string) {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  waiting.push(resolve);
  active.write(query);
  return promise;
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
    const waiter = waiting.shift();
    if (waiter) waiter(value);
    else write("recv", `< ${value}`);
  }
  while (waiting.length) waiting.shift()!(null);
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

const reach = 10;
let currentPoint = startPoint()
let lastTime = 0;
const minInterval = 1000 / 10;

// Helper function to Draw Track
function drawTrack(HPGL: string) {
  connection?.write(HPGL)
}

// Helper function to set Pen
function setPen(pen: number) {
  console.log("running switch pen - " + pen)
  connection?.write(`SP${pen}`)
}

// Start function to run once the pen reaches the finish line
function start(lap: number, point: Point) {
  setPen(lap + 5)
  let command = `PU;PA ${point.x}, ${point.y};PD;`
  console.log("running switch pen - " + command)
  if (lap === 0) {
    connection?.write(`IN;` + command);
  }
  connection?.write(command);
}

let lapTimes: Array<number> = [];

const gameState = { currentPoint: currentPoint, finished: false, startTime: -1, lap: 0 }

async function plot(currentTime: number) {

  if (!gameState.finished) {
    requestAnimationFrame(plot);

    const connected = navigator
      .getGamepads()
      .filter((p): p is Gamepad => p !== null);

    if (connected.length > 0 && connection !== null) {
      const deltaTime = currentTime - lastTime;

      if (deltaTime >= minInterval) {
        lastTime = currentTime - (deltaTime % minInterval);


        const pad = connected[0];

        const [y, x] = pad.axes;
        const speed = Math.floor((39 * pad.buttons[7].value) + 1);

        const dx = Math.trunc(x * reach * speed);
        const dy = Math.trunc(y * reach * speed);

        if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
          const nextPoint: Point = { x: gameState.currentPoint.x + dx, y: gameState.currentPoint.y + dy }
          if (onTrack(nextPoint)) {
            gameState.currentPoint = nextPoint
            connection.write(`VS ${speed}; PR ${dx},${dy};`)
          } else if (finished(nextPoint)) {

            lapTimes[gameState.lap] = Date.now() - gameState.startTime;

            gameState.lap += 1
            start(gameState.lap, startPoint())
            gameState.currentPoint = startPoint()
            gameState.startTime = Date.now();
            console.log(`Game ${gameState.lap} started`)
            if (gameState.lap >= 4) {
              gameState.finished = true;
              gameState.lap = 0;
            }
          } else {
            if (connected && connected[0].vibrationActuator) {
              connected[0].vibrationActuator.playEffect("dual-rumble", {
                startDelay: 0,      // Delay in milliseconds before rumbling
                duration: 500,      // Duration of the rumble in milliseconds
                weakMagnitude: 0.5, // High-frequency motor intensity (0.0 to 1.0)
                strongMagnitude: 1.0 // Low-frequency motor intensity (0.0 to 1.0)
              });
            }
          }
        }
      }
    }
  } else {
    const fmt: (x: number, y: number) => string = (x, y) => `${x},${y}`
    const startX = 4100;
    const startY = 2949;
    const lineHeight = 150;

    for (let i = 0; i < lapTimes.length; i += 1) {
      const seconds = lapTimes[i] * 1000;
      connection?.write(`PU;PA ${fmt(startX + i * lineHeight, startY)};PD;`);
      connection?.write(`LB${seconds}\x03`);

    }
  }
}

window.addEventListener("gamepadconnected", () => {
  /* A second pad joining must not start a second loop. */
  if (polling) return;
  polling = true;
  requestAnimationFrame(render);
});

window.addEventListener("gamepadconnected", async () => {
  start(gameState.lap, startPoint())
  gameState.startTime = Date.now();
  requestAnimationFrame(plot);
});

drawTrackButton.addEventListener("click", () => {
  drawTrack(trackHPGL)
});

pads.textContent = "Press a button on a controller to connect it.";

setStatus("idle", "disconnected");
