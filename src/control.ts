import { createHash } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LEGACY_CONTROL_SOCKET, RUN_DIR } from "./config.ts";
import type { ControlResponse, RunState } from "./domain.ts";
import { hasSessionStateFile, readState, writeState } from "./state.ts";

type ControlAction = "status" | "stop";
type StopRecording = () => void;

function controlSocketPath(sessionDirectory: string): string {
  const sessionKey = createHash("sha256").update(resolve(sessionDirectory)).digest("hex").slice(0, 32);
  return join(RUN_DIR, `control-${sessionKey}.sock`);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((field) => typeof field === "string");
}

function readResponse(value: unknown): ControlResponse | undefined {
  return isStringRecord(value) ? value : undefined;
}

async function handleControlSocket(socket: Socket, sessionDirectory: string, stopRecording: StopRecording): Promise<void> {
  socket.setTimeout(2_000);
  let requestText = "";

  const responsePromise = new Promise<RunState | ControlResponse>((resolveResponse) => {
    socket.on("data", (chunk) => {
      requestText += chunk.toString("utf8");
      if (requestText.length > 1_024) {
        resolveResponse({ phase: "unknown", error: "invalid request" });
        socket.destroy();
        return;
      }
      const newlineIndex = requestText.indexOf("\n");
      if (newlineIndex < 0) return;
      let requestJson: unknown;
      try {
        requestJson = JSON.parse(requestText.slice(0, newlineIndex));
      } catch {
        resolveResponse({ phase: "unknown", error: "invalid request" });
        return;
      }
      const action = typeof requestJson === "object" && requestJson !== null && "action" in requestJson
        ? requestJson.action
        : undefined;
      void (async () => {
        if (action === "stop") {
          const state = await readState(sessionDirectory);
          if (state.phase === "starting" || state.phase === "recording") {
            stopRecording();
            resolveResponse(await writeState("stopping", sessionDirectory));
            return;
          }
          resolveResponse(state);
          return;
        }
        if (action === "status") {
          resolveResponse(await readState(sessionDirectory));
          return;
        }
        resolveResponse({ phase: "unknown", error: "unknown action" });
      })().catch(() => resolveResponse({ phase: "unknown", error: "invalid request" }));
    });
    socket.once("timeout", () => resolveResponse({ phase: "unknown", error: "request timeout" }));
    socket.once("error", () => resolveResponse({ phase: "unknown", error: "invalid request" }));
  });

  const response = await responsePromise;
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

export async function startControlServer(
  sessionDirectory: string,
  stopRecording: StopRecording,
): Promise<Readonly<{ close: () => Promise<void> }>> {
  const socketPath = controlSocketPath(sessionDirectory);
  await unlink(socketPath).catch(() => undefined);
  const server: Server = createServer((socket) => {
    void handleControlSocket(socket, sessionDirectory, stopRecording).catch(() => socket.destroy());
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  return {
    async close() {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
      await unlink(socketPath).catch(() => undefined);
    },
  };
}

async function sendControlToSocket(socketPath: string, action: ControlAction): Promise<ControlResponse | undefined> {
  const connection = createConnection(socketPath);
  return new Promise((resolveResponse) => {
    let responseText = "";
    let resolved = false;
    const finish = (response?: ControlResponse) => {
      if (resolved) return;
      resolved = true;
      connection.destroy();
      resolveResponse(response);
    };

    connection.setTimeout(500);
    connection.once("connect", () => connection.write(`${JSON.stringify({ action })}\n`));
    connection.on("data", (chunk) => {
      responseText += chunk.toString("utf8");
      if (responseText.length > 8_192) {
        finish();
        return;
      }
      const newlineIndex = responseText.indexOf("\n");
      if (newlineIndex < 0) return;
      try {
        const responseJson: unknown = JSON.parse(responseText.slice(0, newlineIndex));
        finish(readResponse(responseJson));
      } catch {
        finish();
      }
    });
    connection.once("error", () => finish());
    connection.once("timeout", () => finish());
    connection.once("end", () => finish());
  });
}

export async function sendControl(action: ControlAction, sessionDirectory?: string): Promise<ControlResponse | undefined> {
  const savedState = sessionDirectory === undefined ? await readState() : await readState(sessionDirectory);
  const targetSessionDirectory = sessionDirectory ?? savedState.session_dir;
  if (targetSessionDirectory === undefined) return undefined;

  const sessionResponse = await sendControlToSocket(controlSocketPath(targetSessionDirectory), action);
  if (sessionResponse !== undefined || await hasSessionStateFile(targetSessionDirectory)) return sessionResponse;

  const currentState = await readState();
  if (currentState.session_dir !== targetSessionDirectory) return undefined;
  return sendControlToSocket(LEGACY_CONTROL_SOCKET, action);
}
