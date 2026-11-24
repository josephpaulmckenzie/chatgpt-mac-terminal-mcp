import { createWriteStream } from 'node:fs';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { PreflightTicketStore, scanSensitiveContent, sha256Text } from "./writePreflight.js";
import { deleteRegularFile, isProtectedRepositoryPath, readRegularFile, resolveRepositoryFile, writeRegularFile } from "./fileSafety.js";
import { tmpdir } from "node:os";

const repoValue = process.env.REPO?.trim();
if (!repoValue) {
  throw new Error("REPO is required. Set it to the absolute path of the repository this MCP server may access.");
}
if (!isAbsolute(repoValue)) {
  throw new Error("REPO must be an absolute filesystem path.");
}

const DEFAULT_REPO = await realpath(resolve(repoValue));
const configuredRepositories = new Map<string, string>([["default", DEFAULT_REPO]]);
for (const entry of (process.env.ALLOWED_REPOS ?? "").split(";").map(value => value.trim()).filter(Boolean)) {
  const separator = entry.indexOf("=");
  if (separator <= 0) throw new Error("ALLOWED_REPOS entries must use alias=/absolute/path format, separated by semicolons.");
  const alias = entry.slice(0, separator).trim();
  const path = entry.slice(separator + 1).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(alias) || alias === "default") {
    throw new Error("ALLOWED_REPOS aliases must use letters, numbers, underscores, or hyphens; 'default' is reserved.");
  }
  if (!isAbsolute(path)) throw new Error(`Repository path for '${alias}' must be absolute.`);
  if (configuredRepositories.has(alias)) throw new Error(`Duplicate repository alias: ${alias}`);
  configuredRepositories.set(alias, await realpath(resolve(path)));
}
async function getRepository(alias = "default"): Promise<string> {
  const repository = configuredRepositories.get(alias);
  if (!repository) throw new Error(`Unknown repository '${alias}'. Available: ${[...configuredRepositories.keys()].join(", ")}`);
  return repository;
}
const COMMAND_CENTER_LOG_PATH = resolve(
  process.env.COMMAND_CENTER_LOG?.trim() ||
  resolve(tmpdir(), "chatgpt-mac-terminal-command-center.log")
);
const SERVER_NAME = process.env.MCP_SERVER_NAME?.trim() || "mac-terminal";
const configuredNpmScripts = (process.env.ALLOWED_NPM_SCRIPTS ?? "build,test,typecheck")
  .split(",")
  .map(script => script.trim())
  .filter(Boolean);

if (configuredNpmScripts.some(script => !/^[a-zA-Z0-9:_-]+$/.test(script))) {
  throw new Error("ALLOWED_NPM_SCRIPTS may contain only letters, numbers, colon, underscore, and hyphen.");
}

const allowedNpmScripts = new Set(configuredNpmScripts);
const MAX_OUTPUT = 150_000;
const preflightTickets = new PreflightTicketStore();

async function currentFileSha256(path: string): Promise<string | null> {
  try {
    return sha256Text(await readRegularFile(path, MAX_OUTPUT));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}


const commandCenterLog = createWriteStream(
  COMMAND_CENTER_LOG_PATH,
  { flags: "a" }
);

commandCenterLog.on("error", (error) => {
  process.stderr.write("[Command Center log error] " + error.message + "\n");
});

async function run(
  command: string,
  args: string[],
  timeout = 30_000,
  cwd = DEFAULT_REPO
): Promise<string> {
  const display = [command, ...args]
    .map(part => /\s/.test(part) ? JSON.stringify(part) : part)
    .join(" ");

  const startedAt = Date.now();
  const startedLabel = new Date(startedAt).toLocaleString();

  const supportsColor =
    Boolean(process.stderr.isTTY) &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb";

  const c = {
    reset: "\u001b[0m",
    cyan: "\u001b[36m",
    green: "\u001b[32m",
    red: "\u001b[31m",
    yellow: "\u001b[33m",
    muted: "\u001b[90m",
    bold: "\u001b[1m"
  };

  const paint = (value: string, color: string): string =>
    supportsColor ? color + value + c.reset : value;

  const panel = (rows: string[]): string => {
    const width = 58;
    const top = "╔" + "═".repeat(width) + "╗";
    const bottom = "╚" + "═".repeat(width) + "╝";
    const lines = rows.map(value =>
      "║ " + value.slice(0, width - 2).padEnd(width - 2) + " ║"
    );
    return [top, ...lines, bottom].join("\n");
  };

  const header = panel([
    "MAC TERMINAL  /  COMMAND CENTER",
    "MAC TERMINAL EXECUTION",
    "",
    "STATUS       RUNNING",
    "COMMAND      " + display,
    "STARTED      " + startedLabel
  ]);

  commandCenterLog.write(
    paint(header, c.cyan) +
    "\n\n" +
    paint("  LIVE OUTPUT", c.bold) +
    "\n  " + "─".repeat(54) + "\n\n"
  );

  return await new Promise<string>((resolveRun) => {
    let output = "";
    let truncated = false;
    let timedOut = false;
    let finished = false;

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer): void => {
      const value = chunk.toString();

      // Preserve live command output in Terminal.
      commandCenterLog.write(value);

      // Preserve the original output for ChatGPT.
      const remaining = MAX_OUTPUT - output.length;

      if (remaining > 0) {
        output += value.slice(0, remaining);
      }

      if (value.length > remaining) {
        truncated = true;
      }
    };

    const finish = (exitCode: number, detail = ""): void => {
      if (finished) return;
      finished = true;

      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);

      if (detail) {
        commandCenterLog.write(detail);
        const remaining = MAX_OUTPUT - output.length;

        if (remaining > 0) {
          output += detail.slice(0, remaining);
        } else {
          truncated = true;
        }
      }

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
      const plain = output.replace(/\u001b\[[0-9;]*m/g, "");

      const passed = plain.match(/\b(\d+)\s+passed\b/i)?.[1];
      const failed = plain.match(/\b(\d+)\s+failed\b/i)?.[1];
      const filesPassed = plain.match(/Test Files\s+(\d+)\s+passed/i)?.[1];

      const status = exitCode === 0 ? "SUCCESS" : "FAILED";
      const statusColor = exitCode === 0 ? c.green : c.red;

      const rows = [
        "MAC TERMINAL  /  EXECUTION REPORT",
        "",
        "RESULT       " + status,
        "EXIT CODE    " + exitCode,
        "ELAPSED      " + elapsed + " seconds",
        ""
      ];

      if (passed !== undefined || failed !== undefined) {
        rows.push("TESTS PASSED " + (passed ?? "0"));
        rows.push("TESTS FAILED " + (failed ?? "0"));
      }

      if (filesPassed !== undefined) {
        rows.push("FILES PASSED " + filesPassed);
      }

      rows.push("");
      rows.push("COMMAND      " + display);

      const summary = panel(rows);

      commandCenterLog.write(
        "\n\n" +
        paint(summary, statusColor) +
        "\n"
      );

      const truncationNote = truncated
        ? "\n[ChatGPT output truncated at " + MAX_OUTPUT +
          " characters; full output was printed in Terminal.]"
        : "";

      resolveRun(
        header +
        "\n\nLIVE OUTPUT\n" +
        output +
        truncationNote +
        "\n\n" +
        summary +
        "\n"
      );
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    child.once("error", (error: Error) => {
      finish(127, "\n[spawn error] " + error.message);
    });

    child.once("close", (code, signal) => {
      const exitCode = timedOut ? 124 : (code ?? 1);

      const detail = timedOut
        ? "\n[Command timed out after " + timeout + "ms]"
        : signal
          ? "\n[Terminated by " + signal + "]"
          : "";

      finish(exitCode, detail);
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");

      killHandle = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2_000);
    }, timeout);
  });
}

const server = new McpServer({
  name: SERVER_NAME,
  version: "1.0.0"
});

server.tool(
  "git_status",
  "Read-only Git status for the configured repository.",
  { repository: z.string().default("default") },
  async ({ repository }) => ({
    content: [{
      type: "text",
      text: await run("git", ["status", "--short", "--branch"], 30_000, await getRepository(repository))
    }]
  })
);

server.tool(
  "git_branches",
  "List local and remote Git branches.",
  { repository: z.string().default("default") },
  async ({ repository }) => ({
    content: [{
      type: "text",
      text: await run("git", ["branch", "--all", "--no-color"], 30_000, await getRepository(repository))
    }]
  })
);

server.tool(
  "git_log",
  "Show the latest 20 commits.",
  { repository: z.string().default("default") },
  async ({ repository }) => ({
    content: [{
      type: "text",
      text: await run("git", [
        "log", "-20",
        "--date=iso",
        "--pretty=format:%h %ad %an %s"
      ], 30_000, await getRepository(repository))
    }]
  })
);

server.tool(
  "search_code",
  "Search tracked repository source using Git grep.",
  { query: z.string().min(1).max(300), repository: z.string().default("default") },
  async ({ query, repository }) => ({
    content: [{
      type: "text",
      text: await run("git", [
        "grep", "-n", "-I", "-E", query, "--", ".",
        ":(exclude,icase,glob)**/.env", ":(exclude,icase,glob)**/.env.*",
        ":(exclude,icase,glob)**/.aws/**", ":(exclude,icase,glob)**/.ssh/**",
        ":(exclude,icase,glob)**/*.pem", ":(exclude,icase,glob)**/*.key", ":(exclude,icase,glob)**/*.p12", ":(exclude,icase,glob)**/*.pfx",
        ":(exclude,icase,glob)**/*secret*", ":(exclude,icase,glob)**/*credential*"
      ], 30_000, await getRepository(repository))
    }]
  })
);

server.tool(
  "read_file",
  "Read a repository file, excluding sensitive files and paths outside the repository.",
  { path: z.string().min(1).max(500), repository: z.string().default("default") },
  async ({ path, repository }) => {
    try {
      const file = await resolveRepositoryFile(await getRepository(repository), path);
      const content = (await readRegularFile(file, MAX_OUTPUT)).toString("utf8");

      return {
        content: [{
          type: "text",
          text: content.slice(0, MAX_OUTPUT)
        }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: String(error)
        }]
      };
    }
  }
);

server.tool(
  "preview_write",
  "Read-only preflight for a proposed write. Reports file hashes and possible sensitive content. Returns a short-lived token required by write_file.",
  {
    path: z.string().trim().min(1).max(500),
    content: z.string().max(MAX_OUTPUT),
    overwrite: z.boolean().default(false),
    repository: z.string().default("default")
  },
  async ({ path, content, overwrite, repository }) => {
    try {
      const repo = await getRepository(repository);
      const target = await resolveRepositoryFile(repo, path, true);
      const currentSha256 = await currentFileSha256(target);
      if (currentSha256 !== null && !overwrite) {
        throw new Error("Target exists; set overwrite=true to preview an overwrite.");
      }
      const proposedSha256 = sha256Text(content);
      const findings = scanSensitiveContent(content);
      const preflightToken = preflightTickets.issue({
        operation: "write", repository: repo, path, overwrite,
        currentSha256, proposedSha256, findings
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            operation: "write", repository, path, overwrite,
            currentSha256, proposedSha256,
            bytes: Buffer.byteLength(content, "utf8"),
            findings, reviewRequired: findings.length > 0,
            preflightToken, tokenExpiresInSeconds: 300
          }, null, 2)
        }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error) }] };
    }
  }
);

server.tool(
  "write_file",
  "Create or update a regular file only after preview_write. The one-use token binds the exact repository, path, content hash, and current file hash.",
  {
    path: z.string().trim().min(1).max(500),
    content: z.string().max(MAX_OUTPUT),
    overwrite: z.boolean().default(false),
    preflightToken: z.string().min(1).max(100),
    acknowledgeFindings: z.boolean().default(false),
    repository: z.string().default("default")
  },
  async ({ path, content, overwrite, preflightToken, acknowledgeFindings, repository }) => {
    try {
      const repo = await getRepository(repository);
      const target = await resolveRepositoryFile(repo, path, true);
      const currentSha256 = await currentFileSha256(target);
      const proposedSha256 = sha256Text(content);
      const ticket = preflightTickets.consume(preflightToken, {
        operation: "write", repository: repo, path, overwrite,
        currentSha256, proposedSha256
      });
      if (!ticket) {
        throw new Error("Preflight missing, expired, already used, or file/payload changed. Run preview_write again.");
      }
      if (ticket.findings.length > 0 && !acknowledgeFindings) {
        throw new Error("Preflight found possible personal or sensitive data. Review findings and explicitly acknowledge them.");
      }
      if (!overwrite) {
        await writeRegularFile(target, content, false, null);
      } else {
        await writeRegularFile(target, content, true, currentSha256);
      }
      return {
        content: [{
          type: "text",
          text: (overwrite ? "Updated " : "Created ") + path + " (" + Buffer.byteLength(content, "utf8") + " bytes; preflight verified)."
        }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error) }] };
    }
  }
);


server.tool(
  "preview_delete",
  "Read-only preflight for deleting a regular file. Reports its SHA-256 and returns a short-lived token required by delete_file.",
  {
    path: z.string().trim().min(1).max(500),
    repository: z.string().default("default")
  },
  async ({ path, repository }) => {
    try {
      const repo = await getRepository(repository);
      const target = await resolveRepositoryFile(repo, path);
      const currentSha256 = await currentFileSha256(target);
      if (currentSha256 === null) throw new Error("Target no longer exists.");
      const preflightToken = preflightTickets.issue({
        operation: "delete", repository: repo, path, overwrite: false,
        currentSha256, proposedSha256: null, findings: []
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            operation: "delete", repository, path, currentSha256,
            preflightToken, tokenExpiresInSeconds: 300
          }, null, 2)
        }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error) }] };
    }
  }
);

server.tool(
  "delete_file",
  "Delete one regular file only after preview_delete. Requires confirm=true and a one-use token bound to the current file hash.",
  {
    path: z.string().trim().min(1).max(500),
    confirm: z.literal(true),
    preflightToken: z.string().min(1).max(100),
    repository: z.string().default("default")
  },
  async ({ path, preflightToken, repository }) => {
    try {
      const repo = await getRepository(repository);
      const target = await resolveRepositoryFile(repo, path);
      const currentSha256 = await currentFileSha256(target);
      const ticket = preflightTickets.consume(preflightToken, {
        operation: "delete", repository: repo, path, overwrite: false,
        currentSha256, proposedSha256: null
      });
      if (!ticket) {
        throw new Error("Preflight missing, expired, already used, or file changed. Run preview_delete again.");
      }
      if (currentSha256 === null) throw new Error("Target no longer exists.");
      await deleteRegularFile(target, currentSha256);
      return {
        content: [{
          type: "text",
          text: "Deleted " + path + " (preflight verified)."
        }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error) }] };
    }
  }
);

server.tool(
  "git_diff",
  "Show Git changes while excluding credential files and sensitive paths. An explicitly selected sensitive path is rejected.",
  {
    staged: z.boolean().default(false),
    path: z.string().trim().min(1).max(500).optional(),
    repository: z.string().default("default")
  },
  async ({ staged, path, repository }) => {
    const args = ["diff", "--no-ext-diff", "--no-color"];
    if (staged) args.push("--cached");
    const exclusions = [
      ":(exclude,icase,glob)**/.env",
      ":(exclude,icase,glob)**/.env.*",
      ":(exclude,icase,glob)**/.aws/**",
      ":(exclude,icase,glob)**/.ssh/**",
      ":(exclude,icase,glob)**/*.pem",
      ":(exclude,icase,glob)**/*.key",
      ":(exclude,icase,glob)**/*.p12",
      ":(exclude,icase,glob)**/*.pfx",
      ":(exclude,icase,glob)**/*secret*",
      ":(exclude,icase,glob)**/*credential*"
    ];
    if (path !== undefined) {
      const normalized = path.replaceAll("\\", "/");
      const segments = normalized.split("/");
      if (
        isAbsolute(path) ||
        segments.some(segment => segment === "." || segment === ".." || segment.length === 0) ||
        /[\\u0000-\\u001f]/.test(path) ||
        path.startsWith(":") ||
        isProtectedRepositoryPath(normalized)
      ) {
        return {
          isError: true,
          content: [{ type: "text", text: "Diff path must be a safe, non-sensitive repository-relative path." }]
        };
      }
      args.push("--", ":(literal)" + normalized, ...exclusions);
    } else {
      args.push("--", ".", ...exclusions);
    }

    return {
      content: [{
        type: "text",
        text: await run("git", args, 30_000, await getRepository(repository))
      }]
    };
  }
);

server.tool(
  "run_npm_script",
  "Run one npm script explicitly included in ALLOWED_NPM_SCRIPTS for the configured repository.",
  {
    script: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9:_-]+$/),
    repository: z.string().default("default")
  },
  async ({ script, repository }) => {
    const repo = await getRepository(repository);
    const packageJson = JSON.parse(
      await readFile(resolve(repo, "package.json"), "utf8")
    );

    if (!allowedNpmScripts.has(script)) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Script is not in ALLOWED_NPM_SCRIPTS: ${script}`
        }]
      };
    }

    if (!packageJson.scripts?.[script]) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Script not found in package.json: ${script}`
        }]
      };
    }

    return {
      content: [{
        type: "text",
        text: await run("npm", ["--ignore-scripts", "run", script], 600_000, repo)
      }]
    };
  }
);

server.tool(
  "run_command",
  "Execute an exact allowlisted read-only command in the configured repository and stream its output to the Mac Terminal.",
  { command: z.string().trim().min(1).max(300), repository: z.string().default("default") },
  async ({ command, repository }) => {
    const repo = await getRepository(repository);
    const parts = command.trim().split(/\s+/);
    const executable = parts.shift() ?? "";
    const args = parts;

    const allowedCommands = [
      ["pwd"],
      ["date"],
      ["whoami"],
      ["hostname"],
      ["node", "--version"],
      ["node", "-v"],
      ["npm", "--version"],
      ["npm", "-v"],
      ["ls"],
      ["ls", "-la"],
      ["ls", "-la", "."],
      ["du", "-sh", "."],
      ["find", ".", "-maxdepth", "2", "-type", "f"],
      ["git", "status"],
      ["git", "status", "--short", "--branch"],
      ["git", "log", "-5", "--oneline"],
      ["git", "branch", "--all", "--no-color"],
      ["git", "diff", "--stat"],
      ["git", "diff", "--check"],
      ["git", "diff", "--name-only"],
      ["git", "rev-parse", "--show-toplevel"],
    ];

    const approved = allowedCommands.some(
      candidate =>
        candidate.length === parts.length + 1 &&
        candidate[0] === executable &&
        candidate.slice(1).every((value, index) => value === args[index])
    );

    if (!approved) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: "Command not approved. Read-only commands only."
        }]
      };
    }

    const output = await run(executable, args, 30_000, repo);

    return {
      content: [{
        type: "text",
        text: output
      }]
    };
  }
);


const transport = new StdioServerTransport();
await server.connect(transport);