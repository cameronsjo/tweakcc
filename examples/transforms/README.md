# Example Transform Scripts

Ready-to-use transform scripts for tweakcc's transform system.

> [!warning]
> Transforms are more experimental than events. Some patterns may not match your Claude Code version.

## Installation

1. Copy the scripts you want to use:
   ```bash
   mkdir -p ~/.tweakcc/transforms
   cp redact-secrets.js ~/.tweakcc/transforms/
   chmod +x ~/.tweakcc/transforms/redact-secrets.js
   ```

2. Add the transform to your config (see each script for config example)

3. Apply changes:
   ```bash
   npx tweakcc --apply
   ```

## Available Scripts

### `redact-secrets.js`

Automatically redacts sensitive data from tool output before Claude processes it.

**Transform type**: `tool:output`

**What it redacts**:
- OpenAI API keys (`sk-...`)
- Anthropic API keys (`sk-ant-...`)
- GitHub tokens (`ghp_...`, `gho_...`)
- AWS credentials (`AKIA...`)
- GitLab tokens (`glpat-...`)
- NPM tokens (`npm_...`)
- Private keys (PEM format)
- Database connection strings
- Generic password/secret patterns

**Config**:
```json
{
  "id": "redact-secrets",
  "transform": "tool:output",
  "script": "~/.tweakcc/transforms/redact-secrets.js",
  "priority": 1,
  "enabled": true
}
```

### `inject-context.js`

Injects project-specific context into prompts from a context file.

**Transform type**: `prompt:before`

**Context files** (checked in order):
1. `.claude-context`
2. `.claude/context.md`
3. `CLAUDE.md`
4. `.ai-context`

**Example context file** (`.claude-context`):
```markdown
This is a Node.js project using Express and PostgreSQL.
Follow the coding style in CONTRIBUTING.md.
Always use async/await, never callbacks.
Database schema is in docs/schema.sql.
```

**Config**:
```json
{
  "id": "inject-context",
  "transform": "prompt:before",
  "script": "~/.tweakcc/transforms/inject-context.js",
  "enabled": true
}
```

## Writing Your Own Transforms

### Input/Output Format

Transforms receive a JSON file with this structure:
```json
{
  "data": "...",      // The data to transform (string or object)
  "context": { ... }, // Additional context (tool name, event type, etc.)
  "type": "..."       // Transform type (e.g., "tool:output")
}
```

Your script should:
1. Read from `process.env.TWEAKCC_INPUT_FILE`
2. Parse the JSON
3. Modify `input.data`
4. Write the modified JSON to `process.env.TWEAKCC_OUTPUT_FILE`

### Template

```javascript
#!/usr/bin/env node
const fs = require('fs');

const inputFile = process.env.TWEAKCC_INPUT_FILE;
const outputFile = process.env.TWEAKCC_OUTPUT_FILE;

if (!inputFile || !outputFile) {
  console.error('Missing input/output file environment variables');
  process.exit(1);
}

// Read input
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

// Transform the data
// input.data contains the actual content to modify
if (typeof input.data === 'string') {
  input.data = input.data.replace(/foo/g, 'bar');
}

// Write output
fs.writeFileSync(outputFile, JSON.stringify(input));

// Optional: Debug logging
if (process.env.TWEAKCC_DEBUG) {
  console.error('[my-transform] Processed data');
}
```

### Tips

1. **Always handle both string and object data** - `input.data` may be either
2. **Use `console.error` for logging** - stdout might interfere with some edge cases
3. **Set a reasonable timeout** in config (default: 5000ms)
4. **Use priority** to control execution order (lower = runs first)
5. **Test standalone first**:
   ```bash
   echo '{"data":"test content"}' > /tmp/input.json
   TWEAKCC_INPUT_FILE=/tmp/input.json \
   TWEAKCC_OUTPUT_FILE=/tmp/output.json \
   node your-transform.js
   cat /tmp/output.json
   ```

## Example Config

Full `config.json` with multiple transforms:

```json
{
  "settings": {
    "transforms": {
      "enabled": true,
      "transforms": [
        {
          "id": "redact-secrets",
          "name": "Redact sensitive data",
          "transform": "tool:output",
          "script": "~/.tweakcc/transforms/redact-secrets.js",
          "priority": 1,
          "timeout": 5000,
          "enabled": true
        },
        {
          "id": "inject-context",
          "name": "Add project context",
          "transform": "prompt:before",
          "script": "~/.tweakcc/transforms/inject-context.js",
          "priority": 10,
          "enabled": true
        }
      ]
    }
  }
}
```
