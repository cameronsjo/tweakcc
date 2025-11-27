#!/bin/bash
# Send desktop notification when Claude finishes responding
#
# Usage: Add to config.json:
# {
#   "id": "notify-complete",
#   "events": "stream:end",
#   "type": "command",
#   "command": "~/.tweakcc/hooks/notify-complete.sh",
#   "enabled": true
# }
#
# Requirements:
#   - macOS: Built-in (uses osascript)
#   - Linux: notify-send (libnotify)
#   - Windows: Not supported (use webhook instead)

TITLE="Claude Code"
MESSAGE="Response complete"

# Detect OS and send notification
case "$(uname -s)" in
    Darwin)
        # macOS
        osascript -e "display notification \"$MESSAGE\" with title \"$TITLE\""
        ;;
    Linux)
        # Linux with libnotify
        if command -v notify-send &> /dev/null; then
            notify-send "$TITLE" "$MESSAGE"
        fi
        ;;
esac
