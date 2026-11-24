# Command Center

The Command Center is a local text dashboard for commands invoked through the MCP server. It writes the header, streamed process output, and completion summary to the path configured by `COMMAND_CENTER_LOG`.

On macOS, the default is:

```text
/tmp/chatgpt-mac-terminal-command-center.log
```

Start a viewer in a second Terminal window:

```bash
LOG_FILE="${COMMAND_CENTER_LOG:-/tmp/chatgpt-mac-terminal-command-center.log}"
touch "$LOG_FILE"
tail -n 0 -f "$LOG_FILE"
```

The first Terminal window runs the tunnel. The second displays the dashboard. When the tunnel starts the MCP server as a stdio process, tool output is written to the shared local log file.

The dashboard reports the command, start time, result, exit code, elapsed time, and parsed test counts when available. It does not change the underlying command permissions or grant additional access.

To stop the viewer, press `Control-C` in the second Terminal window. The tunnel and MCP server continue running.
