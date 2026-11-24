import assert from "node:assert/strict";
import test from "node:test";
import { link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteRegularFile, readRegularFile, resolveRepositoryFile, writeRegularFile } from "./dist/fileSafety.js";
import { sha256Text } from "./dist/writePreflight.js";
import { openSecureLog } from "./dist/secureLog.js";
import { once } from "node:events";

async function withRepo(run) {
  const root = await mkdtemp(join(tmpdir(), "mcp-file-safety-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("rejects symlink leaf and symlinked parent paths", async () => withRepo(async root => {
  const outside = join(root, "..", "outside-secret.txt");
  await writeFile(outside, "private");
  await symlink(outside, join(root, "alias.txt"));
  await assert.rejects(resolveRepositoryFile(root, "alias.txt"), /Symbolic links/);
  await mkdir(join(root, "real"));
  await symlink(join(root, "real"), join(root, "linked-dir"));
  await assert.rejects(resolveRepositoryFile(root, "linked-dir/file.txt", true), /Symbolic links/);
  await rm(outside, { force: true });
}));

test("rejects protected names regardless of directory depth", async () => withRepo(async root => {
  await mkdir(join(root, "nested"));
  await assert.rejects(resolveRepositoryFile(root, "nested/.env"));
  await assert.rejects(resolveRepositoryFile(root, "nested/client.key"));
  await assert.rejects(resolveRepositoryFile(root, "nested/.aws/config"));
}));

test("creates files exclusively and refuses to overwrite an existing target", async () => withRepo(async root => {
  const path = join(root, "new.txt");
  await writeRegularFile(path, "first", false, null);
  await assert.equal(await readFile(path, "utf8"), "first");
  await assert.rejects(writeRegularFile(path, "second", false, null), { code: "EEXIST" });
}));

test("overwrites only the preflighted file content", async () => withRepo(async root => {
  const path = join(root, "note.txt");
  await writeFile(path, "before");
  await assert.rejects(writeRegularFile(path, "after", true, sha256Text("different")), /changed after preflight/);
  await writeRegularFile(path, "after", true, sha256Text("before"));
  await assert.equal(await readFile(path, "utf8"), "after");
}));

test("reads only regular files within the size cap", async () => withRepo(async root => {
  const path = join(root, "note.txt");
  await writeFile(path, "12345");
  await assert.equal((await readRegularFile(path, 5)).toString(), "12345");
  await assert.rejects(readRegularFile(path, 4), /size limit/);
}));

test("deletes only the exact preflighted file", async () => withRepo(async root => {
  const path = join(root, "note.txt");
  await writeFile(path, "keep");
  await assert.rejects(deleteRegularFile(path, sha256Text("changed")), /changed after preflight/);
  await deleteRegularFile(path, sha256Text("keep"));
  await assert.rejects(readFile(path));
}));
test("command log refuses symlinks and hard links and enforces private permissions", async () => withRepo(async root => {
  const logPath = join(root, "command.log");
  const stream = await openSecureLog(logPath);
  const finished = once(stream, "finish");
  stream.end("private log entry");
  await finished;
  assert.equal(await readFile(logPath, "utf8"), "private log entry");
  assert.equal((await lstat(logPath)).mode & 0o777, 0o600);

  const target = join(root, "target.log");
  await writeFile(target, "do not append");
  const symlinkPath = join(root, "symlink.log");
  await symlink(target, symlinkPath);
  await assert.rejects(openSecureLog(symlinkPath));

  const linkedPath = join(root, "linked.log");
  await writeFile(linkedPath, "shared");
  await link(linkedPath, join(root, "linked-copy.log"));
  await assert.rejects(openSecureLog(linkedPath), /hard links/);
}));

test("serializes concurrent overwrites against one preflight hash", async () => withRepo(async root => {
  const path = join(root, "concurrent.txt");
  await writeFile(path, "original");
  const results = await Promise.allSettled([
    writeRegularFile(path, "first writer", true, sha256Text("original")),
    writeRegularFile(path, "second writer", true, sha256Text("original"))
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.ok(["first writer", "second writer"].includes(await readFile(path, "utf8")));
}));

test("serializes concurrent deletions and deletes at most once", async () => withRepo(async root => {
  const path = join(root, "concurrent-delete.txt");
  await writeFile(path, "delete once");
  const results = await Promise.allSettled([
    deleteRegularFile(path, sha256Text("delete once")),
    deleteRegularFile(path, sha256Text("delete once"))
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  await assert.rejects(readFile(path));
}));