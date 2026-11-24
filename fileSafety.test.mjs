import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteRegularFile, readRegularFile, resolveRepositoryFile, writeRegularFile } from "./dist/fileSafety.js";
import { sha256Text } from "./dist/writePreflight.js";

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