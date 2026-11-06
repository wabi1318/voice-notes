import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { listNestedFolders } from "../src/storage.ts";

test("親子関係を保ち、同じ階層のフォルダをファイル更新順に表示する", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "voice-note-folder-order-")));
  try {
    const records = [
      { folder: "チームA/会議2", modifiedAt: new Date("2026-10-08T03:00:00Z") },
      { folder: "イベント", modifiedAt: new Date("2026-10-08T02:00:00Z") },
      { folder: "チームA/会議1", modifiedAt: new Date("2026-10-08T01:00:00Z") },
    ];
    for (const record of records) {
      const session = join(root, record.folder, "20261008-100000-12345678");
      await mkdir(session, { recursive: true, mode: 0o700 });
      const rawPath = join(session, "raw.vtt");
      await writeFile(rawPath, "テスト記録");
      await utimes(rawPath, record.modifiedAt, record.modifiedAt);
    }
    const listFolders = async () => (await listNestedFolders(root)).map((path) => relative(root, path));
    expect(await listFolders()).toEqual(["チームA", "チームA/会議2", "チームA/会議1", "イベント"]);

    const updatedAt = new Date("2026-10-08T04:00:00Z");
    await utimes(join(root, "チームA/会議1/20261008-100000-12345678/raw.vtt"), updatedAt, updatedAt);
    expect(await listFolders()).toEqual(["チームA", "チームA/会議1", "チームA/会議2", "イベント"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
