// Custom Events Hook System for Claude Code
// Allows users to hook into CC's internal events (tools, messages, thinking, etc.)
//
// Please see the note about writing patches in ./index.ts.

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

  function matchesFilter(hook, eventData) {
    if (!hook.filter) return true;

    // Tool filter
    if (hook.filter.tools && eventData.toolName) {
      if (!hook.filter.tools.includes(eventData.toolName)) return false;
    }

    // Message type filter
    if (hook.filter.messageTypes && eventData.messageType) {
      if (!hook.filter.messageTypes.includes(eventData.messageType)) return false;
    }

    return true;
  }

  function executeHook(hook, event, data) {
    const eventData = {
      event,
      timestamp: new Date().toISOString(),
      ...data
    };

    if (!matchesFilter(hook, eventData)) {
      log('debug', 'Hook filtered out', { hookId: hook.id, event });
      return;
    }

    log('debug', 'Executing hook', { hookId: hook.id, event, type: hook.type });

    try {
      if (hook.type === 'command' && hook.command) {
        const env = {
          ...process.env,
          TWEAKCC_EVENT: event,
          TWEAKCC_DATA: JSON.stringify(eventData)
        };

        if (hook.async !== false) {
          // Non-blocking execution
          const child = spawn('sh', ['-c', hook.command], {
            env,
            detached: true,
            stdio: 'ignore'
          });
          child.unref();
        } else {
          // Blocking execution
          execSync(hook.command, {
            env,
            timeout: hook.timeout || 5000,
            stdio: 'ignore'
          });
        }
      } else if (hook.type === 'webhook' && hook.webhook) {
        // Fire-and-forget webhook
        const https = ${requireFunc}('https');
        const http = ${requireFunc}('http');
        const url = new URL(hook.webhook);
        const client = url.protocol === 'https:' ? https : http;

        const postData = JSON.stringify(eventData);
        const req = client.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: hook.timeout || 5000
        });

        req.on('error', (e) => {
          log('error', 'Webhook failed', { hookId: hook.id, error: e.message });
        });

        req.write(postData);
        req.end();
      } else if (hook.type === 'script' && hook.script) {
        // Dynamic script execution
        try {
          const scriptPath = hook.script.startsWith('~')
            ? hook.script.replace('~', homedir())
            : hook.script;

          // Use child process to run the script
          const child = spawn('node', [scriptPath], {
            env: {
              ...process.env,
              TWEAKCC_EVENT: event,
              TWEAKCC_DATA: JSON.stringify(eventData)
            },
            detached: hook.async !== false,
            stdio: 'ignore'
          });

          if (hook.async !== false) {
            child.unref();
          }
        } catch (e) {
          log('error', 'Script execution failed', { hookId: hook.id, error: e.message });
        }
      }

      log('info', 'Hook executed', { hookId: hook.id, event });
    } catch (e) {
      log('error', 'Hook execution error', { hookId: hook.id, event, error: e.message });
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
 */
export const writeToolLifecycleEvents = (oldFile: string): string | null => {
  // Find the pattern where tools are executed
  // In CC, this is typically in the query handler or tool executor

  // Look for tool use content block processing
  const toolUsePattern = /case\s*["']tool_use["']\s*:/;
  const match = oldFile.match(toolUsePattern);

  if (!match || match.index === undefined) {
    console.error('patch: events: writeToolLifecycleEvents: could not find tool_use case');
    return null;
  }

  // Find the next statement after case "tool_use":
  // We want to inject our event emission here
  const afterCase = oldFile.slice(match.index + match[0].length, match.index + match[0].length + 500);

  // Look for the tool execution
  const execPattern = /(const|let|var)\s+([$\w]+)\s*=\s*await\s+([$\w]+)\(/;
  const execMatch = afterCase.match(execPattern);

  if (!execMatch || execMatch.index === undefined) {
    // Try simpler pattern
    const simplePattern = /await\s+([$\w]+)\(/;
    const simpleMatch = afterCase.match(simplePattern);

    if (!simpleMatch || simpleMatch.index === undefined) {
      console.error('patch: events: writeToolLifecycleEvents: could not find tool execution');
      return null;
    }

    const insertPoint = match.index + match[0].length + simpleMatch.index;
    // simpleMatch[1] contains the tool function name

    // Inject event emission before the await
    const beforeCode = `TWEAKCC_EVENTS.emit('tool:before',{toolName:'unknown'});`;

    const newFile = oldFile.slice(0, insertPoint) + beforeCode + oldFile.slice(insertPoint);

    showDiff(oldFile, newFile, beforeCode, insertPoint, insertPoint);

    return newFile;
  }

  const insertPoint = match.index + match[0].length + execMatch.index;
  const resultVar = execMatch[2];
  // execMatch[3] contains the tool function name

  // We need to wrap the execution
  const beforeCode = `TWEAKCC_EVENTS.emit('tool:before',{});`;

  let newFile = oldFile.slice(0, insertPoint) + beforeCode + oldFile.slice(insertPoint);

  // Now find where to inject after (after the assignment completes)
  const assignmentEnd = newFile.indexOf(';', insertPoint + beforeCode.length);
  if (assignmentEnd !== -1) {
    const afterCode = `TWEAKCC_EVENTS.emit('tool:after',{result:${resultVar}});`;
    newFile = newFile.slice(0, assignmentEnd + 1) + afterCode + newFile.slice(assignmentEnd + 1);

    showDiff(oldFile, newFile, beforeCode + '...' + afterCode, insertPoint, assignmentEnd + 1);
  }

  return newFile;
};

// ============================================================================
// MESSAGE LIFECYCLE EVENTS
// ============================================================================

/**
 * Find where messages are appended/created
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
 */
export const writeThinkingEvents = (oldFile: string): string | null => {
  // Find the thinking verb display component
  // This is where the "Thinking..." status is rendered
  const thinkingVerbPattern = /\{words:\s*\[/;
  const match = oldFile.match(thinkingVerbPattern);

  if (!match || match.index === undefined) {
    console.error('patch: events: writeThinkingEvents: could not find thinking verbs pattern');
    return null;
  }

  // Look backwards for the function/component containing this
  const lookback = oldFile.slice(Math.max(0, match.index - 300), match.index);
  const funcPattern = /function\s+([$\w]+)\s*\([^)]*\)\s*\{[^{}]*$/;
  const funcMatch = lookback.match(funcPattern);

  if (!funcMatch) {
    // Can't find the enclosing function, skip this patch
    return oldFile;
  }

  // For now, return unchanged - thinking events are complex to inject
  // Would need to track state changes in the thinking indicator component
  return oldFile;
};

// ============================================================================
// SESSION EVENTS
// ============================================================================

/**
 * Sub-patch 5: Inject session:start event at app initialization
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
 */
export const writeMcpEvents = (oldFile: string): string | null => {
  const location = findMcpConnectLocation(oldFile);

  if (!location) {
    // MCP events are optional - don't fail if not found
    return oldFile;
  }

  // For now, MCP events require more complex injection
  // Return unchanged
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

  // Step 5: Inject MCP events (optional)
  const mcpResult = writeMcpEvents(result);
  if (mcpResult) {
    result = mcpResult;
  }

  // Step 6: Add /emit slash command for testing
  const emitResult = writeEmitSlashCommand(result);
  if (emitResult) {
    result = emitResult;
  } else {
    console.log('patch: events: step 6 skipped (writeEmitSlashCommand) - location not found');
  }

  return result;
};
