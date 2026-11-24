import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const marker = "MCP_INTEGRATION_SENTINEL_7F3A";
const root = await mkdtemp(join(tmpdir(), "mac-terminal-mcp-it-"));
const repo = join(root, "repo");
const outside = join(root, "outside.txt");
const bareRemote = join(root, "remote.git");
const remoteWork = join(root, "remote-work");
let branchName;
let client;

const output = result => (result.content ?? []).filter(x => x.type === "text").map(x => x.text).join("\n");
const assertError = (result, pattern) => {
  assert.equal(result.isError, true, "expected MCP tool failure: " + output(result));
  if (pattern) assert.match(output(result), pattern);
};
const previewWrite = async (path, content, overwrite = false) => {
  const result = await client.callTool({ name: "preview_write", arguments: { path, content, overwrite } });
  assert.notEqual(result.isError, true, output(result));
  return JSON.parse(output(result));
};
const previewDelete = async path => {
  const result = await client.callTool({ name: "preview_delete", arguments: { path } });
  assert.notEqual(result.isError, true, output(result));
  return JSON.parse(output(result));
};

before(async () => {
  await mkdir(join(repo, "nested"), { recursive: true });
  await mkdir(join(repo, ".aws"), { recursive: true });
  await mkdir(join(repo, ".ssh"), { recursive: true });
  await mkdir(join(repo, ".AWS"), { recursive: true });
  await mkdir(join(repo, "nested", ".SSH"), { recursive: true });
  await writeFile(join(repo, "public.txt"), marker);
  await writeFile(join(repo, ".env"), marker);
  await writeFile(join(repo, "nested", ".env.local"), marker);
  await writeFile(join(repo, ".aws", "credentials"), marker);
  await writeFile(join(repo, ".ssh", "id_rsa"), marker);
  await writeFile(join(repo, "private.pem"), marker);
  await writeFile(join(repo, "PRIVATE.PEM"), marker);
  await writeFile(join(repo, ".AWS", "credentials"), marker);
  await writeFile(join(repo, "nested", ".SSH", "id_rsa"), marker);
  await writeFile(join(repo, "nested", "client.key"), marker);
  await writeFile(join(repo, "nested", "client.p12"), marker);
  await writeFile(join(repo, "nested", "client.pfx"), marker);
  await writeFile(join(repo, "nested", "app-secret.txt"), marker);
  await writeFile(join(repo, "nested", "credentials.json"), marker);
  await writeFile(join(repo, "nested", "Credentials.JSON"), marker);
  await writeFile(join(repo, "delete-me.txt"), "original");
  await writeFile(outside, "outside target");
  await symlink(outside, join(repo, "linked-file.txt"));
  await mkdir(join(root, "outside-dir"));
  await writeFile(join(root, "outside-dir", "escape.txt"), "outside");
  await symlink(join(root, "outside-dir"), join(repo, "linked-dir"));
  await writeFile(join(repo, "package.json"), JSON.stringify({
    name: "mcp-it-fixture",
    private: true,
    scripts: {
      safe: "echo SAFE_SCRIPT_SENTINEL",
      "pre-safe": "echo PRE_LIFECYCLE_SENTINEL",
      "post-safe": "echo POST_LIFECYCLE_SENTINEL"
    }
  }, null, 2));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "mcp-test-at-example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "MCP Integration"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "integration fixture"], { cwd: repo });
  branchName = execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--bare", "-q", bareRemote]);
  execFileSync("git", ["remote", "add", "origin", bareRemote], { cwd: repo });
  execFileSync("git", ["push", "-q", "-u", "origin", branchName], { cwd: repo });
  execFileSync("git", ["clone", "-q", bareRemote, remoteWork]);
  execFileSync("git", ["config", "user.email", "mcp-test-at-example.invalid"], { cwd: remoteWork });
  execFileSync("git", ["config", "user.name", "MCP Integration"], { cwd: remoteWork });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/server.js")],
    env: {
      ...process.env,
      REPO: repo,
      ALLOWED_NPM_SCRIPTS: "safe",
      COMMAND_CENTER_LOG: join(root, "command-center.log"),
      MCP_SERVER_NAME: "mac-terminal-it"
    }
  });
  client = new Client({ name: "mac-terminal-it-tests", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await rm(root, { recursive: true, force: true });
});

test("registers expected MCP tools", async () => {
  const names = new Set((await client.listTools()).tools.map(tool => tool.name));
  for (const name of ["git_sync", "search_code", "read_file", "preview_write", "write_file", "preview_delete", "delete_file", "run_npm_script", "run_command"]) {
    assert.ok(names.has(name), "missing " + name);
  }
});


test("git_sync requires explicit confirmation", async () => {
  assert.equal((await client.callTool({ name: "git_sync", arguments: {} })).isError, true);
});

test("git_sync fast-forwards and verifies the upstream commit", async () => {
  await writeFile(join(remoteWork, "remote-update.txt"), "upstream change");
  execFileSync("git", ["add", "remote-update.txt"], { cwd: remoteWork });
  execFileSync("git", ["commit", "-qm", "upstream update"], { cwd: remoteWork });
  execFileSync("git", ["push", "-q", "origin", branchName], { cwd: remoteWork });
  const result = await client.callTool({ name: "git_sync", arguments: { confirm: true } });
  assert.notEqual(result.isError, true, output(result));
  const value = JSON.parse(output(result));
  assert.equal(value.action, "fast-forwarded");
  assert.equal(value.commitsFastForwarded, 1);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), execFileSync("git", ["rev-parse", "origin/" + branchName], { cwd: repo, encoding: "utf8" }).trim());
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(), "");
});

test("git_sync reports already-up-to-date", async () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const result = await client.callTool({ name: "git_sync", arguments: { confirm: true } });
  assert.notEqual(result.isError, true, output(result));
  assert.equal(JSON.parse(output(result)).action, "already-up-to-date");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), head);
});

test("git_sync refuses tracked and untracked changes", async () => {
  await writeFile(join(repo, "public.txt"), "dirty tracked change");
  assertError(await client.callTool({ name: "git_sync", arguments: { confirm: true } }), /not clean/i);
  execFileSync("git", ["checkout", "--", "public.txt"], { cwd: repo });
  await writeFile(join(repo, "untracked-sync-test.txt"), "untracked");
  assertError(await client.callTool({ name: "git_sync", arguments: { confirm: true } }), /not clean/i);
  await rm(join(repo, "untracked-sync-test.txt"));
});

test("git_sync refuses ahead and divergent histories", async () => {
  await writeFile(join(repo, "local-only.txt"), "local commit");
  execFileSync("git", ["add", "local-only.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "local-only commit"], { cwd: repo });
  assertError(await client.callTool({ name: "git_sync", arguments: { confirm: true } }), /ahead of upstream/i);
  execFileSync("git", ["reset", "--hard", "origin/" + branchName], { cwd: repo });
  await writeFile(join(repo, "local-divergent.txt"), "local side");
  execFileSync("git", ["add", "local-divergent.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "local divergent commit"], { cwd: repo });
  await writeFile(join(remoteWork, "remote-divergent.txt"), "remote side");
  execFileSync("git", ["add", "remote-divergent.txt"], { cwd: remoteWork });
  execFileSync("git", ["commit", "-qm", "remote divergent commit"], { cwd: remoteWork });
  execFileSync("git", ["push", "-q", "origin", branchName], { cwd: remoteWork });
  assertError(await client.callTool({ name: "git_sync", arguments: { confirm: true } }), /diverged/i);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(), "");
  execFileSync("git", ["reset", "--hard", "origin/" + branchName], { cwd: repo });
});

test("git_sync refuses missing upstream and detached HEAD", async () => {
  execFileSync("git", ["branch", "--unset-upstream"], { cwd: repo });
  assertError(await client.callTool({ name: "git_sync", arguments: { confirm: true } }), /no upstream configured|no configured upstream/i);
  execFileSync("git", ["branch", "--set-upstream-to=origin/" + branchName], { cwd: repo });
  execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: repo });
  assertError(await client.callTool({ name: "git_sync", arguments: { confirm: true } }), /detached HEAD/i);
  execFileSync("git", ["checkout", "-q", branchName], { cwd: repo });
});

test("search excludes root and nested credential paths while returning public source", async () => {
  const result = await client.callTool({ name: "search_code", arguments: { query: marker } });
  const value = output(result);
  assert.match(value, /public\.txt/);
  for (const secret of [".env", ".aws/credentials", ".ssh/id_rsa", "private.pem", "PRIVATE.PEM", ".AWS/credentials", ".SSH/id_rsa", "client.key", "client.p12", "client.pfx", "app-secret.txt", "credentials.json", "Credentials.JSON"]) {
    assert.equal(value.includes(secret), false, "search leaked " + secret);
  }
});

test("read rejects symlink paths and all case-insensitive protected names", async () => {
  for (const path of [
    "linked-file.txt", "linked-dir/escape.txt", ".env", "nested/.env.local",
    ".aws/credentials", "nested/app-secret.txt", "nested/credentials.json",
    "nested/Credentials.JSON", "nested/client.key"
  ]) {
    assertError(await client.callTool({ name: "read_file", arguments: { path } }));
  }
});

test("write preflight rejects secret and credential filenames", async () => {
  for (const path of ["nested/app-secret.txt", "nested/credentials.json", "nested/Credentials.JSON"]) {
    assertError(await client.callTool({ name: "preview_write", arguments: { path, content: "must not write" } }));
  }
});

test("git_diff rejects control characters in explicit paths", async () => {
  assertError(await client.callTool({
    name: "git_diff",
    arguments: { path: "public\u0000.txt" }
  }), /safe, non-sensitive/);
});

test("write preview rejects symlink targets", async () => {
  assertError(await client.callTool({ name: "preview_write", arguments: { path: "linked-file.txt", content: "bad" } }), /Symbolic links/);
  assert.equal(await readFile(outside, "utf8"), "outside target");
});

test("write token is invalidated by an intervening file creation", async () => {
  const path = "stale-write.txt";
  const content = "approved";
  const ticket = await previewWrite(path, content);
  await writeFile(join(repo, path), "intervening change");
  assertError(await client.callTool({ name: "write_file", arguments: { path, content, preflightToken: ticket.preflightToken } }), /preflight|changed/i);
  assert.equal(await readFile(join(repo, path), "utf8"), "intervening change");
});

test("write token binds exact payload and cannot be replayed", async () => {
  const path = "payload.txt";
  const content = "approved payload";
  const ticket = await previewWrite(path, content);
  assertError(await client.callTool({ name: "write_file", arguments: { path, content: "different", preflightToken: ticket.preflightToken } }), /Preflight/);
  assertError(await client.callTool({ name: "write_file", arguments: { path, content, preflightToken: ticket.preflightToken } }), /Preflight/);
  await assert.rejects(readFile(join(repo, path)), { code: "ENOENT" });
});

test("approved write succeeds and is readable", async () => {
  const path = "created-by-mcp.txt";
  const content = "written after preview";
  const ticket = await previewWrite(path, content);
  const result = await client.callTool({ name: "write_file", arguments: { path, content, preflightToken: ticket.preflightToken } });
  assert.notEqual(result.isError, true, output(result));
  const read = await client.callTool({ name: "read_file", arguments: { path } });
  assert.equal(output(read), content);
});

test("delete token rejects a changed file", async () => {
  const ticket = await previewDelete("delete-me.txt");
  await writeFile(join(repo, "delete-me.txt"), "replacement");
  assertError(await client.callTool({ name: "delete_file", arguments: { path: "delete-me.txt", confirm: true, preflightToken: ticket.preflightToken } }), /preflight|changed/i);
  assert.equal(await readFile(join(repo, "delete-me.txt"), "utf8"), "replacement");
});

test("command runner rejects shell injection syntax", async () => {
  assertError(await client.callTool({ name: "run_command", arguments: { command: "git status --short --branch; touch injected" } }), /not approved/i);
  await assert.rejects(readFile(join(repo, "injected")), { code: "ENOENT" });
});

test("run_command permits common exact read-only Git inspection commands", async () => {
  for (const command of [
    "git status --short",
    "git status --porcelain",
    "git branch --show-current",
    "git remote -v",
    "git rev-parse HEAD",
    "git diff --cached --stat"
  ]) {
    const result = await client.callTool({ name: "run_command", arguments: { command } });
    assert.notEqual(result.isError, true, command + ": " + output(result));
  }
});

test("npm script runner disables lifecycle hooks", async () => {
  const result = await client.callTool({ name: "run_npm_script", arguments: { script: "safe" } });
  assert.notEqual(result.isError, true, output(result));
  assert.match(output(result), /SAFE_SCRIPT_SENTINEL/);
  assert.doesNotMatch(output(result), /PRE_LIFECYCLE_SENTINEL|POST_LIFECYCLE_SENTINEL/);
});

test("npm script runner enforces configured allowlist", async () => {
  assertError(await client.callTool({ name: "run_npm_script", arguments: { script: "pre-safe" } }), /not in ALLOWED_NPM_SCRIPTS/);
});
test("path traversal is rejected by file tools", async () => {
  for (const name of ["../outside.txt", "nested/../../outside.txt"]) {
    assertError(await client.callTool({ name: "read_file", arguments: { path: name } }));
    assertError(await client.callTool({ name: "preview_write", arguments: { path: name, content: "no" } }));
  }
  assert.equal(await readFile(outside, "utf8"), "outside target");
});

test("overwrite preview is bound to the original content hash", async () => {
  const path = "overwrite-target.txt";
  await writeFile(join(repo, path), "before");
  const ticket = await previewWrite(path, "approved replacement", true);
  await writeFile(join(repo, path), "intervening replacement");
  const result = await client.callTool({ name: "write_file", arguments: { path, content: "approved replacement", overwrite: true, preflightToken: ticket.preflightToken } });
  assertError(result, /preflight|changed/i);
  assert.equal(await readFile(join(repo, path), "utf8"), "intervening replacement");
});

test("personal information findings are informational and do not block writes", async () => {
  const path = "personal-info.txt";
  const email = ["joe", "@", "example", ".com"].join("");
  const content = "Contact " + email;
  const ticket = await previewWrite(path, content);
  assert.equal(ticket.reviewRequired, false);
  assert.ok(ticket.findings.some(finding => finding.category === "email_address"));
  const result = await client.callTool({ name: "write_file", arguments: { path, content, preflightToken: ticket.preflightToken } });
  assert.notEqual(result.isError, true, output(result));
  assert.equal(await readFile(join(repo, path), "utf8"), content);
});

test("credential findings still require explicit acknowledgement", async () => {
  const path = "high-risk-content.txt";
  const content = "AWS_ACCESS_KEY_ID=" + ["AKIA", "1234567890ABCDEF"].join("");
  const ticket = await previewWrite(path, content);
  assert.equal(ticket.reviewRequired, true);
  assertError(await client.callTool({ name: "write_file", arguments: { path, content, preflightToken: ticket.preflightToken } }), /high-risk credentials/i);
});

test("approved deletion removes the exact preflighted file", async () => {
  const path = "delete-success.txt";
  await writeFile(join(repo, path), "remove me");
  const ticket = await previewDelete(path);
  const result = await client.callTool({ name: "delete_file", arguments: { path, confirm: true, preflightToken: ticket.preflightToken } });
  assert.notEqual(result.isError, true, output(result));
  await assert.rejects(readFile(join(repo, path)), { code: "ENOENT" });
});
test("git_diff excludes sensitive content and rejects explicit sensitive paths", async () => {
  const sensitive = "DIFF_SECRET_SENTINEL_4B2C";
  await writeFile(join(repo, ".env"), "TOKEN=" + sensitive);
  await writeFile(join(repo, ".AWS", "credentials"), "TOKEN=" + sensitive);
  await writeFile(join(repo, "nested", ".SSH", "id_rsa"), "TOKEN=" + sensitive);
  await writeFile(join(repo, "PRIVATE.PEM"), sensitive);
  await writeFile(join(repo, "nested", "Credentials.JSON"), sensitive);
  await writeFile(join(repo, "public.txt"), "public file changed");
  const result = await client.callTool({ name: "git_diff", arguments: {} });
  const value = output(result);
  assert.match(value, /public file changed/);
  assert.doesNotMatch(value, new RegExp(sensitive));
  assertError(await client.callTool({ name: "git_diff", arguments: { path: ".env" } }), /non-sensitive/);
  assertError(await client.callTool({ name: "git_diff", arguments: { path: "nested/credentials.json" } }), /non-sensitive/);
  assertError(await client.callTool({ name: "git_diff", arguments: { path: "PRIVATE.PEM" } }), /non-sensitive/);
});