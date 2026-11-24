# Command Center

The Command Center is a local text dashboard for commands invoked through the
MCP server. It writes the header, streamed process output, and completion
summary to `/tmp/collectors-vault-command-center.log`.

Start a viewer in a second Terminal window:

```bash
touch /tmp/collectors-vault-command-center.log
tail -n 0 -f /tmp/collectors-vault-command-center.log
```

The first Terminal window runs the tunnel. The second displays the dashboard.
When the tunnel starts the MCP server as a child process, tool output is
written to the shared local log file.

The dashboard reports the command, start time, result, exit code, elapsed time,
and parsed test counts when available. It does not change the underlying
command permissions or grant additional access.
