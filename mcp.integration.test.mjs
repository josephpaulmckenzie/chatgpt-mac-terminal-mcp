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
  for (const name of ["search_code", "read_file", "preview_write", "write_file", "preview_delete", "delete_file", "run_npm_script", "run_command"]) {
    assert.ok(names.has(name), "missing " + name);
  }
});

test("search excludes root and nested credential paths while returning public source", async () => {
  const result = await client.callTool({ name: "search_code", arguments: { query: marker } });
  const value = output(result);
  assert.match(value, /public\.txt/);
  for (const secret of [".env", ".aws/credentials", ".ssh/id_rsa", "private.pem", "PRIVATE.PEM", ".AWS/credentials", ".SSH/id_rsa", "client.key", "client.p12", "client.pfx", "app-secret.txt", "credentials.json", "Credentials.JSON"]) {
    assert.equal(value.includes(secret), false, "search leaked " + secret);
  }
});

test("read rejects symlink paths and protected files", async () => {
  for (const path of ["linked-file.txt", "linked-dir/escape.txt", ".env", "nested/.env.local", ".aws/credentials"]) {
    assertError(await client.callTool({ name: "read_file", arguments: { path } }));
  }
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

test("sensitive-content findings require explicit acknowledgement", async () => {
  const path = "review-required.txt";
  const email = ["joe", "@", "example", ".com"].join("");
  const content = "Contact " + email;
  const ticket = await previewWrite(path, content);
  assert.equal(ticket.reviewRequired, true);
  assert.ok(ticket.findings.some(finding => finding.category === "email_address"));
  assertError(await client.callTool({ name: "write_file", arguments: { path, content, preflightToken: ticket.preflightToken } }), /acknowledge/i);
  const refreshed = await previewWrite(path, content);
  const approved = await client.callTool({ name: "write_file", arguments: { path, content, preflightToken: refreshed.preflightToken, acknowledgeFindings: true } });
  assert.notEqual(approved.isError, true, output(approved));
  assert.equal(await readFile(join(repo, path), "utf8"), content);
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