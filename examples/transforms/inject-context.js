#!/usr/bin/env node
// Inject Context Transform
// Adds project-specific context to prompts from a .claude-context file
//
// Usage: Add to config.json:
// {
//   "settings": {
//     "transforms": {
//       "enabled": true,
//       "transforms": [{
//         "id": "inject-context",
//         "transform": "prompt:before",
//         "script": "~/.tweakcc/transforms/inject-context.js",
//         "enabled": true
//       }]
//     }
//   }
// }
//
// Then create a .claude-context file in your project root:
// ```
// This is a Node.js project using Express and PostgreSQL.
// Follow the coding style in CONTRIBUTING.md.
// Always use async/await, never callbacks.
// ```

const fs = require('fs');
const path = require('path');

// Read input from temp file
const inputFile = process.env.TWEAKCC_INPUT_FILE;
const outputFile = process.env.TWEAKCC_OUTPUT_FILE;

if (!inputFile || !outputFile) {
  console.error('Missing TWEAKCC_INPUT_FILE or TWEAKCC_OUTPUT_FILE');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// Look for context files (in order of preference)
const contextFiles = [
  '.claude-context',
  '.claude/context.md',
  'CLAUDE.md',
  '.ai-context',
];

let contextContent = null;
const cwd = process.cwd();

for (const file of contextFiles) {
  const contextPath = path.join(cwd, file);
  if (fs.existsSync(contextPath)) {
    try {
      contextContent = fs.readFileSync(contextPath, 'utf8').trim();
      if (process.env.TWEAKCC_DEBUG) {
        console.error(`[inject-context] Found context file: ${file}`);
      }
      break;
    } catch (e) {
      // Skip unreadable files
    }
  }
}

// Inject context if found
if (contextContent && input.data) {
  const originalPrompt = typeof input.data === 'string' ? input.data : JSON.stringify(input.data);

  input.data = `<project-context>
${contextContent}
</project-context>

${originalPrompt}`;

  if (process.env.TWEAKCC_DEBUG) {
    console.error(`[inject-context] Injected ${contextContent.length} chars of context`);
  }
}

// Write output
fs.writeFileSync(outputFile, JSON.stringify(input));
