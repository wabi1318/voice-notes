import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const CONTROL_CLOSE_TIMEOUT_MS = 3_000;
const RUNNER_TIMEOUT_MS = 6_000;
const TEST_TIMEOUT_MS = RUNNER_TIMEOUT_MS + CONTROL_CLOSE_TIMEOUT_MS;

test.each(["stalled-write", "stalled-open-peer"] as const)("%sでも操作用通信を終了できる", async (scenario) => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "vn-close-"));
  try {
    const runner = join(root, "runner.ts");
    await writeFile(runner, `import { mock } from "bun:test";
import * as net from "node:net";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const project = ${JSON.stringify(project)};
process.env.VOICE_NOTE_RUN_DIR = join(root, "run");
const createServer = net.createServer;
let acceptedSocket;
let nativeServer;
let blockResponse = false;
let notifyWriteStarted;
const writeStarted = new Promise(resolve => { notifyWriteStarted = resolve; });
mock.module("node:net", () => ({ ...net, createServer: listener => {
  nativeServer = createServer(socket => {
    acceptedSocket = socket;
    if (blockResponse) {
      // 送信完了が通知されない状態を再現し、発生の偶然性を除く。
      socket._write = () => { notifyWriteStarted(); };
    }
    listener(socket);
  });
  return nativeServer;
} }));
const { writeState } = await import(join(project, "src/state.ts"));
const { startControlServer, sendControl } = await import(join(project, "src/control.ts"));
const session = join(root, "session");
await mkdir(session);
await writeState("recording", session);
let stopCount = 0;
const server = await startControlServer(session, () => { stopCount += 1; });
let closing;
let timer;
let peer;
try {
  const status = await sendControl("status", session);
  const stopped = await sendControl("stop", session);
  let timedOut = false;
  blockResponse = true;
  if (${JSON.stringify(scenario)} === "stalled-write") {
    const pendingResponse = sendControl("status", session);
    await writeStarted;
    timedOut = (await pendingResponse) === undefined;
  } else {
    peer = net.createConnection(nativeServer.address());
    await new Promise(resolve => peer.once("connect", resolve));
    peer.write(JSON.stringify({ action: "status" }) + "\\n");
    await writeStarted;
  }
  closing = server.close();
  const closed = await Promise.race([
    closing.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), ${CONTROL_CLOSE_TIMEOUT_MS}); }),
  ]);
  process.stdout.write(JSON.stringify({ phase: status?.phase, stopped: stopped?.phase, stopCount, timedOut, closed }));
} finally {
  clearTimeout(timer);
  peer?.destroy();
  acceptedSocket?.destroy();
  await (closing ?? server.close());
}
`);
    const { stdout } = await executeFile(process.execPath, [runner], { timeout: RUNNER_TIMEOUT_MS });
    const result: { phase: string; stopped: string; stopCount: number; timedOut: boolean; closed: boolean } = JSON.parse(stdout);
    expect(result.phase).toBe("recording");
    expect(result.stopped).toBe("stopping");
    expect(result.stopCount).toBe(1);
    expect(result.timedOut).toBe(scenario === "stalled-write");
    expect(result.closed).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

test("停止要求の後続データで同じ停止処理を再実行しない", async () => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "vn-request-"));
  try {
    const runner = join(root, "runner.ts");
    await writeFile(runner, `import { mock } from "bun:test";
import * as net from "node:net";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const project = ${JSON.stringify(project)};
const run = join(root, "run");
process.env.VOICE_NOTE_RUN_DIR = run;
await mkdir(run, { mode: 0o700 });
let releaseWrite;
const writeGate = new Promise(resolve => { releaseWrite = resolve; });
mock.module(join(project, "src/state.ts"), () => ({
  readState: async () => ({ phase: "recording" }),
  writeState: async () => { await writeGate; return { phase: "stopping" }; },
  hasSessionStateFile: async () => true,
}));
let notifyReplay;
const replayReceived = new Promise(resolve => { notifyReplay = resolve; });
const createServer = net.createServer;
mock.module("node:net", () => ({ ...net, createServer: listener => createServer(socket => {
  let receivedFirstChunk = false;
  socket.on("data", () => {
    if (receivedFirstChunk) notifyReplay();
    receivedFirstChunk = true;
  });
  listener(socket);
}) }));
const { startControlServer } = await import(join(project, "src/control.ts"));
let stopCount = 0;
let notifyStop;
const stopped = new Promise(resolve => { notifyStop = resolve; });
const server = await startControlServer(join(root, "session"), () => { stopCount += 1; notifyStop(); });
const [socketFile] = await readdir(run);
const peer = net.createConnection(join(run, socketFile));
try {
  await new Promise(resolve => peer.once("connect", resolve));
  peer.write(JSON.stringify({ action: "stop" }) + "\\n");
  await stopped;
  peer.write("additional chunk");
  await replayReceived;
  // 途中の待機回数に依存させないよう、受信処理の続きを終えてから回数を確認する。
  await new Promise<void>(resolve => setImmediate(resolve));
  process.stdout.write(JSON.stringify({ stopCount }));
} finally {
  releaseWrite();
  peer.destroy();
  await server.close();
}
`);
    const { stdout } = await executeFile(process.execPath, [runner], { timeout: RUNNER_TIMEOUT_MS });
    const result: { stopCount: number } = JSON.parse(stdout);
    expect(result.stopCount).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);
