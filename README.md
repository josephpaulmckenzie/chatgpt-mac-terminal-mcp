# ChatGPT Mac Terminal MCP

A small local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
server that connects ChatGPT to a deliberately scoped set of developer tools
on a Mac. This project packages the implementation used for the Collectors
Vault Mac Terminal connection, with machine-specific configuration excluded.

The included server exposes these tools:

- `git_status`
- `git_branches`
- `git_log`
- `search_code`
- `read_file`
- `run_npm_script`
- `run_command`

The command runner is intentionally allowlisted. It is not a general-purpose
remote shell. Keep that restriction unless you have designed, reviewed, and
tested a separate permission model.

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
Allowlisted tools operating in REPO
```

The Command Center writes formatted execution output to a local log file so a
second Terminal window can display it with `tail -f`. The log is local and is
not part of this repository.

## Requirements

- macOS
- Node.js (the original setup used Node 24)
- npm
- Git
- GitHub CLI (`gh`) if you want to publish your own copy
- A supported Secure MCP Tunnel client and account/connection
- A ChatGPT account/workspace where custom MCP connections are available

## 1. Clone and install

```bash
git clone https://github.com/OWNER/chatgpt-mac-terminal-mcp.git
cd chatgpt-mac-terminal-mcp
npm ci
```

If the repository does not include a lockfile, use `npm install` instead.

## 2. Configure the repository scope

The MCP server must operate only inside the repository you intend to expose.
Set `REPO` to that repository's absolute path in the local MCP server launch
configuration. Start from `.env.example` as a reference; do not commit real
environment files or credentials.

Example:

```text
REPO=/Users/you/Documents/Code/your-project
```

Review `src/server.ts` before use. In particular, verify the command allowlist,
path validation, output limits, and timeouts match your security requirements.

## 3. Install and configure the tunnel client

Install the Secure MCP Tunnel client from the distribution provided for your
account/platform. Place the executable at the path expected by your local
launch command, or update that command to match its actual location.

Create a tunnel profile that launches the MCP server as a local stdio process.
Use the server's Node entry point/build output and pass the required
environment, including `REPO`. Keep the profile local: do not publish it if it
contains a tunnel identifier, credential, account-specific endpoint, or local
filesystem path.

The original Mac setup used:

- Tunnel profile name: `collectors-vault-mac`
- Executable: `~/bin/tunnel-client`
- MCP project directory: `~/.local/share/collectors-vault-mcp`
- Node installed through `nvm`

Those are examples from one installation, not values to copy blindly.

## 4. Store the tunnel credential in macOS Keychain

Do not put the tunnel API key in this repository, a shell script, a `.env` file,
or a ChatGPT message. Store it in macOS Keychain using the service/account
names required by your tunnel client configuration.

The original setup retrieved it at launch time with `security
find-generic-password`; the key itself was never written into the command or
repository. Follow the tunnel provider's current instructions for creating the
Keychain item and setting the expected environment variable.

## 5. Start the tunnel

The original installation used this launch pattern. Replace the profile and
credential service/account values with the values from your own tunnel setup:

```bash
export CONTROL_PLANE_TUNNEL_ID="YOUR_TUNNEL_ID"
export CONTROL_PLANE_API_KEY="$(security find-generic-password -s YOUR_KEYCHAIN_SERVICE -a "$USER" -w)" || exit 1
"$HOME/bin/tunnel-client" run --profile YOUR_PROFILE_NAME
```

Never commit the real tunnel ID, API key, or profile YAML. Keep this Terminal
window running while ChatGPT uses the connection.

## 6. Configure ChatGPT

The following describes the custom MCP connection flow used in the original
setup. ChatGPT labels and availability can vary by plan, workspace, and product
release; follow the current UI shown in your account if labels differ.

1. Open ChatGPT in a desktop web browser.
2. Open **Settings** and locate **Plugins** / the custom MCP app area.
3. Choose **Add** (`+`) and select **Add custom MCP server**.
4. Enter an app name (for example, `Collectors Vault Mac Terminal`) and a
   description explaining the tools and repository scope.
5. Under **Connection**, choose **Tunnel** and select the Secure MCP Tunnel
   connection/profile you configured.
6. Configure the authentication method required by the tunnel.
7. Review the security warning and the tools/permissions being exposed.
8. Choose **Create as a plugin** (or the equivalent action displayed).
9. Install/enable the app for use in conversations.
10. Start a new conversation and invoke one of the exposed tools.

Only connect a server you control. Review every tool's behavior and do not
expose unrestricted shell access, secrets, or unrelated directories.

## 7. Enable the Command Center log viewer

The MCP server writes its formatted execution display to:

```text
/tmp/collectors-vault-command-center.log
```

Open a second Terminal window and run:

```bash
touch /tmp/collectors-vault-command-center.log
tail -n 0 -f /tmp/collectors-vault-command-center.log
```

Leave this window open. In the first Terminal window, start/restart the tunnel.
When ChatGPT invokes a tool, the second window should show the Command Center
header, live output, and execution report.

To stop the viewer, press `Control-C` in the second window. This does not stop
the tunnel.

## 8. Try it from ChatGPT

Examples of plain-English requests:

- "Check my Git status."
- "Show me the latest commits."
- "Find where the app handles Cognito callbacks."
- "Run the authentication tests."
- "Build the application."

The server only supports commands explicitly implemented and allowlisted in
`src/server.ts`. A natural-language request does not bypass those restrictions.

## Security checklist

Before publishing or deploying:

- [ ] No API keys, tunnel credentials, tokens, private keys, or `.env` files.
- [ ] No account-specific tunnel IDs or local profile YAML.
- [ ] `REPO` points only to the intended project.
- [ ] File access rejects paths outside the repository.
- [ ] Shell commands are allowlisted and argument handling is reviewed.
- [ ] Output limits and execution timeouts are enabled.
- [ ] Every exposed tool is understood and tested.
- [ ] The tunnel is authenticated and the ChatGPT connection is limited to the
      intended user/workspace.

## License

Choose and add a license before encouraging reuse. Until a license is added,
all rights are reserved by default.
