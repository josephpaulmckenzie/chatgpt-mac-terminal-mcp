import { createWriteStream } from 'node:fs';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readFile, realpath, lstat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
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

async function safePath(repository: string, relativePath: string): Promise<string> {
  const root = await realpath(repository);
  const candidate = await realpath(resolve(root, relativePath));

  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error("Access outside the repository is prohibited.");
  }

  const normalized = relativePath.replaceAll("\\", "/");
  const blocked = /(^|\/)(\.env($|\.)|\.aws|\.ssh|secrets?)(\/|$)|\.(pem|key)$/i;

  if (blocked.test(normalized)) {
    throw new Error("Access to sensitive files is prohibited.");
  }

  return candidate;
}

async function safeWritePath(repository: string, relativePath: string): Promise<string> {
  if (relativePath.trim().length === 0 || isAbsolute(relativePath)) {
    throw new Error("A non-empty repository-relative path is required.");
  }

  const normalized = relativePath.replaceAll("\\\\", "/");
  const blocked = /(^|\\/)(\\.env($|\\.)|\\.git|node_modules|\\.aws|\\.ssh|secrets?)(\\/|$)|\\.(pem|key|p12|pfx)$/i;
  if (blocked.test(normalized) || normalized.split("/").some(part => part === "." || part === "..")) {
    throw new Error("Writing to sensitive or non-repository paths is prohibited.");
  }

  const root = await realpath(repository);
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error("Writing outside the repository is prohibited.");
  }

  const parent = await realpath(resolve(candidate, ".."));
  if (parent !== root && !parent.startsWith(root + sep)) {
    throw new Error("Writing outside the repository is prohibited.");
  }

  try {
    const target = await lstat(candidate);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new Error("Only regular files may be updated; symbolic links and directories are prohibited.");
    }
    await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return candidate;
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
        ":(exclude).env",
        ":(exclude).env.*",
        ":(exclude)**/*.pem",
        ":(exclude)**/*secret*"
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
      const file = await safePath(await getRepository(repository), path);
      const content = await readFile(file, "utf8");

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
  "write_file",
  "Create or update a regular text file inside the selected repository. Sensitive paths, symlinks, and paths outside the repository are rejected. Existing files require overwrite=true.",
  {
    path: z.string().trim().min(1).max(500),
    content: z.string().max(MAX_OUTPUT),
    overwrite: z.boolean().default(false),
    repository: z.string().default("default")
  },
  async ({ path, content, overwrite, repository }) => {
    try {
      const target = await safeWritePath(await getRepository(repository), path);
      if (!overwrite) {
        await writeFile(target, content, { encoding: "utf8", flag: "wx" });
      } else {
        await writeFile(target, content, { encoding: "utf8", flag: "w" });
      }
      return {
        content: [{
          type: "text",
          text: (overwrite ? "Updated " : "Created ") + path + " (" + Buffer.byteLength(content, "utf8") + " bytes)."
        }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: String(error) }]
      };
    }
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
        text: await run("npm", ["run", script], 600_000, repo)
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
