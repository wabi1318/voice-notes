import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

test.skipIf(process.platform !== "darwin").each(["pending-close", "close-failure"] as const)("要約への移行時に%sでも共有ロックを残さない", async (scenario) => {
  const root = await mkdtemp("/private/tmp/vn-summary-lock-");
  try {
    const runner = join(root, "runner.ts");
    await writeFile(runner, `import { mock } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const project = ${JSON.stringify(project)};
const root = ${JSON.stringify(root)};
process.env.VOICE_NOTE_RUN_DIR = join(root,"run");
process.env.VOICE_NOTE_DISABLE_NOTIFICATIONS = "1";
await mkdir(join(root,"bin"));
await writeFile(join(root,"bin/codex"),"#!/bin/sh\\nexit 0\\n",{mode:0o700});
process.env.PATH = join(root,"bin") + ":" + (process.env.PATH ?? "");
const processesPath = join(project,"src/processes.ts");
const processes = await import(processesPath);
const spawnCommand = processes.startCommand;
let launchReached = false;
mock.module(processesPath,()=>({...processes,startCommand:(command,args,options)=>{
  if(args.includes(join(project,"src/worker.ts"))) { launchReached = true; throw new Error("synthetic recording launch"); }
  return spawnCommand(command,args,options);
}}));
mock.module(join(project,"src/native-capture.ts"),()=>({prepareNativeCapture:async()=>"unused"}));
let finishSummary = () => {};
let enterSummary = () => {};
const summaryGate = new Promise<void>(resolve => { finishSummary = resolve; });
const summaryStarted = new Promise<void>(resolve => { enterSummary = resolve; });
mock.module(join(project,"src/summary.ts"),()=>({analyzeTranscript:async(raw)=>{
  enterSummary(); await summaryGate;
  return {result_path:raw+".result",summary_path:raw+".summary",title_created:false};
}}));
const {writeState,readState} = await import(join(project,"src/state.ts"));
const {analyzeSessionTranscript,startCapture} = await import(join(project,"src/worker.ts"));
const {tryAcquireProcessLock,isProcessLockActive} = await import(join(project,"src/locks.ts"));
const {START_LOCK,sessionWorkLockPath} = await import(join(project,"src/config.ts"));
const session = join(root,"old-session"); await mkdir(session);
const raw = join(session,"raw.vtt"); await writeFile(raw,"WEBVTT\\n\\n00:00.000 --> 00:01.000\\n<v Mic>fixture speech\\n");
await writeState("starting",session,{raw_path:raw}); await writeState("recorded",session);
let enterClose = () => {};
let finishClose = () => {};
const closeStarted = new Promise<void>(resolve => { enterClose = resolve; });
const closeGate = new Promise<void>(resolve => { finishClose = resolve; });
const work = analyzeSessionTranscript(session,raw,{closeControlServer:async()=>{
  enterClose(); await closeGate;
  if(${JSON.stringify(scenario)} === "close-failure") throw new Error("synthetic close failure");
}}).then(()=>"completed",error=>error instanceof Error ? error.message : String(error));
try {
  await closeStarted;
  const duringClose = await tryAcquireProcessLock(START_LOCK);
  const availableDuringClose = duringClose.kind === "acquired";
  if(duringClose.kind === "acquired") await duringClose.lock.release();
  let phaseDuringNextStart;
  if(${JSON.stringify(scenario)} === "pending-close") {
    try { await startCapture(join(root,"new-recordings"),"","off"); } catch {}
    phaseDuringNextStart = (await readState(session)).phase;
  }
  finishClose();
  if(${JSON.stringify(scenario)} === "pending-close") await summaryStarted;
  finishSummary();
  const outcome = await work;
  process.stdout.write(JSON.stringify({availableDuringClose,launchReached,phaseDuringNextStart,outcome,
    phase:(await readState(session)).phase,workLocked:await isProcessLockActive(sessionWorkLockPath(session)),
    startLocked:await isProcessLockActive(START_LOCK)}));
} finally {finishClose();finishSummary();await work;}
`);
    const { stdout, stderr } = await executeFile(process.execPath, [runner], { timeout: 10_000 });
    const result: { availableDuringClose: boolean; launchReached: boolean; phaseDuringNextStart?: string; outcome: string; phase: string; workLocked: boolean; startLocked: boolean } = JSON.parse(stdout);
    expect(result.availableDuringClose).toBe(true);
    expect(result.workLocked).toBe(false);
    expect(result.startLocked).toBe(false);
    const diagnostics: { event: string; pid: number; session_key: string }[] = stderr.split("\n")
      .filter((line) => line.startsWith("[worker-diagnostic] "))
      .map((line) => JSON.parse(line.slice("[worker-diagnostic] ".length)));
    const events = diagnostics.map((entry) => entry.event);
    expect(events).toContain("analysis_lock_released");
    expect(events.indexOf("analysis_lock_released")).toBeLessThan(events.indexOf("control_close_started"));
    expect(stderr).not.toContain(root);
    expect(stderr).not.toContain("fixture speech");
    if (scenario === "pending-close") {
      expect(result.launchReached).toBe(true);
      expect(result.phaseDuringNextStart).toBe("analyzing");
      expect(result.phase).toBe("completed");
    } else {
      expect(result.outcome).toBe("synthetic close failure");
      expect(result.phase).toBe("failed");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);

test.skipIf(process.platform !== "darwin")("前の要約が未完了でも次の録音が開始して原文を保存する", async () => {
  const root = await mkdtemp("/private/tmp/vnpar-");
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const capture = join(root, "capture");
    await writeFile(capture, `#!/usr/bin/env bun
process.on("SIGINT",()=>process.exit(0));
process.stdout.write("WEBVTT\\n\\n00:00.000 --> 00:01.000\\n<v Mic>fixture recording\\n\\n");
setInterval(()=>{},1000);
`, { mode: 0o700 });
    const runner = join(root, "runner.ts");
    await writeFile(runner, `import {mock} from "bun:test";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
const project=${JSON.stringify(project)};
const root=${JSON.stringify(root)};
process.env.VOICE_NOTE_RUN_DIR=join(root,"run");
process.env.VOICE_NOTE_DISABLE_NOTIFICATIONS="1";
process.env.PATH=join(root,"bin")+":"+(process.env.PATH??"");
let worker;
const runningWorkers:Promise<void>[]=[];
const processesPath=join(project,"src/processes.ts");
const processes=await import(processesPath);
const spawnCommand=processes.startCommand;
mock.module(processesPath,()=>({...processes,startCommand:(command,args,options)=>{
 if(args.includes(join(project,"src/worker.ts"))){
  runningWorkers.push(worker.runWorker(args[2],args[3]));
  return spawnCommand("/usr/bin/true",[],options);
 }
 return spawnCommand(command,args,options);
}}));
mock.module(join(project,"src/native-capture.ts"),()=>({prepareNativeCapture:async()=>${JSON.stringify(capture)}}));
let releaseSummaries=()=>{};
let enterSummary=()=>{};
const summaryGate=new Promise<void>(resolve=>{releaseSummaries=resolve;});
const summaryStarted=new Promise<void>(resolve=>{enterSummary=resolve;});
mock.module(join(project,"src/summary.ts"),()=>({analyzeTranscript:async(raw)=>{
 enterSummary();await summaryGate;
 return{result_path:raw+".result",summary_path:raw+".summary",title_created:false};
}}));
worker=await import(join(project,"src/worker.ts"));
const {readState}=await import(join(project,"src/state.ts"));
const {sendControl}=await import(join(project,"src/control.ts"));
let oldSession;
let nextSession;
try{
 await worker.startCapture(join(root,"sessions"),"","off");
 oldSession=(await readState()).session_dir;
 await worker.stopCapture();
 await summaryStarted;
 await worker.startCapture(join(root,"sessions"),"","off");
 nextSession=(await readState()).session_dir;
 const nextStatus=await worker.getPublicStatus(nextSession);
 const oldStatus=await worker.getPublicStatus(oldSession);
 const raw=await readFile(join(nextSession,"raw.vtt"),"utf8");
 process.stdout.write(JSON.stringify({differentSession:nextSession!==oldSession,nextPhase:nextStatus.phase,
   oldPhase:oldStatus.phase,captionSaved:raw.includes("fixture recording")}));
}finally{
 if(nextSession)await sendControl("stop",nextSession);
 if(oldSession)await sendControl("stop",oldSession);
 releaseSummaries();
 await Promise.all(runningWorkers);
}
`);
    const { stdout } = await executeFile(process.execPath, [runner], { timeout: 12_000 });
    const result: { differentSession: boolean; nextPhase: string; oldPhase: string; captionSaved: boolean } = JSON.parse(stdout);
    expect(result).toEqual({ differentSession: true, nextPhase: "recording", oldPhase: "analyzing", captionSaved: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
