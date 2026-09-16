import "./style.css";
import { trackHPGL } from "../track/trackhpgl.js"
import countdownUrl from "./assets/countdown.mp4";
import { startPoint, onTrack, finished, starting } from "./track.ts";
import type { Point } from "./plot.ts";
import { createConnection, DEFAULT_URL, type Connection } from "./plot.ts";

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const pads = document.querySelector<HTMLParagraphElement>("#pads")!;
const state = document.querySelector<HTMLPreElement>("#state")!;
const log = document.querySelector<HTMLPreElement>("#log")!;
const drawTrackButton = document.querySelector<HTMLButtonElement>("#draw-track")!;
const hud = document.querySelector<HTMLPreElement>("#hud")!;
const countdown = document.querySelector<HTMLCanvasElement>("#countdown")!;
const startButton = document.querySelector<HTMLButtonElement>("#start-race")!;

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
const LAPS = 4;

// Helper function to Draw Track
function drawTrack(HPGL: string) {
  connection?.write(HPGL)
}

// Helper function to set Pen
function setPen(pen: number) {
  connection?.write(`SP${pen}`)
}

// Start function to run once the pen reaches the finish line
function start(lap: number, point: Point) {
  setPen(lap + 5)
  let command = `PU;PA ${point.x}, ${point.y};PD;`
  if (lap === 1) {
    connection?.write(`IN;` + command);
  } else {
    connection?.write(command);
  }
}

let lapTimes: Array<number> = [];

const gameState = { currentPoint: currentPoint, finished: false, startTime: -1, lap: 0 }
function renderHud() {
  const laps = lapTimes.map((ms, i) => `lap ${i + 1}   ${(ms / 1000).toFixed(2)}s`);

  const clock = gameState.finished
    ? `${(lapTimes.reduce((a, b) => a + b, 0) / 1000).toFixed(2)}s total`
    : gameState.startTime < 0
      ? "ready"
      : `${((Date.now() - gameState.startTime) / 1000).toFixed(2)}s`;
  hud.textContent = [
    gameState.finished
      ? `finished · ${LAPS} laps`
      : `lap ${Math.min(gameState.lap + 1, LAPS)} / ${LAPS}`,
    clock,
    ...laps,
  ].join("\n");
}
const KEY_WIDTH = 640;
const KEY_OPAQUE = 90;
const KEY_CLEAR = 200;

function keyFrame(ctx: CanvasRenderingContext2D, video: HTMLVideoElement) {
  const { width, height } = ctx.canvas;
  ctx.drawImage(video, 0, 0, width, height);
  const frame = ctx.getImageData(0, 0, width, height);
  const px = frame.data;
  for (let i = 0; i < px.length; i += 4) {
    const green = px[i + 1] - Math.max(px[i], px[i + 2]);
    if (green <= KEY_OPAQUE) continue;
    if (green >= KEY_CLEAR) {
      px[i + 3] = 0;
      continue;
    }
    px[i + 3] = Math.round(
      255 * (1 - (green - KEY_OPAQUE) / (KEY_CLEAR - KEY_OPAQUE)),
    );
    px[i + 1] = Math.max(px[i], px[i + 2]);
  }
  ctx.putImageData(frame, 0, 0);
}

/** Plays 3·2·1·GO over the camera, resolving as the flag drops. */
function playCountdown() {
  const { promise, resolve } = Promise.withResolvers<void>();
  const ctx = countdown.getContext("2d", { willReadFrequently: true })!;

  const video = document.createElement("video");
  video.src = countdownUrl;
  video.playsInline = true;

  const frame = () => {
    if (video.ended) return;
    if (countdown.width !== KEY_WIDTH && video.videoWidth > 0) {
      countdown.width = KEY_WIDTH;
      countdown.height = Math.round(
        (KEY_WIDTH * video.videoHeight) / video.videoWidth,
      );
    }
    if (countdown.width === KEY_WIDTH) keyFrame(ctx, video);
    requestAnimationFrame(frame);
  };

  const done = () => {
    countdown.hidden = true;
    resolve();
  };
  video.addEventListener("ended", done);
  video.addEventListener("error", done);

  countdown.hidden = false;
  void video.play().then(() => requestAnimationFrame(frame), done);
  return promise;
}

async function plot(currentTime: number) {

  renderHud();

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
          if (gameState.startTime < 0 && starting(gameState.currentPoint)) {
            gameState.startTime = Date.now();
          }

          if (onTrack(nextPoint)) {
            gameState.currentPoint = nextPoint
            connection.write(`VS ${speed}; PR ${dx},${dy};`)
          } else if (finished(nextPoint)) {
            connection.write(`VS ${speed}; PR ${dx},${dy};PU;`)
            lapTimes[gameState.lap] = Date.now() - gameState.startTime;

            gameState.lap += 1
            start(gameState.lap, startPoint())
            gameState.currentPoint = startPoint()
            gameState.startTime = -1;
            if (gameState.lap >= LAPS) {
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
    startButton.disabled = false;
    drawTrackButton.disabled = false;
    connection?.write(`SP4;`)
    for (let i = 0; i < lapTimes.length; i += 1) {
      const seconds = (lapTimes[i] / 1000).toFixed(2);
      connection?.write(`PU;PA ${fmt(startX , startY - i * lineHeight)};PD;`);
      connection?.write(`LB${seconds} S \x03`);
      connection?.write(`SP4;`)

    }
  }
}

window.addEventListener("gamepadconnected", () => {
  /* A second pad joining must not start a second loop. */
  if (polling) return;
  polling = true;
  requestAnimationFrame(render);
});

async function startRace() {
  startButton.disabled = true;
  drawTrackButton.disabled = true;

  lapTimes = [];
  gameState.finished = false;
  gameState.lap = 0;
  gameState.startTime = -1;
  gameState.currentPoint = startPoint();
  renderHud();

  await playCountdown();
  start(0, startPoint());
  requestAnimationFrame(plot);
}
drawTrackButton.addEventListener("click", () => {
  drawTrack(trackHPGL)
});

startButton.addEventListener("click", () => {
  void startRace();
});

pads.textContent = "Press a button on a controller to connect it.";

renderHud();
setStatus("idle", "disconnected");
