# Command Center

The Command Center is a local text dashboard for commands invoked through the MCP server. It writes the command header, streamed process output, and completion summary to the path configured by COMMAND_CENTER_LOG.

## Install the bundled viewer

From the repository root, install the viewer in ~/bin:

    mkdir -p "$HOME/bin"
    install -m 755 scripts/cv-command-center "$HOME/bin/cv-command-center"

Start it in a second Terminal window:

    "$HOME/bin/cv-command-center"

The viewer defaults to /tmp/chatgpt-mac-terminal-command-center.log. Override it by setting COMMAND_CENTER_LOG before launching the viewer.

## Keep the tunnel and viewer on the same log path

The MCP server and viewer must use the exact same COMMAND_CENTER_LOG value. Configure the tunnel profile to pass this environment variable to the MCP server:

    COMMAND_CENTER_LOG=/tmp/chatgpt-mac-terminal-command-center.log

If you launch the tunnel manually from a shell, export the variable before starting the tunnel:

    export COMMAND_CENTER_LOG="/tmp/chatgpt-mac-terminal-command-center.log"
    # Start the tunnel with your normal tunnel command.

Do not assume Node.js temporary-directory defaults to /tmp on macOS. Setting the explicit path on both sides avoids the viewer watching a different file.

## Normal operation

- Terminal window 1 runs the secure tunnel and MCP server.
- Terminal window 2 runs cv-command-center and displays the dashboard.
- When ChatGPT invokes an MCP command, the viewer displays the command, live output, result, exit code, and elapsed time.
- Press Control-C in the viewer window to stop only the viewer. The tunnel and MCP server continue running.

The dashboard is a local log viewer. It does not change command permissions, expand the command allowlist, or grant additional access. The log file itself is local and should not be committed.
