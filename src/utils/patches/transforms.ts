// Transform/Middleware Plugin System for Claude Code
// Allows plugins to intercept and MODIFY data (prompts, responses, tool I/O)
//
// Unlike events (fire-and-forget), transforms are SYNCHRONOUS and return modified data.
//
// Please see the note about writing patches in ./index.ts.
//
// ⚠️  PATTERN VERIFICATION STATUS:
// ─────────────────────────────────────────────────────────────────────────────
// ✓ VERIFIED   = Pattern tested against actual cli.js and works
// ? UNVERIFIED = Pattern is speculative, needs testing with real cli.js
// ✗ BROKEN     = Pattern confirmed not working, needs fixing
//
// Use `npx tweakcc --analyze` to test patterns against your cli.js
// ─────────────────────────────────────────────────────────────────────────────

import { showDiff, getRequireFuncName } from './index.js';
import { TransformsConfig } from '../types.js';

// ============================================================================
// TRANSFORM RUNNER INJECTION
// ============================================================================

/**
 * Generate the transform runner code to inject
 * This is the core middleware engine that loads and executes transform scripts
 */
export const generateTransformRunnerCode = (
  requireFunc: string,
  config: TransformsConfig
): string => {
  const transformsJson = JSON.stringify(
    config.transforms
      .filter(t => t.enabled)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
  );

  return `
// ============================================================================
// TWEAKCC TRANSFORM RUNNER - Injected by tweakcc
// ============================================================================
const TWEAKCC_TRANSFORMS = (function() {
  const { execSync, spawnSync } = ${requireFunc}('child_process');
  const { readFileSync, writeFileSync, mkdirSync, unlinkSync } = ${requireFunc}('fs');
  const { join, dirname } = ${requireFunc}('path');
  const { homedir, tmpdir } = ${requireFunc}('os');
  const { randomUUID } = ${requireFunc}('crypto');

  const transforms = ${transformsJson};

  // Group transforms by type for faster lookup
  const transformsByType = {};
  for (const t of transforms) {
    if (!transformsByType[t.transform]) {
      transformsByType[t.transform] = [];
    }
    transformsByType[t.transform].push(t);
  }

  function log(level, message, data) {
    if (process.env.TWEAKCC_DEBUG) {
      console.error('[tweakcc:transform:' + level + ']', message, data || '');
    }
  }

  function resolvePath(scriptPath) {
    if (scriptPath.startsWith('~')) {
      return scriptPath.replace('~', homedir());
    }
    return scriptPath;
  }

  /**
   * Execute a transform script and return the modified data
   * Scripts receive input via stdin (JSON) and return output via stdout (JSON)
   */
  function executeTransform(transformConfig, inputData) {
    const scriptPath = resolvePath(transformConfig.script);
    const timeout = transformConfig.timeout || 5000;

    try {
      // Write input to a temp file (more reliable than stdin for sync execution)
      const tempDir = join(tmpdir(), 'tweakcc-transforms');
      mkdirSync(tempDir, { recursive: true });
      const inputFile = join(tempDir, randomUUID() + '.json');
      const outputFile = join(tempDir, randomUUID() + '.json');

      writeFileSync(inputFile, JSON.stringify(inputData));

      // Execute the script
      // The script should read from INPUT_FILE, write to OUTPUT_FILE
      const env = {
        ...process.env,
        TWEAKCC_INPUT_FILE: inputFile,
        TWEAKCC_OUTPUT_FILE: outputFile,
        TWEAKCC_TRANSFORM_TYPE: transformConfig.transform,
        TWEAKCC_TRANSFORM_ID: transformConfig.id,
      };

      try {
        execSync('node ' + JSON.stringify(scriptPath), {
          env,
          timeout,
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf8',
        });

        // Read output
        try {
          const output = readFileSync(outputFile, 'utf8');
          const result = JSON.parse(output);
          log('debug', 'Transform succeeded', { id: transformConfig.id, hasResult: !!result });
          return result;
        } catch (readErr) {
          // Output file not written or invalid - return original
          log('warn', 'Transform did not write output', { id: transformConfig.id });
          return inputData;
        }
      } finally {
        // Cleanup temp files
        try { unlinkSync(inputFile); } catch {}
        try { unlinkSync(outputFile); } catch {}
      }
    } catch (err) {
      log('error', 'Transform execution failed', { id: transformConfig.id, error: err.message });
      return inputData; // Return original on error
    }
  }

  /**
   * Run all transforms of a given type on the input data
   * Returns the final transformed data
   */
  function runTransforms(type, inputData, context = {}) {
    const applicableTransforms = transformsByType[type] || [];
    if (applicableTransforms.length === 0) {
      return inputData;
    }

    let data = inputData;
    for (const transform of applicableTransforms) {
      // Check filter
      if (transform.filter?.tools && context.toolName) {
        if (!transform.filter.tools.includes(context.toolName)) {
          continue;
        }
      }

      log('debug', 'Running transform', { id: transform.id, type });
      data = executeTransform(transform, { data, context, type });

      // If transform returns an object with 'data' property, extract it
      if (data && typeof data === 'object' && 'data' in data) {
        data = data.data;
      }
    }

    return data;
  }

  // Public API
  return {
    run: runTransforms,
    hasTransforms: (type) => (transformsByType[type] || []).length > 0,
  };
})();
// ============================================================================
// END TWEAKCC TRANSFORM RUNNER
// ============================================================================

`;
};

/**
 * Find insertion point for transform runner (same as event emitter)
 */
export const findTransformRunnerInsertionPoint = (
  fileContents: string
): number => {
  const firstClassPattern = /^(import[^;]+;|var [^;]+;|\s)+/;
  const match = fileContents.match(firstClassPattern);
  return match ? match[0].length : 0;
};

/**
 * Sub-patch 1: Inject the transform runner
 */
export const writeTransformRunner = (
  oldFile: string,
  config: TransformsConfig
): string | null => {
  const insertionPoint = findTransformRunnerInsertionPoint(oldFile);
  const requireFunc = getRequireFuncName(oldFile);
  const runnerCode = generateTransformRunnerCode(requireFunc, config);

  const newFile =
    oldFile.slice(0, insertionPoint) + runnerCode + oldFile.slice(insertionPoint);

  showDiff(oldFile, newFile, runnerCode, insertionPoint, insertionPoint);

  return newFile;
};

// ============================================================================
// PROMPT TRANSFORM HOOKS
// ============================================================================

/**
 * Find where user messages are processed before being sent to the API
 * Looking for the query/message construction
 *
 * ? UNVERIFIED: These patterns are speculative:
 *   - /async\s+(?:function\s+)?([$\w]+)\s*\([^)]*\)\s*\{[^{}]*role:\s*["']user["']/
 *   - /\{role:"user",content:([$\w]+)\}/
 *
 * TODO: Run `npx tweakcc --analyze` to verify patterns
 */
export const findPromptTransformLocation = (
  fileContents: string
): { location: number; messageVar: string } | null => {
  // Look for where messages are assembled for the API call
  // Pattern: messages.push({ role: "user", content: ... })
  // Or: { role: "user", content: userMessage }

  // Try to find the onSubmit or message send handler
  const submitPattern = /async\s+(?:function\s+)?([$\w]+)\s*\([^)]*\)\s*\{[^{}]*role:\s*["']user["']/;
  const match = fileContents.match(submitPattern);

  if (match && match.index !== undefined) {
    // Look for the content assignment
    const afterMatch = fileContents.slice(match.index, match.index + 500);
    const contentPattern = /content:\s*([$\w]+)/;
    const contentMatch = afterMatch.match(contentPattern);

    if (contentMatch) {
      return {
        location: match.index + (contentMatch.index || 0),
        messageVar: contentMatch[1],
      };
    }
  }

  // Alternative: find message submission
  const altPattern = /\{role:"user",content:([$\w]+)\}/;
  const altMatch = fileContents.match(altPattern);

  if (altMatch && altMatch.index !== undefined) {
    return {
      location: altMatch.index,
      messageVar: altMatch[1],
    };
  }

  return null;
};

/**
 * Sub-patch 2: Inject prompt:before transform hook
 */
export const writePromptTransform = (oldFile: string): string | null => {
  // Find where user content is used in message construction
  const userContentPattern = /\{role:"user",content:([$\w]+)([,}])/g;
  const matches = Array.from(oldFile.matchAll(userContentPattern));

  if (matches.length === 0) {
    console.error('patch: transforms: writePromptTransform: could not find user message pattern');
    return null;
  }

  let newFile = oldFile;
  let offset = 0;

  // Replace each occurrence
  for (const match of matches) {
    if (match.index === undefined) continue;

    const contentVar = match[1];
    const suffix = match[2];
    const originalText = match[0];

    // Wrap the content variable with transform
    const newText = `{role:"user",content:TWEAKCC_TRANSFORMS.hasTransforms('prompt:before')?TWEAKCC_TRANSFORMS.run('prompt:before',${contentVar}):${contentVar}${suffix}`;

    const adjustedIndex = match.index + offset;
    newFile =
      newFile.slice(0, adjustedIndex) +
      newText +
      newFile.slice(adjustedIndex + originalText.length);

    offset += newText.length - originalText.length;
  }

  if (newFile === oldFile) {
    return null;
  }

  showDiff(oldFile, newFile, '[prompt transforms]', 0, 100);

  return newFile;
};

// ============================================================================
// RESPONSE TRANSFORM HOOKS
// ============================================================================

/**
 * Sub-patch 3: Inject response:before transform hook
 * This hooks into where assistant messages are displayed/processed
 */
export const writeResponseTransform = (oldFile: string): string | null => {
  // Find where assistant content is rendered or processed
  // Pattern: role:"assistant", content: X
  const assistantPattern = /\{role:"assistant",content:([$\w]+)([,}])/g;
  const matches = Array.from(oldFile.matchAll(assistantPattern));

  if (matches.length === 0) {
    // Try alternative pattern for response handling
    const altPattern = /case\s*["']assistant["']\s*:/;
    const altMatch = oldFile.match(altPattern);

    if (!altMatch || altMatch.index === undefined) {
      console.log('patch: transforms: writeResponseTransform: could not find assistant message pattern');
      return oldFile; // Non-fatal, just skip
    }
  }

  let newFile = oldFile;
  let offset = 0;

  for (const match of matches) {
    if (match.index === undefined) continue;

    const contentVar = match[1];
    const suffix = match[2];
    const originalText = match[0];

    // Only transform first few occurrences (display-related)
    const newText = `{role:"assistant",content:TWEAKCC_TRANSFORMS.hasTransforms('response:before')?TWEAKCC_TRANSFORMS.run('response:before',${contentVar}):${contentVar}${suffix}`;

    const adjustedIndex = match.index + offset;
    newFile =
      newFile.slice(0, adjustedIndex) +
      newText +
      newFile.slice(adjustedIndex + originalText.length);

    offset += newText.length - originalText.length;

    // Only transform first 3 occurrences to avoid performance issues
    if (offset > 0 && matches.indexOf(match) >= 2) break;
  }

  if (newFile === oldFile) {
    return oldFile;
  }

  showDiff(oldFile, newFile, '[response transforms]', 0, 100);

  return newFile;
};

// ============================================================================
// TOOL I/O TRANSFORM HOOKS
// ============================================================================

/**
 * Sub-patch 4: Inject tool:input transform hook
 *
 * ✓ VERIFIED: Pattern found at position 5327809 in cli.js 2.0.55:
 *   let Y=Z.input;if("parse"in I&&I.parse)Y=I.parse(Y);let J=await I.run(Y)
 *
 * We intercept after the initial assignment: let Y=Z.input;
 * And wrap Y before it's used in I.run(Y)
 */
export const writeToolInputTransform = (oldFile: string): string | null => {
  // Verified pattern: let Y=Z.input;if("parse"in I&&I.parse)Y=I.parse(Y);let J=await I.run(Y)
  // We need to wrap the input (Y) with transform before it goes to I.run()
  const toolInputPattern = /let\s+([$\w]+)=([$\w]+)\.input;if\("parse"in\s+([$\w]+)&&\3\.parse\)\1=\3\.parse\(\1\);let\s+([$\w]+)=await\s+\3\.run\(\1\)/;
  const match = oldFile.match(toolInputPattern);

  if (!match || match.index === undefined) {
    console.log('patch: transforms: writeToolInputTransform: could not find verified tool input pattern');
    return oldFile;
  }

  const inputVar = match[1]; // Y
  const toolUseVar = match[2]; // Z
  const toolImplVar = match[3]; // I
  const resultVar = match[4]; // J
  const originalText = match[0];

  // Wrap the input with transform after parse but before run
  const newText = `let ${inputVar}=${toolUseVar}.input;if("parse"in ${toolImplVar}&&${toolImplVar}.parse)${inputVar}=${toolImplVar}.parse(${inputVar});${inputVar}=TWEAKCC_TRANSFORMS.hasTransforms('tool:input')?TWEAKCC_TRANSFORMS.run('tool:input',${inputVar},{toolName:${toolUseVar}.name}):${inputVar};let ${resultVar}=await ${toolImplVar}.run(${inputVar})`;

  const newFile = oldFile.replace(originalText, newText);

  if (newFile === oldFile) {
    return oldFile;
  }

  showDiff(oldFile, newFile, newText, match.index, match.index + originalText.length);

  return newFile;
};

/**
 * Sub-patch 5: Inject tool:output transform hook
 *
 * ✓ VERIFIED: Pattern found at position 5327839 in cli.js 2.0.55:
 *   return{type:"tool_result",tool_use_id:Z.id,content:J}
 *
 * We wrap the content (J) with transform before it's returned
 */
export const writeToolOutputTransform = (oldFile: string): string | null => {
  // Verified pattern: return{type:"tool_result",tool_use_id:Z.id,content:J}
  const toolResultPattern = /return\{type:"tool_result",tool_use_id:([$\w]+)\.id,content:([$\w]+)\}/;
  const match = oldFile.match(toolResultPattern);

  if (!match || match.index === undefined) {
    console.log('patch: transforms: writeToolOutputTransform: could not find verified tool result pattern');
    return oldFile;
  }

  const toolUseVar = match[1]; // Z
  const contentVar = match[2]; // J
  const originalText = match[0];

  // Wrap the content with transform
  const newText = `return{type:"tool_result",tool_use_id:${toolUseVar}.id,content:TWEAKCC_TRANSFORMS.hasTransforms('tool:output')?TWEAKCC_TRANSFORMS.run('tool:output',${contentVar},{toolName:${toolUseVar}.name}):${contentVar}}`;

  const newFile = oldFile.replace(originalText, newText);

  if (newFile === oldFile) {
    return oldFile;
  }

  showDiff(oldFile, newFile, newText, match.index, match.index + originalText.length);

  return newFile;
};

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Apply all transform patches to the file
 */
export const writeTransforms = (
  oldFile: string,
  config: TransformsConfig
): string | null => {
  if (!config || !config.enabled || !config.transforms || config.transforms.length === 0) {
    return null;
  }

  let result: string | null = oldFile;

  // Step 1: Inject the transform runner
  result = writeTransformRunner(result, config);
  if (!result) {
    console.error('patch: transforms: step 1 failed (writeTransformRunner)');
    return null;
  }

  // Step 2: Inject prompt:before transform hook
  const hasPromptTransform = config.transforms.some(
    t => t.enabled && (t.transform === 'prompt:before' || t.transform === 'prompt:system')
  );
  if (hasPromptTransform) {
    const promptResult = writePromptTransform(result);
    if (promptResult) {
      result = promptResult;
    } else {
      console.log('patch: transforms: step 2 skipped (writePromptTransform)');
    }
  }

  // Step 3: Inject response:before transform hook
  const hasResponseTransform = config.transforms.some(
    t => t.enabled && (t.transform === 'response:before' || t.transform === 'response:stream')
  );
  if (hasResponseTransform) {
    const responseResult = writeResponseTransform(result);
    if (responseResult) {
      result = responseResult;
    }
  }

  // Step 4: Inject tool:input transform hook
  const hasToolInputTransform = config.transforms.some(
    t => t.enabled && t.transform === 'tool:input'
  );
  if (hasToolInputTransform) {
    const toolInputResult = writeToolInputTransform(result);
    if (toolInputResult) {
      result = toolInputResult;
    }
  }

  // Step 5: Inject tool:output transform hook
  const hasToolOutputTransform = config.transforms.some(
    t => t.enabled && t.transform === 'tool:output'
  );
  if (hasToolOutputTransform) {
    const toolOutputResult = writeToolOutputTransform(result);
    if (toolOutputResult) {
      result = toolOutputResult;
    }
  }

  return result;
};
