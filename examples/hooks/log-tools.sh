#!/bin/bash
# Log all tool executions to a file
#
# Usage: Add to config.json:
# {
#   "id": "log-tools",
#   "events": ["tool:before", "tool:after"],
#   "type": "command",
#   "command": "~/.tweakcc/hooks/log-tools.sh",
#   "enabled": true
# }

LOG_FILE="${TWEAKCC_LOG_FILE:-$HOME/.tweakcc/tools.log}"

# Create log directory if needed
mkdir -p "$(dirname "$LOG_FILE")"

# Parse event data
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
TOOL_NAME="${TWEAKCC_TOOL_NAME:-unknown}"
EVENT="${TWEAKCC_EVENT:-unknown}"

# Log the event
echo "[$TIMESTAMP] $EVENT: $TOOL_NAME" >> "$LOG_FILE"

# Optionally log full data for debugging
if [ "$TWEAKCC_DEBUG" = "1" ]; then
    echo "  Data: $TWEAKCC_DATA" >> "$LOG_FILE"
fi
