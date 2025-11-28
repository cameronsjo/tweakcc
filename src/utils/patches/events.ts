// Custom Events Hook System for Claude Code
// Allows users to hook into CC's internal events (tools, messages, thinking, etc.)
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

import { showDiff, getRequireFuncName, getReactVar } from './index.js';
import { EventsConfig } from '../types.js';

// ============================================================================
// EVENT EMITTER INJECTION
// ============================================================================

/**
 * Find the insertion point for the event emitter (top of file, after imports)
 */
export const findEventEmitterInsertionPoint = (
  fileContents: string
): number | null => {
  // Find after the initial var declarations block
  // Look for pattern: var X=...;var Y=...;
  // We want to insert after the initial setup but before main code
  const firstClassPattern = /^(import[^;]+;|var [^;]+;|\s)+/;
  const match = fileContents.match(firstClassPattern);

  if (!match) {
    // Fallback: insert at beginning
    return 0;
  }

  return match[0].length;
};

/**
 * Generate the event emitter code to inject
 */
export const generateEventEmitterCode = (
  requireFunc: string,
  config: EventsConfig
): string => {
  const hooksJson = JSON.stringify(config.hooks.filter(h => h.enabled));
  const loggingEnabled = config.logging?.enabled ?? false;
  const logFile = config.logging?.logFile ?? '';
  const logLevel = config.logging?.logLevel ?? 'info';

  return `
// ============================================================================
// TWEAKCC EVENT EMITTER - Injected by tweakcc
// ============================================================================
const TWEAKCC_EVENTS = (function() {
  const { spawn, execSync } = ${requireFunc}('child_process');
  const { appendFileSync, mkdirSync } = ${requireFunc}('fs');
  const { dirname, join } = ${requireFunc}('path');
  const { homedir } = ${requireFunc}('os');

  const hooks = ${hooksJson};
  const loggingEnabled = ${loggingEnabled};
  const logFile = ${JSON.stringify(logFile)} || join(homedir(), '.tweakcc', 'events.log');
  const logLevel = ${JSON.stringify(logLevel)};

  const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

  function log(level, message, data) {
    if (!loggingEnabled) return;
    if (LOG_LEVELS[level] < LOG_LEVELS[logLevel]) return;

    try {
      mkdirSync(dirname(logFile), { recursive: true });
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        data
      }) + '\\n';
      appendFileSync(logFile, entry);
    } catch (e) {
      // Silently fail logging
    }
  }

  // Cache compiled regex patterns to avoid recompilation overhead
  const regexCache = new Map();
  const MAX_REGEX_LENGTH = 500;
  const MAX_TEST_STRING_LENGTH = 10000;

  function getCompiledRegex(pattern) {
    if (regexCache.has(pattern)) {
      return regexCache.get(pattern);
    }

    // SECURITY: Reject overly complex regex patterns to prevent ReDoS
    if (pattern.length > MAX_REGEX_LENGTH) {
      log('warn', 'Regex pattern too long, skipping', { length: pattern.length, max: MAX_REGEX_LENGTH });
      return null;
    }

    // Basic ReDoS pattern detection (nested quantifiers)
    const redosPatterns = [
      /(\\+|\\*|\\{[^}]+\\})\\s*\\??\\s*(\\+|\\*|\\{[^}]+\\})/,  // Nested quantifiers
      /\\([^)]*(?:\\+|\\*)[^)]*\\)\\s*(?:\\+|\\*)/,               // Quantified groups with quantifiers
    ];
    for (const redosPattern of redosPatterns) {
      if (redosPattern.test(pattern)) {
        log('warn', 'Potentially dangerous regex pattern detected (ReDoS risk), skipping', { pattern });
        return null;
      }
    }

    try {
      const regex = new RegExp(pattern);
      regexCache.set(pattern, regex);
      return regex;
    } catch (e) {
      log('warn', 'Invalid regex pattern', { pattern, error: e.message });
      regexCache.set(pattern, null);
      return null;
    }
  }

  function matchesFilter(hook, eventData) {
    if (!hook.filter) return true;

    // Tool include filter
    if (hook.filter.tools && eventData.toolName) {
      if (!hook.filter.tools.includes(eventData.toolName)) return false;
    }

    // Tool exclude filter
    if (hook.filter.toolsExclude && eventData.toolName) {
      if (hook.filter.toolsExclude.includes(eventData.toolName)) return false;
    }

    // Message type filter
    if (hook.filter.messageTypes && eventData.messageType) {
      if (!hook.filter.messageTypes.includes(eventData.messageType)) return false;
    }

    // Regex filter on stringified data (with safety checks)
    if (hook.filter.regex) {
      const regex = getCompiledRegex(hook.filter.regex);
      if (regex) {
        const testString = JSON.stringify(eventData);
        // SECURITY: Limit test string length to prevent long-running matches
        if (testString.length > MAX_TEST_STRING_LENGTH) {
          log('warn', 'Event data too large for regex filter, skipping regex check', { hookId: hook.id });
        } else {
          if (!regex.test(testString)) return false;
        }
      }
    }

    return true;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function executeWithRetry(hook, fn, attempt = 0) {
    const maxRetries = hook.retryCount ?? 3;
    const retryDelay = hook.retryDelay ?? 1000;

    try {
      return await fn();
    } catch (e) {
      if (hook.onError === 'retry' && attempt < maxRetries) {
        log('warn', 'Hook failed, retrying...', { hookId: hook.id, attempt: attempt + 1, maxRetries });
        await sleep(retryDelay * Math.pow(2, attempt)); // Exponential backoff
        return executeWithRetry(hook, fn, attempt + 1);
      }
      throw e;
    }
  }

  function executeHook(hook, event, data) {
    const eventData = {
      event,
      timestamp: new Date().toISOString(),
      hookId: hook.id,
      hookName: hook.name || hook.id,
      ...data
    };

    if (!matchesFilter(hook, eventData)) {
      log('debug', 'Hook filtered out', { hookId: hook.id, event });
      return;
    }

    const startTime = Date.now();
    log('debug', 'Executing hook', { hookId: hook.id, event, type: hook.type });

    const handleError = (e) => {
      const duration = Date.now() - startTime;
      log('error', 'Hook execution error', { hookId: hook.id, event, error: e.message, duration });

      if (hook.onError === 'abort') {
        throw new Error('Hook execution aborted: ' + e.message);
      }
      // 'continue' is default - just log and continue
    };

    try {
      // Build environment variables
      // SECURITY: Base64 encode JSON data to prevent shell injection
      const jsonData = JSON.stringify(eventData);
      const base64Data = Buffer.from(jsonData).toString('base64');

      const baseEnv = {
        ...process.env,
        ...(hook.env || {}),
        TWEAKCC_EVENT: event,
        TWEAKCC_DATA: jsonData,
        TWEAKCC_DATA_BASE64: base64Data,
        TWEAKCC_HOOK_ID: hook.id,
        TWEAKCC_HOOK_NAME: hook.name || hook.id
      };

      // Add tool-specific env vars (these are safe - controlled values)
      if (eventData.toolName) baseEnv.TWEAKCC_TOOL_NAME = String(eventData.toolName);
      if (eventData.toolId) baseEnv.TWEAKCC_TOOL_ID = String(eventData.toolId);

      const execOptions = {
        env: baseEnv,
        cwd: hook.cwd || process.cwd(),
        timeout: hook.timeout || 5000
      };

      if (hook.type === 'command' && hook.command) {
        if (hook.async !== false) {
          // Non-blocking execution
          const child = spawn('sh', ['-c', hook.command], {
            ...execOptions,
            detached: true,
            stdio: 'ignore'
          });
          child.unref();
        } else {
          // Blocking execution with retry support (synchronous)
          const runCmdSync = () => {
            execSync(hook.command, { ...execOptions, stdio: 'ignore' });
          };

          if (hook.onError === 'retry') {
            // Synchronous retry with exponential backoff
            const maxRetries = hook.retryCount ?? 3;
            const retryDelay = hook.retryDelay ?? 1000;
            let attempt = 0;
            while (attempt <= maxRetries) {
              try {
                runCmdSync();
                break;
              } catch (e) {
                attempt++;
                if (attempt > maxRetries) {
                  handleError(e);
                  break;
                }
                log('warn', 'Hook failed, retrying...', { hookId: hook.id, attempt, maxRetries });
                // Synchronous sleep using Atomics (blocks event loop intentionally for sync mode)
                const waitMs = retryDelay * Math.pow(2, attempt - 1);
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
              }
            }
          } else {
            try {
              runCmdSync();
            } catch (e) {
              handleError(e);
            }
          }
        }
      } else if (hook.type === 'webhook' && hook.webhook) {
        // Fire-and-forget webhook with retry support
        const https = ${requireFunc}('https');
        const http = ${requireFunc}('http');

        const sendWebhook = () => {
          return new Promise((resolve, reject) => {
            const url = new URL(hook.webhook);
            const client = url.protocol === 'https:' ? https : http;

            const postData = JSON.stringify(eventData);
            const req = client.request(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'X-Tweakcc-Event': event,
                'X-Tweakcc-Hook-Id': hook.id
              },
              timeout: hook.timeout || 5000
            });

            req.on('response', (res) => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve();
              } else {
                reject(new Error('HTTP ' + res.statusCode));
              }
            });

            req.on('error', reject);
            req.on('timeout', () => reject(new Error('Timeout')));

            req.write(postData);
            req.end();
          });
        };

        if (hook.onError === 'retry') {
          executeWithRetry(hook, sendWebhook).catch(handleError);
        } else {
          sendWebhook().catch(handleError);
        }
      } else if (hook.type === 'script' && hook.script) {
        // Dynamic script execution
        try {
          const scriptPath = hook.script.startsWith('~')
            ? hook.script.replace('~', homedir())
            : hook.script;

          // Use child process to run the script
          const child = spawn('node', [scriptPath], {
            env: baseEnv,
            cwd: hook.cwd || dirname(scriptPath),
            detached: hook.async !== false,
            stdio: 'ignore'
          });

          if (hook.async !== false) {
            child.unref();
          }
        } catch (e) {
          handleError(e);
        }
      }

      const duration = Date.now() - startTime;
      log('info', 'Hook executed', { hookId: hook.id, event, duration });
    } catch (e) {
      handleError(e);
    }
  }

  function emit(event, data = {}) {
    log('debug', 'Event emitted', { event, data });

    for (const hook of hooks) {
      if (!hook.enabled) continue;

      const events = Array.isArray(hook.events) ? hook.events : [hook.events];

      if (events.includes(event) || events.some(e => e.startsWith('custom:') && event.startsWith('custom:'))) {
        executeHook(hook, event, data);
      }
    }
  }

  // Public API
  return {
    emit,
    log,
    hooks
  };
})();
// ============================================================================
// END TWEAKCC EVENT EMITTER
// ============================================================================

`;
};

/**
 * Sub-patch 1: Inject the event emitter into Claude Code
 */
export const writeEventEmitter = (
  oldFile: string,
  config: EventsConfig
): string | null => {
  const insertionPoint = findEventEmitterInsertionPoint(oldFile);
  if (insertionPoint === null) {
    console.error('patch: events: failed to find event emitter insertion point');
    return null;
  }

  const requireFunc = getRequireFuncName(oldFile);
  const emitterCode = generateEventEmitterCode(requireFunc, config);

  const newFile =
    oldFile.slice(0, insertionPoint) + emitterCode + oldFile.slice(insertionPoint);

  showDiff(oldFile, newFile, emitterCode, insertionPoint, insertionPoint);

  return newFile;
};

// ============================================================================
// TOOL LIFECYCLE EVENTS
// ============================================================================

/**
 * Find the tool execution function location
 * Looking for patterns like: async function executeTool(...) or tool call dispatch
 */
export const findToolExecutionLocation = (
  fileContents: string
): { startIndex: number; endIndex: number; funcName: string; toolVarName: string } | null => {
  // Pattern: look for tool execution in the query/response handler
  // This matches patterns like: async call(onExit,ctx,input)
  // Or tool dispatch: if(toolName==="Bash")

  // First, find the tool call dispatcher pattern
  // In CC, tools are called via a function that checks tool name
  const toolDispatchPattern = /if\(([$\w]+)\.name===["'](\w+)["']\)/;
  const match = fileContents.match(toolDispatchPattern);

  if (!match || match.index === undefined) {
    // Try alternative pattern: tool execution wrapper
    const altPattern = /async\s+(?:function\s+)?([$\w]+)\s*\([^)]*toolName[^)]*\)\s*\{/;
    const altMatch = fileContents.match(altPattern);

    if (!altMatch || altMatch.index === undefined) {
      console.error('patch: events: findToolExecutionLocation: failed to find tool execution pattern');
      return null;
    }

    return {
      startIndex: altMatch.index,
      endIndex: altMatch.index + altMatch[0].length,
      funcName: altMatch[1],
      toolVarName: 'toolName'
    };
  }

  return {
    startIndex: match.index,
    endIndex: match.index + match[0].length,
    funcName: '',
    toolVarName: match[1]
  };
};

/**
 * Find location to inject tool:before event
 * Looking for the tool call dispatch point
 */
export const findToolBeforeHookLocation = (
  fileContents: string
): { location: number; toolVar: string; inputVar: string } | null => {
  // Pattern: search for tool call patterns
  // In CC, tools are typically called like: await tool.call(context)
  // Or via a dispatch: const result = await executeToolImpl(...)

  // Look for the tool permission check pattern as it comes right before execution
  const permissionPattern = /if\(!(await\s+)?([$\w]+)\.(checkPermission|hasPermission)\(/;
  const match = fileContents.match(permissionPattern);

  if (match && match.index !== undefined) {
    // Look backwards for the function start
    const chunk = fileContents.slice(Math.max(0, match.index - 500), match.index);
    const funcPattern = /async\s+[$\w]+\s*\(([^)]+)\)\s*\{[^{}]*$/;
    const funcMatch = chunk.match(funcPattern);

    if (funcMatch) {
      // Parse parameters to find tool and input vars
      const params = funcMatch[1].split(',').map(p => p.trim());
      return {
        location: match.index,
        toolVar: params[0] || 'tool',
        inputVar: params[1] || 'input'
      };
    }
  }

  // Alternative: find the tool execution in message processing
  const toolExecPattern = /let ([$\w]+)=await ([$\w]+)\(([^,]+),([^)]+)\)/;
  const execMatch = fileContents.match(toolExecPattern);

  if (execMatch && execMatch.index !== undefined) {
    return {
      location: execMatch.index,
      toolVar: execMatch[3].trim(),
      inputVar: execMatch[4].trim()
    };
  }

  return null;
};

/**
 * Sub-patch 2: Inject tool:before and tool:after events
 * This wraps tool execution to emit events
 *
 * ✓ VERIFIED: Pattern found at position 5327809 in cli.js 2.0.55:
 *   let Y=Z.input;...let J=await I.run(Y);return{type:"tool_result",tool_use_id:Z.id,content:J}
 *
 * Variables:
 *   Z = tool use object (has Z.id, Z.input, Z.name)
 *   I = tool implementation (has I.run, I.parse)
 *   Y = input to tool (parsed from Z.input)
 *   J = result from tool execution
 */
export const writeToolLifecycleEvents = (oldFile: string): string | null => {
  // Verified pattern: let J=await I.run(Y);return{type:"tool_result",tool_use_id:Z.id,content:J}
  // We need to wrap the I.run(Y) call to emit before/after events
  const toolRunPattern = /let\s+([$\w]+)=await\s+([$\w]+)\.run\(([$\w]+)\);return\{type:"tool_result",tool_use_id:([$\w]+)\.id,content:([$\w]+)\}/;
  const match = oldFile.match(toolRunPattern);

  if (!match || match.index === undefined) {
    console.error('patch: events: writeToolLifecycleEvents: could not find verified tool.run pattern');
    return null;
  }

  const resultVar = match[1]; // J
  const toolImplVar = match[2]; // I
  const inputVar = match[3]; // Y
  const toolUseVar = match[4]; // Z
  const returnContentVar = match[5]; // J

  // Replace the tool execution with wrapped version that emits events
  const originalCode = match[0];
  const newCode = `TWEAKCC_EVENTS.emit('tool:before',{toolName:${toolUseVar}.name,toolId:${toolUseVar}.id,input:${inputVar}});let ${resultVar}=await ${toolImplVar}.run(${inputVar});TWEAKCC_EVENTS.emit('tool:after',{toolName:${toolUseVar}.name,toolId:${toolUseVar}.id,result:${returnContentVar}});return{type:"tool_result",tool_use_id:${toolUseVar}.id,content:${returnContentVar}}`;

  const newFile = oldFile.replace(originalCode, newCode);

  if (newFile === oldFile) {
    console.error('patch: events: writeToolLifecycleEvents: replacement failed');
    return null;
  }

  showDiff(oldFile, newFile, newCode, match.index, match.index + originalCode.length);

  return newFile;
};

// ============================================================================
// MESSAGE LIFECYCLE EVENTS
// ============================================================================

/**
 * Find where messages are appended/created
 *
 * ✓ VERIFIED: Uses same pattern as conversationTitle.ts which is known to work
 */
export const findMessageAppendLocation = (
  fileContents: string
): { location: number; messageVar: string } | null => {
  // Use the same pattern as conversationTitle.ts
  const pattern = /(if\(![$\w]+\.has\(([$\w]+)\.uuid\)\)\{)if\([$\w]+\.appendFileSync\(/;
  const match = fileContents.match(pattern);

  if (!match || match.index === undefined) {
    return null;
  }

  return {
    location: match.index + match[1].length,
    messageVar: match[2]
  };
};

/**
 * Sub-patch 3: Inject message events
 */
export const writeMessageEvents = (oldFile: string): string | null => {
  const location = findMessageAppendLocation(oldFile);

  if (!location) {
    console.error('patch: events: writeMessageEvents: could not find message append location');
    return null;
  }

  const { location: insertPoint, messageVar } = location;

  const eventCode = `TWEAKCC_EVENTS.emit('message:'+${messageVar}.type,{message:${messageVar},uuid:${messageVar}.uuid});`;

  const newFile = oldFile.slice(0, insertPoint) + eventCode + oldFile.slice(insertPoint);

  showDiff(oldFile, newFile, eventCode, insertPoint, insertPoint);

  return newFile;
};

// ============================================================================
// THINKING/STREAMING EVENTS
// ============================================================================

/**
 * Find the thinking indicator update location
 */
export const findThinkingLocation = (
  fileContents: string
): { startIndex: number; endIndex: number; stateVar: string } | null => {
  // Look for thinking state updates
  // Pattern: setThinking(...) or thinking:true/false
  const thinkingPattern = /([$\w]+)\.thinking\s*=\s*(true|false)/;
  const match = fileContents.match(thinkingPattern);

  if (!match || match.index === undefined) {
    // Try alternative: setState with thinking
    const altPattern = /setState\([^)]*thinking:\s*([$\w]+|true|false)/;
    const altMatch = fileContents.match(altPattern);

    if (!altMatch || altMatch.index === undefined) {
      return null;
    }

    return {
      startIndex: altMatch.index,
      endIndex: altMatch.index + altMatch[0].length,
      stateVar: altMatch[1]
    };
  }

  return {
    startIndex: match.index,
    endIndex: match.index + match[0].length,
    stateVar: match[1]
  };
};

/**
 * Sub-patch 4: Inject thinking events
 *
 * ✓ VERIFIED: Pattern found in cli.js 2.0.55:
 *   case"thinking_delta":{if(G.type==="thinking")this._emit("thinking",Q.delta.thinking,G.thinking)
 *
 * We inject thinking:start at content_block_start for thinking type
 * and thinking:update at thinking_delta
 */
export const writeThinkingEvents = (oldFile: string): string | null => {
  // Pattern: case"thinking_delta":{if(G.type==="thinking")this._emit("thinking"
  // This is where thinking content is streamed
  const thinkingDeltaPattern = /case"thinking_delta":\{if\(([$\w]+)\.type==="thinking"\)this\._emit\("thinking"/;
  const match = oldFile.match(thinkingDeltaPattern);

  if (!match || match.index === undefined) {
    console.log('patch: events: writeThinkingEvents: could not find thinking_delta pattern (optional)');
    return oldFile;
  }

  const blockVar = match[1]; // G
  const originalCode = match[0];

  // Inject thinking:update event before the _emit call
  const newCode = `case"thinking_delta":{TWEAKCC_EVENTS.emit('thinking:update',{thinking:Q.delta.thinking});if(${blockVar}.type==="thinking")this._emit("thinking"`;

  const newFile = oldFile.replace(originalCode, newCode);

  if (newFile === oldFile) {
    return oldFile;
  }

  // Also inject thinking:start at content_block_start for thinking type
  // Pattern: case"content_block_start":switch(QA.content_block.type){...case"thinking":
  const thinkingStartPattern = /case"thinking":([$\w]+)\[[$\w]+\.index\]=\{\.\.\.[$\w]+\.content_block,thinking:""\}/;
  const startMatch = newFile.match(thinkingStartPattern);

  if (startMatch && startMatch.index !== undefined) {
    const startOriginal = startMatch[0];
    const startNew = `case"thinking":TWEAKCC_EVENTS.emit('thinking:start',{index:QA.index});${startMatch[1]}[QA.index]={...QA.content_block,thinking:""}`;
    const finalFile = newFile.replace(startOriginal, startNew);

    showDiff(oldFile, finalFile, '[thinking events]', match.index, match.index + originalCode.length);
    return finalFile;
  }

  showDiff(oldFile, newFile, newCode, match.index, match.index + originalCode.length);
  return newFile;
};

// ============================================================================
// STREAM EVENTS
// ============================================================================

/**
 * Sub-patch 4b: Inject stream events
 *
 * ✓ VERIFIED: Patterns found in cli.js 2.0.55:
 *   case"content_block_delta" - stream chunk events
 *   case"text_delta" - text content streaming
 *   case"message_start" - stream starts
 *   case"message_stop" - stream ends
 */
export const writeStreamEvents = (oldFile: string): string | null => {
  let newFile = oldFile;

  // 1. stream:start at message_start
  // Pattern: case"message_start":{q=QA.message,N=Date.now()-H
  const messageStartPattern = /case"message_start":\{([$\w]+)=([$\w]+)\.message,([$\w]+)=Date\.now\(\)/;
  const startMatch = newFile.match(messageStartPattern);

  if (startMatch && startMatch.index !== undefined) {
    const msgVar = startMatch[1];
    const eventVar = startMatch[2];
    const timeVar = startMatch[3];
    const original = startMatch[0];
    const replacement = `case"message_start":{TWEAKCC_EVENTS.emit('stream:start',{messageId:${eventVar}.message?.id});${msgVar}=${eventVar}.message,${timeVar}=Date.now()`;
    newFile = newFile.replace(original, replacement);
  }

  // 2. stream:chunk at text_delta
  // Pattern: case"text_delta":{if(G.type==="text")
  const textDeltaPattern = /case"text_delta":\{if\(([$\w]+)\.type==="text"\)/;
  const chunkMatch = newFile.match(textDeltaPattern);

  if (chunkMatch && chunkMatch.index !== undefined) {
    const blockVar = chunkMatch[1];
    const original = chunkMatch[0];
    const replacement = `case"text_delta":{TWEAKCC_EVENTS.emit('stream:chunk',{text:Q.delta.text,index:Q.index});if(${blockVar}.type==="text")`;
    newFile = newFile.replace(original, replacement);
  }

  // 3. stream:end at message_stop
  // Pattern: case"message_stop":
  const messageStopPattern = /case"message_stop":\{this\._addMessageParam/;
  const stopMatch = newFile.match(messageStopPattern);

  if (stopMatch && stopMatch.index !== undefined) {
    const original = stopMatch[0];
    const replacement = `case"message_stop":{TWEAKCC_EVENTS.emit('stream:end',{});this._addMessageParam`;
    newFile = newFile.replace(original, replacement);
  }

  if (newFile !== oldFile) {
    showDiff(oldFile, newFile, '[stream events]', 0, 100);
    return newFile;
  }

  console.log('patch: events: writeStreamEvents: no stream patterns matched (optional)');
  return oldFile;
};

// ============================================================================
// SESSION EVENTS
// ============================================================================

/**
 * Sub-patch 5: Inject session:start event at app initialization
 *
 * ✓ VERIFIED: Uses same pattern as toolsets.ts (getMainAppComponentBodyStart)
 */
export const writeSessionStartEvent = (oldFile: string): string | null => {
  // Find the main app component initialization
  // Pattern from toolsets.ts: getMainAppComponentBodyStart
  const appComponentPattern =
    /function ([$\w]+)\(\{(?:(?:commands|debug|initialPrompt|initialTools|initialMessages|initialCheckpoints|initialFileHistorySnapshots|mcpClients|dynamicMcpConfig|mcpCliEndpoint|autoConnectIdeFlag|strictMcpConfig|systemPrompt|appendSystemPrompt|onBeforeQuery|onTurnComplete|disabled):[$\w]+(?:=(?:[^,]+,|[^}]+\})|[,}]))+\)/g;

  const allMatches = Array.from(oldFile.matchAll(appComponentPattern));
  const matches = allMatches.filter(m => m[0].includes('commands:'));

  if (matches.length === 0) {
    console.error('patch: events: writeSessionStartEvent: could not find app component');
    return null;
  }

  // Take the longest match
  let longestMatch = matches[0];
  for (const match of matches) {
    if (match[0].length > longestMatch[0].length) {
      longestMatch = match;
    }
  }

  if (longestMatch.index === undefined) {
    return null;
  }

  // Insert after the function signature
  const insertPoint = longestMatch.index + longestMatch[0].length;

  // Check if this is inside a function body (next char should be {)
  const nextChars = oldFile.slice(insertPoint, insertPoint + 10);
  if (!nextChars.startsWith('{')) {
    // The function body starts differently, adjust
    const bodyStart = oldFile.indexOf('{', insertPoint);
    if (bodyStart === -1 || bodyStart > insertPoint + 50) {
      console.error('patch: events: writeSessionStartEvent: could not find function body');
      return null;
    }

    const eventCode = `TWEAKCC_EVENTS.emit('session:start',{timestamp:Date.now()});`;
    const newFile = oldFile.slice(0, bodyStart + 1) + eventCode + oldFile.slice(bodyStart + 1);

    showDiff(oldFile, newFile, eventCode, bodyStart + 1, bodyStart + 1);

    return newFile;
  }

  const eventCode = `TWEAKCC_EVENTS.emit('session:start',{timestamp:Date.now()});`;
  const newFile = oldFile.slice(0, insertPoint + 1) + eventCode + oldFile.slice(insertPoint + 1);

  showDiff(oldFile, newFile, eventCode, insertPoint + 1, insertPoint + 1);

  return newFile;
};

// ============================================================================
// MCP EVENTS
// ============================================================================

/**
 * Find MCP client connection location
 */
export const findMcpConnectLocation = (
  fileContents: string
): { location: number; clientVar: string } | null => {
  // Look for MCP client initialization/connection
  // Pattern: mcpClient.connect() or new McpClient(...)
  const connectPattern = /([$\w]+)\.(connect|initialize)\s*\(/;
  const match = fileContents.match(connectPattern);

  if (!match || match.index === undefined) {
    return null;
  }

  return {
    location: match.index,
    clientVar: match[1]
  };
};

/**
 * Sub-patch 6: Inject MCP events (optional - may not find location)
 *
 * ? UNVERIFIED: MCP patterns are complex due to multiple client implementations
 * Patterns to look for:
 *   - MCPClient constructor
 *   - .connect() calls on MCP clients
 *   - MCP tool invocations
 */
export const writeMcpEvents = (oldFile: string): string | null => {
  const newFile = oldFile;

  // MCP server connection pattern
  // Look for: mcpClients.map or similar patterns that iterate MCP clients
  const mcpIterPattern = /([$\w]+)\.map\(\(?([$\w]+)\)?\s*=>\s*\{[^}]*connect/;
  const iterMatch = newFile.match(mcpIterPattern);

  if (iterMatch && iterMatch.index !== undefined) {
    // We could inject mcp:connect here, but it's complex
    console.log('patch: events: found MCP iteration pattern (future: inject mcp:connect)');
  }

  // For now, MCP events are not fully implemented
  // The event types exist and can be emitted manually via /emit
  return oldFile;
};

// ============================================================================
// SLASH COMMAND FOR EVENT TESTING
// ============================================================================

/**
 * Generate the /emit slash command for testing custom events
 */
export const writeEmitSlashCommand = (oldFile: string): string | null => {
  const reactVar = getReactVar(oldFile);
  if (!reactVar) {
    console.error('patch: events: failed to find React variable');
    return null;
  }

  // Find the slash command array end
  const arrayStartPattern = /=>\[([$a-zA-Z_][$\w]{1,2},){30}/;
  const match = oldFile.match(arrayStartPattern);

  if (!match || match.index === undefined) {
    console.error('patch: events: failed to find slash command array');
    return null;
  }

  // Find the '[' in the match
  const bracketIndex = oldFile.indexOf('[', match.index);
  if (bracketIndex === -1) {
    return null;
  }

  // Use stack machine to find the matching ']'
  let level = 1;
  let i = bracketIndex + 1;

  while (i < oldFile.length && level > 0) {
    if (oldFile[i] === '[') {
      level++;
    } else if (oldFile[i] === ']') {
      level--;
      if (level === 0) {
        break;
      }
    }
    i++;
  }

  if (i >= oldFile.length) {
    return null;
  }

  const arrayEnd = i;

  // Generate the slash command definition
  const commandDef = `, {
  type: "local",
  name: "emit",
  description: "Emit a custom tweakcc event (for testing hooks)",
  argumentHint: "<event-name> [json-data]",
  isEnabled: () => !0,
  isHidden: !1,
  async call(A, B, I) {
    if (!A)
      throw new Error("Please specify an event name. Usage: /emit <event-name> [json-data]");
    const parts = A.split(' ');
    const eventName = 'custom:' + parts[0];
    let data = {};
    if (parts.length > 1) {
      try {
        data = JSON.parse(parts.slice(1).join(' '));
      } catch(e) {
        data = { raw: parts.slice(1).join(' ') };
      }
    }
    TWEAKCC_EVENTS.emit(eventName, data);
    return {
      type: "text",
      value: \`Emitted event \\x1b[1m\${eventName}\\x1b[0m with data: \${JSON.stringify(data)}\`,
    }
  },
  userFacingName() {
    return "emit";
  },
}`;

  const newFile = oldFile.slice(0, arrayEnd) + commandDef + oldFile.slice(arrayEnd);

  showDiff(oldFile, newFile, commandDef, arrayEnd, arrayEnd);

  return newFile;
};

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Apply all custom events patches to the file
 */
export const writeEvents = (
  oldFile: string,
  config: EventsConfig
): string | null => {
  // Return null if events not configured or disabled
  if (!config || !config.enabled || !config.hooks || config.hooks.length === 0) {
    return null;
  }

  let result: string | null = oldFile;

  // Step 1: Inject the event emitter
  result = writeEventEmitter(result, config);
  if (!result) {
    console.error('patch: events: step 1 failed (writeEventEmitter)');
    return null;
  }

  // Step 2: Inject tool lifecycle events (optional - may not find location)
  const toolResult = writeToolLifecycleEvents(result);
  if (toolResult) {
    result = toolResult;
  } else {
    console.log('patch: events: step 2 skipped (writeToolLifecycleEvents) - location not found');
  }

  // Step 3: Inject message events (optional)
  const messageResult = writeMessageEvents(result);
  if (messageResult) {
    result = messageResult;
  } else {
    console.log('patch: events: step 3 skipped (writeMessageEvents) - location not found');
  }

  // Step 4: Inject session start event
  const sessionResult = writeSessionStartEvent(result);
  if (sessionResult) {
    result = sessionResult;
  } else {
    console.log('patch: events: step 4 skipped (writeSessionStartEvent) - location not found');
  }

  // Step 5: Inject thinking events (optional)
  const thinkingResult = writeThinkingEvents(result);
  if (thinkingResult && thinkingResult !== result) {
    result = thinkingResult;
    console.log('patch: events: step 5 applied (writeThinkingEvents)');
  }

  // Step 6: Inject stream events (optional)
  const streamResult = writeStreamEvents(result);
  if (streamResult && streamResult !== result) {
    result = streamResult;
    console.log('patch: events: step 6 applied (writeStreamEvents)');
  }

  // Step 7: Inject MCP events (optional)
  const mcpResult = writeMcpEvents(result);
  if (mcpResult) {
    result = mcpResult;
  }

  // Step 8: Add /emit slash command for testing
  const emitResult = writeEmitSlashCommand(result);
  if (emitResult) {
    result = emitResult;
  } else {
    console.log('patch: events: step 8 skipped (writeEmitSlashCommand) - location not found');
  }

  return result;
};
