# Connect the Mac Terminal MCP server in ChatGPT

This guide follows OpenAI's current custom MCP connection flow. Menu availability, permissions, and publishing rights depend on the ChatGPT plan and workspace.

## Before connecting

- Build and start the local MCP server through your Secure MCP Tunnel profile.
- Confirm the profile passes the required `REPO` environment variable and optional `ALLOWED_REPOS` environment variable to the MCP process.
- Confirm the tunnel is available to the target ChatGPT workspace.
- Review the twelve tools and their permission boundaries before connecting. Writes and deletions require a preflight preview and a short-lived one-use token.

## In ChatGPT

1. Open ChatGPT on the web.
2. Open **Plugins**.
3. Select the **+** button, then choose **Add custom MCP server**.
4. Enter an app name and optional description.
5. Under **Connection**, choose **Tunnel**.
6. Select an available Secure MCP Tunnel or enter the tunnel ID from your tunnel configuration.
7. Configure authentication for the connection.
8. Review the risk warning and select **I understand and want to continue**.
9. Select **Create as a plugin**.
10. Review the discovered tools and metadata, then install the resulting plugin.

## Verify the connection

1. Start a new ChatGPT conversation.
2. Type **@** in the prompt box and select the installed plugin.
3. Ask it to check Git status or show the current branch.
4. Confirm the response comes from the repository configured in `REPO`.
5. Confirm the local Command Center log viewer receives the tool execution output.

## Important security notes

- Do not paste tunnel API keys into ChatGPT.
- Do not publish the tunnel profile, Keychain item, tunnel identifier, or credentials.
- The server does not load `.env` automatically; pass configuration through the tunnel launch environment.
- `REPO` determines the default filesystem scope. `ALLOWED_REPOS` may add named, explicit project directories. Tools select one configured alias per call; do not point any entry at your home directory or filesystem root.
- Run `preview_write` before every `write_file`, and `preview_delete` before every `delete_file`. Review findings, hashes, target path, and overwrite status before proceeding.
- Preflight checks are heuristic. They redact detected credential-like values and flag possible personal data, but cannot guarantee detection of every sensitive value.
- Only scripts explicitly configured in `ALLOWED_NPM_SCRIPTS` can be run through `run_npm_script`. Treat the selected script as executable code from that repository; use this tool only with repositories you trust. The runner disables npm pre/post lifecycle hooks, but it does not sandbox the requested script.
- `search_code` and `git_diff` exclude common credential paths and key/certificate files; `git_diff` rejects explicit requests for sensitive paths.
- The command runner is allowlisted and is not a general-purpose shell.

For current plan availability, workspace permissions, and administrator controls, see [Connecting custom MCP servers in ChatGPT](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).