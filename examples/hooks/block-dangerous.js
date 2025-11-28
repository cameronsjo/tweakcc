#!/usr/bin/env node
// Block Dangerous Commands Hook
// Prevents Claude from executing potentially destructive Bash commands
//
// Usage: Add to config.json:
// {
//   "id": "block-dangerous",
//   "events": "tool:before",
//   "type": "script",
//   "script": "~/.tweakcc/hooks/block-dangerous.js",
//   "filter": { "tools": ["Bash"] },
//   "async": false,
//   "onError": "abort",
//   "enabled": true
// }
//
// When a blocked command is detected, the script exits with code 1,
// which triggers onError: "abort" to prevent execution.

// Decode base64 data for safer parsing
const base64Data = process.env.TWEAKCC_DATA_BASE64;
let data = {};

if (base64Data) {
  try {
    data = JSON.parse(Buffer.from(base64Data, 'base64').toString('utf8'));
  } catch (e) {
    // Fall back to direct parsing
    try {
      data = JSON.parse(process.env.TWEAKCC_DATA || '{}');
    } catch (e2) {
      console.error('[block-dangerous] Failed to parse event data');
      process.exit(0); // Don't block on parse errors
    }
  }
}

const command = data.input?.command || '';

// Patterns that are always blocked
const blockedPatterns = [
  // Destructive file operations
  /rm\s+(-[rf]+\s+)*\//,                    // rm -rf /
  /rm\s+(-[rf]+\s+)*~\//,                   // rm -rf ~/
  /rm\s+(-[rf]+\s+)*\$HOME/,                // rm -rf $HOME
  />\s*\/dev\/sd[a-z]/,                     // > /dev/sda
  /dd\s+.*of=\/dev\/sd[a-z]/,               // dd of=/dev/sda
  /mkfs\./,                                 // mkfs.ext4, etc.

  // Fork bombs and resource exhaustion
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/,   // :(){:|:&};:
  /while\s+true.*done/,                     // while true; do ... done (infinite loops)

  // Privilege escalation with destructive intent
  /sudo\s+rm\s+(-[rf]+\s+)*\//,             // sudo rm -rf /
  /sudo\s+chmod\s+777\s+\//,                // sudo chmod 777 /
  /sudo\s+chown.*\//,                       // sudo chown ... /

  // Network exfiltration to unknown hosts
  /curl.*\|\s*(ba)?sh/,                     // curl ... | sh
  /wget.*\|\s*(ba)?sh/,                     // wget ... | sh

  // System modification
  />\s*\/etc\/(passwd|shadow|sudoers)/,     // Overwriting critical files
  /systemctl\s+(stop|disable)\s+(ssh|sshd|firewalld|ufw)/, // Disabling security
];

// Patterns that trigger warnings but don't block
const warnPatterns = [
  /sudo\s+/,                                // Any sudo usage
  /chmod\s+777/,                            // Overly permissive chmod
  /curl\s+.*-o/,                            // curl downloading files
  /wget\s+/,                                // wget usage
  /pip\s+install\s+(?!-e\s)/,               // pip install (not editable)
  /npm\s+install\s+-g/,                     // global npm install
];

// Check for blocked patterns
for (const pattern of blockedPatterns) {
  if (pattern.test(command)) {
    console.error(`\n[BLOCKED] Dangerous command detected:`);
    console.error(`  Command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`);
    console.error(`  Pattern: ${pattern}`);
    console.error(`\nThis command has been blocked for safety.`);
    console.error(`If you need to run this command, do it manually.\n`);
    process.exit(1); // Triggers onError: "abort"
  }
}

// Check for warning patterns (log but don't block)
for (const pattern of warnPatterns) {
  if (pattern.test(command)) {
    console.error(`[WARNING] Potentially risky command: ${command.substring(0, 80)}`);
    break; // Only warn once
  }
}

// Command is allowed
process.exit(0);
