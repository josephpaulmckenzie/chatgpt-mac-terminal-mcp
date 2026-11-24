# ChatGPT custom MCP connection setup

This guide records the custom MCP connection flow used for the original Mac
Terminal integration. The exact menu names and availability may change across
ChatGPT plans, workspaces, and product versions.

## In ChatGPT

1. Open ChatGPT in a web browser.
2. Open **Settings**.
3. Find **Plugins** / the custom MCP app area.
4. Select **+** and choose **Add custom MCP server**.
5. Set the app name and description.
6. In **Connection**, select **Tunnel**.
7. Choose the Secure MCP Tunnel connection/profile created on the Mac.
8. Configure the authentication option required by that tunnel.
9. Review the security warning and the list of tools.
10. Select **Create as a plugin** (or the equivalent current action).
11. Install/enable the app, then use it in a conversation.

## Verify the connection

Ask ChatGPT to check Git status or run a small, harmless allowlisted command.
Confirm that the response comes from the local repository and that the local
Command Center log viewer receives the execution output.

## Important

Do not paste tunnel API keys into ChatGPT. Do not publish the tunnel profile,
Keychain item, tunnel identifier, or any credentials. The tunnel should provide
the authenticated bridge; the MCP server should expose only the tools you
intentionally reviewed.
