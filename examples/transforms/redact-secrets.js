#!/usr/bin/env node
// Redact Secrets Transform
// Removes API keys and credentials from tool output before Claude sees it
//
// Usage: Add to config.json:
// {
//   "settings": {
//     "transforms": {
//       "enabled": true,
//       "transforms": [{
//         "id": "redact-secrets",
//         "transform": "tool:output",
//         "script": "~/.tweakcc/transforms/redact-secrets.js",
//         "priority": 1,
//         "enabled": true
//       }]
//     }
//   }
// }

const fs = require('fs');

// Read input from temp file
const inputFile = process.env.TWEAKCC_INPUT_FILE;
const outputFile = process.env.TWEAKCC_OUTPUT_FILE;

if (!inputFile || !outputFile) {
  console.error('Missing TWEAKCC_INPUT_FILE or TWEAKCC_OUTPUT_FILE');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// Patterns to redact (add more as needed)
const patterns = [
  // API Keys
  [/sk-[a-zA-Z0-9]{20,}/g, 'sk-[REDACTED]'],                    // OpenAI
  [/sk-proj-[a-zA-Z0-9-_]{20,}/g, 'sk-proj-[REDACTED]'],        // OpenAI Project
  [/sk-ant-[a-zA-Z0-9-_]{20,}/g, 'sk-ant-[REDACTED]'],          // Anthropic
  [/AIza[0-9A-Za-z-_]{35}/g, 'AIza[REDACTED]'],                 // Google API

  // Cloud Credentials
  [/AKIA[0-9A-Z]{16}/g, 'AKIA[REDACTED]'],                      // AWS Access Key
  [/[0-9a-zA-Z/+]{40}/g, (match) => {                           // AWS Secret Key (40 chars base64)
    // Only redact if it looks like a secret key (in context)
    return match;
  }],

  // Tokens
  [/ghp_[a-zA-Z0-9]{36}/g, 'ghp_[REDACTED]'],                   // GitHub PAT
  [/gho_[a-zA-Z0-9]{36}/g, 'gho_[REDACTED]'],                   // GitHub OAuth
  [/github_pat_[a-zA-Z0-9_]{22,}/g, 'github_pat_[REDACTED]'],   // GitHub Fine-grained PAT
  [/glpat-[a-zA-Z0-9-_]{20,}/g, 'glpat-[REDACTED]'],            // GitLab PAT
  [/npm_[a-zA-Z0-9]{36}/g, 'npm_[REDACTED]'],                   // NPM Token

  // Private Keys
  [/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]'],

  // Connection Strings
  [/mongodb(\+srv)?:\/\/[^:]+:[^@]+@[^\s"']+/g, 'mongodb://[REDACTED]'],
  [/postgres(ql)?:\/\/[^:]+:[^@]+@[^\s"']+/g, 'postgresql://[REDACTED]'],
  [/mysql:\/\/[^:]+:[^@]+@[^\s"']+/g, 'mysql://[REDACTED]'],
  [/redis:\/\/[^:]+:[^@]+@[^\s"']+/g, 'redis://[REDACTED]'],

  // Generic Patterns
  [/password["\s:=]+["']?[^"'\s]{8,}["']?/gi, 'password=[REDACTED]'],
  [/secret["\s:=]+["']?[^"'\s]{8,}["']?/gi, 'secret=[REDACTED]'],
  [/api[_-]?key["\s:=]+["']?[^"'\s]{16,}["']?/gi, 'api_key=[REDACTED]'],
];

// Apply redactions
let data = typeof input.data === 'string' ? input.data : JSON.stringify(input.data);

for (const [pattern, replacement] of patterns) {
  if (typeof replacement === 'function') {
    data = data.replace(pattern, replacement);
  } else {
    data = data.replace(pattern, replacement);
  }
}

// Update input with redacted data
input.data = data;

// Write output
fs.writeFileSync(outputFile, JSON.stringify(input));

if (process.env.TWEAKCC_DEBUG) {
  console.error('[redact-secrets] Processed output');
}
