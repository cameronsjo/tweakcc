# Example Hook Scripts

Ready-to-use hook scripts for tweakcc's event system.

## Installation

1. Copy the scripts you want to use:
   ```bash
   mkdir -p ~/.tweakcc/hooks
   cp log-tools.sh ~/.tweakcc/hooks/
   chmod +x ~/.tweakcc/hooks/log-tools.sh
   ```

2. Add the hook to your config (see each script for config example)

3. Apply changes:
   ```bash
   npx tweakcc --apply
   ```

## Available Scripts

### `log-tools.sh`
Logs all tool executions to a file.
- **Events**: `tool:before`, `tool:after`
- **Output**: `~/.tweakcc/tools.log`

### `notify-complete.sh`
Desktop notification when Claude finishes responding.
- **Events**: `stream:end`
- **Platforms**: macOS (osascript), Linux (notify-send)

### `audit-bash.sh`
Detailed audit log for Bash commands with safety alerts.
- **Events**: `tool:before` (filtered to Bash only)
- **Output**: `~/.tweakcc/bash-audit.log`
- **Features**: Alerts on dangerous command patterns

### `telemetry-server.js`
Node.js webhook server for collecting events.
- **Events**: Any (configure as webhook)
- **Endpoints**:
  - `POST /events` - Receive events
  - `GET /events` - View recent events (JSON)
  - `GET /health` - Health check

## Example Config

Full `config.json` with multiple hooks:

```json
{
  "settings": {
    "events": {
      "enabled": true,
      "hooks": [
        {
          "id": "log-tools",
          "name": "Log tool usage",
          "events": ["tool:before", "tool:after"],
          "type": "command",
          "command": "~/.tweakcc/hooks/log-tools.sh",
          "enabled": true
        },
        {
          "id": "notify",
          "name": "Notify on complete",
          "events": "stream:end",
          "type": "command",
          "command": "~/.tweakcc/hooks/notify-complete.sh",
          "enabled": true
        },
        {
          "id": "audit-bash",
          "name": "Audit Bash commands",
          "events": "tool:before",
          "type": "command",
          "command": "~/.tweakcc/hooks/audit-bash.sh",
          "enabled": true,
          "filter": {
            "tools": ["Bash"]
          }
        },
        {
          "id": "telemetry",
          "name": "Send to telemetry server",
          "events": ["tool:after", "stream:end"],
          "type": "webhook",
          "webhook": "http://localhost:9000/events",
          "enabled": false
        }
      ],
      "logging": {
        "enabled": true,
        "logFile": "~/.tweakcc/events.log",
        "logLevel": "info"
      }
    }
  }
}
```

## Writing Your Own Hooks

### Environment Variables

Your hook receives these variables:

| Variable | Description |
|----------|-------------|
| `TWEAKCC_EVENT` | Event name (e.g., `tool:before`) |
| `TWEAKCC_DATA` | Full event data as JSON |
| `TWEAKCC_HOOK_ID` | Your hook's ID |
| `TWEAKCC_HOOK_NAME` | Your hook's name |
| `TWEAKCC_TOOL_NAME` | Tool name (for tool events) |
| `TWEAKCC_TOOL_ID` | Tool use ID (for tool events) |

### Tips

1. **Keep hooks fast** - Async hooks (default) don't block, but sync hooks do
2. **Handle errors gracefully** - Use `onError: "continue"` to prevent crashes
3. **Use filters** - Reduce noise by filtering to specific tools
4. **Test locally** - Use `tweakcc hooks test <event>` before applying
