import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const executeFile = promisify(execFile);
const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
type PackResult = { filename: string; files: { path: string }[] };

async function createNpmOptions(fixtureRoot: string): Promise<string[]> {
  const userConfig = join(fixtureRoot, "user.npmrc");
  const globalConfig = join(fixtureRoot, "global.npmrc");
  await writeFile(userConfig, "");
  await writeFile(globalConfig, "");
  return ["--cache", join(fixtureRoot, "cache"), "--userconfig", userConfig, "--globalconfig", globalConfig];
}

test("配布物に録音・設定・作業記録・開発ファイルを含めない", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "voice-note-pack-test-"));
  try {
    const options = await createNpmOptions(fixtureRoot);
    const { stdout } = await executeFile("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", ...options], {
      cwd: projectDirectory, timeout: 10_000,
    });
    const results: PackResult[] = JSON.parse(stdout);
    const files = results[0]?.files.map((file) => file.path) ?? [];
    expect(files).toEqual(expect.arrayContaining(["package.json", "README.md", "LICENSE", "bin/voice-note", "src/cli.ts", "src/worker.ts"]));
    expect(files).toContain("native/translate.swift");
    const captureFiles = ["native/capture.swift", "native/capture-core.swift", "native/capture-info.plist"];
    expect(files).toEqual(expect.arrayContaining(captureFiles));
    expect(files.every((path) => ["package.json", "README.md", "LICENSE", "bin/voice-note", "native/translate.swift", ...captureFiles].includes(path)
      || /^src\/[^/]+\.ts$/u.test(path))).toBe(true);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("npmで配布物をグローバルインストールすると別の場所からvoice-noteを起動できる", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "voice-note-install-test-"));
  const packageDirectory = join(fixtureRoot, "package with spaces");
  const prefix = join(fixtureRoot, "prefix");
  try {
    const manifest: { bin: Record<string, string>; files: string[]; scripts: Record<string, string> } =
      JSON.parse(await readFile(join(projectDirectory, "package.json"), "utf8"));
    expect(manifest.scripts.postinstall).toBeUndefined();
    await mkdir(join(packageDirectory, "bin"), { recursive: true });
    await mkdir(join(packageDirectory, "src"));
    await copyFile(join(projectDirectory, "bin", "voice-note"), join(packageDirectory, "bin", "voice-note"));
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "voice-note-install-fixture", version: "0.1.0", bin: manifest.bin, files: manifest.files,
    }));
    await writeFile(join(packageDirectory, "src", "cli.ts"),
      'process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), command: process.env.VOICE_NOTE_COMMAND }));\n');
    const options = await createNpmOptions(fixtureRoot);
    const { stdout: packOutput } = await executeFile("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", fixtureRoot, ...options], {
      cwd: packageDirectory, timeout: 10_000,
    });
    const packed: PackResult[] = JSON.parse(packOutput);
    const filename = packed[0]?.filename;
    if (filename === undefined) throw new Error("配布物が生成されませんでした");
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    await executeFile("npm", ["install", "-g", join(fixtureRoot, filename), "--prefix", prefix,
      `--before=${cutoff}`, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...options], {
      cwd: fixtureRoot, timeout: 10_000,
    });
    const commandPath = join(prefix, "bin", "voice-note");
    expect(await readlink(commandPath)).toContain("voice-note-install-fixture");
    const { stdout } = await executeFile("/bin/bash", ["-c", "voice-note --help"], {
      cwd: fixtureRoot,
      env: { ...process.env, PATH: `${join(prefix, "bin")}:${process.env.PATH ?? ""}` },
      timeout: 5_000,
    });
    expect(JSON.parse(stdout)).toEqual({ arguments: ["--help"], command: "voice-note" });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
