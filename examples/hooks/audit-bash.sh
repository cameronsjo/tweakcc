#!/bin/bash
# Audit log for Bash tool executions with command details
#
# Usage: Add to config.json:
# {
#   "id": "audit-bash",
#   "events": ["tool:before"],
#   "type": "command",
#   "command": "~/.tweakcc/hooks/audit-bash.sh",
#   "enabled": true,
#   "filter": {
#     "tools": ["Bash"]
#   }
# }
#
# Creates detailed audit log of all Bash commands Claude executes

AUDIT_FILE="${TWEAKCC_AUDIT_FILE:-$HOME/.tweakcc/bash-audit.log}"
mkdir -p "$(dirname "$AUDIT_FILE")"

# Parse the JSON data to extract command
# Using basic parsing - for production use jq
COMMAND=$(echo "$TWEAKCC_DATA" | grep -o '"command":"[^"]*"' | cut -d'"' -f4)

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
USER=$(whoami)
PWD_DIR=$(pwd)

# Log with context
cat >> "$AUDIT_FILE" << EOF
================================================================================
Timestamp: $TIMESTAMP
User: $USER
Directory: $PWD_DIR
Tool ID: $TWEAKCC_TOOL_ID
Command: $COMMAND
================================================================================

EOF

# Optional: Alert on dangerous commands
DANGEROUS_PATTERNS="rm -rf|sudo|chmod 777|curl.*\|.*sh|wget.*\|.*sh"
if echo "$COMMAND" | grep -qE "$DANGEROUS_PATTERNS"; then
    echo "[ALERT] Potentially dangerous command detected: $COMMAND" >&2
    # Could send notification here
fi
