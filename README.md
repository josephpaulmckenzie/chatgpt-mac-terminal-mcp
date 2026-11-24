# ChatGPT Mac Terminal MCP

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects ChatGPT to a deliberately scoped set of developer tools on a Mac. This project packages the implementation used for the original Collectors Vault Mac Terminal connection and makes its repository scope configurable for other projects.

The server exposes twelve tools:

- `git_status`
- `git_branches`
- `git_log`
- `search_code`
- `read_file`
- `preview_write` (read-only content scan and hash-bound approval ticket)
- `write_file` (requires a matching, one-use `preview_write` ticket)
- `preview_delete` (read-only file hash and approval ticket)
- `delete_file` (requires a matching, one-use `preview_delete` ticket)
- `run_npm_script`
- `run_command`
- `git_diff`

Every write and deletion must first pass its matching preflight tool. Write preflight scans proposed content for likely names, email addresses, phone numbers, street addresses, local filesystem paths, AWS access keys, GitHub tokens, and private-key markers. Sensitive values are redacted in findings. Possible names are treated as review candidates, not verified identities. A preflight ticket expires after five minutes, is single-use, and is bound to the exact repository, path, operation, and SHA-256 hashes of the current and proposed content. Changes between preview and execution invalidate the ticket. Findings require explicit acknowledgement on the write call. These checks are heuristics, not a guarantee that all sensitive information will be detected.

The command runner is intentionally allowlisted. It is not a general-purpose remote shell. `write_file` and `delete_file` reject sensitive paths and symlinks, and use no-follow file handles plus descriptor-based identity/content checks. Node's standard filesystem API does not provide a fully race-free directory-descriptor-relative unlink operation, so a hostile process concurrently replacing parent directories remains outside the guarantee. New files are created exclusively with restrictive permissions; updating an existing file requires `overwrite=true`. `read_file` rejects symlinks in every path component and caps reads at the output limit. `search_code` and `git_diff` exclude common credential directories, environment files, and key/certificate files (case-insensitively); `git_diff` also rejects explicitly requested sensitive paths. `run_npm_script` executes repository-defined code: only use it in repositories you trust. It passes `--ignore-scripts` to prevent npm pre/post lifecycle hooks, but the explicitly selected script itself is not sandboxed.

## Architecture

```text
ChatGPT conversation
       |
       v
ChatGPT custom MCP app / plugin connection
       |
       v
Secure MCP tunnel client
       |
       v
Local MCP server (stdio)
       |
       v
Configured repository (REPO)
```

The Command Center writes formatted execution output to a local log file so a second Terminal window can display it with `tail -f`. The log is local and is not part of this repository.

## Requirements

- macOS
- Node.js 24 or a currently supported Node.js LTS release
- npm
- Git
- A supported Secure MCP Tunnel client and account/connection
- A ChatGPT account/workspace that permits custom MCP server connections

## 1. Clone and build the MCP server

```bash
git clone https://github.com/josephpaulmckenzie/chatgpt-mac-terminal-mcp.git
cd chatgpt-mac-terminal-mcp
npm ci
npm run build
```

The compiled server entry point is `dist/server.js`.

## 2. Configure the repository scope

Set these environment variables in the local tunnel profile or in the wrapper that launches the MCP server. The server does **not** automatically load a `.env` file; `.env.example` documents the supported variables.

```text
REPO=/absolute/path/to/your/default/project
ALLOWED_REPOS=collectors-vault=/path/to/collectors-vault;mac-terminal-mcp=/path/to/chatgpt-mac-terminal-mcp
MCP_SERVER_NAME=mac-terminal
COMMAND_CENTER_LOG=/tmp/chatgpt-mac-terminal-command-center.log
ALLOWED_NPM_SCRIPTS=build,test,typecheck
```

- `REPO` is required and must be an absolute path to an existing directory. It is exposed to tools as the `default` repository.
- `ALLOWED_REPOS` optionally adds named repository roots using `alias=/absolute/path` entries separated by semicolons. Each alias is passed through the tools' `repository` parameter. Every configured path must exist when the server starts. Tools remain confined to the selected repository; paths outside it are rejected.
- `MCP_SERVER_NAME` is an optional server label.
- `COMMAND_CENTER_LOG` is an optional absolute path for the local dashboard log. It defaults to the system temporary directory.
- `ALLOWED_NPM_SCRIPTS` is a comma-separated allowlist for `run_npm_script`. Each requested script must also exist in the target repository's `package.json`. The default is `build,test,typecheck`; specify only scripts you have reviewed.

Review `src/server.ts` before use. In particular, verify the command allowlist, path validation, output limits, and timeouts match your security requirements.

## 3. Configure the tunnel client

Install the Secure MCP Tunnel client supplied for your account/platform. Configure a local tunnel profile that starts the compiled MCP server as a stdio process using Node.js and `dist/server.js`. The profile must pass the environment variables above to the MCP process.

Use the tunnel client's current documentation for profile syntax and startup options. Keep the profile local: do not publish it if it contains a tunnel identifier, credential, account-specific endpoint, or local filesystem path.

The original Mac setup used these local names:

- Tunnel profile: `collectors-vault-mac`
- Tunnel executable: `~/bin/tunnel-client`
- Original MCP source directory: `~/.local/share/collectors-vault-mcp`
- Node installed through `nvm`

Those are examples from one installation, not values that other users need to copy.

## 4. Store the tunnel credential in macOS Keychain

Do not put the tunnel API key in this repository, a shell script, a `.env` file, or a ChatGPT message. Store it in macOS Keychain using the service/account names required by your tunnel client configuration.

The original setup retrieved the credential at launch time with macOS `security find-generic-password`; the key itself was never written into the command or repository. Follow your tunnel provider's current instructions for creating the Keychain item and setting the expected environment variable.

## 5. Start the tunnel

Start the tunnel using the profile you configured. Keep the tunnel process running while ChatGPT uses the connection. The MCP process should receive `REPO`, `MCP_SERVER_NAME`, `COMMAND_CENTER_LOG`, and `ALLOWED_NPM_SCRIPTS` through its environment.

Never commit the real tunnel ID, API key, or profile YAML.

## 6. Connect the tunnel in ChatGPT

Custom MCP connections are managed through ChatGPT's Plugins experience. Availability and required workspace permissions vary by plan and organization.

1. Open ChatGPT on the web.
2. Open **Plugins**.
3. Select the **+** button, then choose **Add custom MCP server**.
4. Enter a name and optional description.
5. Under **Connection**, choose **Tunnel**. Select an available Secure MCP Tunnel or enter the tunnel ID provided by your tunnel setup.
6. Configure authentication as required by the connection.
7. Review the risk warning and select **I understand and want to continue**.
8. Select **Create as a plugin**, then review the discovered tools and metadata.
9. Install the resulting plugin.
10. Start a conversation, type **@**, select your plugin, and try a harmless read-only request.

Custom MCP access is subject to ChatGPT plan and workspace policy. For current requirements and administrator controls, see [OpenAI's custom MCP connection guide](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).

Only connect a server you control. Review the tools and permissions before enabling the connection.

## 7. Enable the Command Center log viewer

The repository includes a reusable viewer script at `scripts/cv-command-center`. From the repository root, install it once:

    mkdir -p "$HOME/bin"
    install -m 755 scripts/cv-command-center "$HOME/bin/cv-command-center"

Configure the tunnel profile to pass this exact value to the MCP server:

    COMMAND_CENTER_LOG=/tmp/chatgpt-mac-terminal-command-center.log

Then open a second Terminal window and run:

    "$HOME/bin/cv-command-center"

The tunnel and viewer must use the same `COMMAND_CENTER_LOG` value. Set it explicitly; Node.js temporary-directory defaults on macOS may not be `/tmp`. See [docs/COMMAND-CENTER.md](docs/COMMAND-CENTER.md) for manual overrides and troubleshooting.

Leave the viewer window open. In the first Terminal window, keep the tunnel running. When ChatGPT invokes a tool, the second window displays the Command Center header, streamed output, and execution report.

To stop the viewer, press `Control-C` in the second window. This does not stop the tunnel.

## 8. Try it from ChatGPT

Examples:

- "Check my Git status."
- "Show me the latest commits."
- "Find where the app handles authentication callbacks."
- "Run the test script."

The server tools accept an optional `repository` alias (defaulting to `default`). For example, select `collectors-vault` or `mac-terminal-mcp` when those aliases are configured in `ALLOWED_REPOS`. The server only runs npm scripts included in `ALLOWED_NPM_SCRIPTS` and present in the selected repository's `package.json`. The separate `run_command` tool supports only exact commands implemented in its allowlist. Natural-language requests do not bypass those restrictions.

## Security checklist

Before using or sharing a connection:

- [ ] No API keys, tunnel credentials, tokens, private keys, or real `.env` files are committed.
- [ ] No account-specific tunnel IDs or local profile YAML are published.
- [ ] `REPO` points only to the intended project directory.
- [ ] File access rejects paths outside the repository.
- [ ] Shell commands are allowlisted and argument handling is reviewed.
- [ ] File writes and deletions require one-use preflight tickets; repository-relative regular files only; sensitive paths and symlinks are rejected.
- [ ] npm scripts are limited by `ALLOWED_NPM_SCRIPTS`.
- [ ] Output limits and execution timeouts are enabled.
- [ ] Every exposed tool is understood and tested.
- [ ] The tunnel is authenticated and the ChatGPT connection is limited to the intended user/workspace.

## License

No license is currently included. Until a license is added, all rights are reserved by default.