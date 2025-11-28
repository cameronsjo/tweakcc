import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  findEventEmitterInsertionPoint,
  generateEventEmitterCode,
  writeEventEmitter,
  writeToolLifecycleEvents,
  writeThinkingEvents,
  writeStreamEvents,
  writeEvents,
} from './events.js';
import { EventsConfig } from '../types.js';

// Mock sample cli.js content for pattern matching tests
const SAMPLE_CLI_JS = `
import{createRequire as abc}from"node:module";
var xyz=abc(import.meta.url);
var someVar=123;

function mainCode() {
  // Tool execution pattern
  let Y=Z.input;if("parse"in I&&I.parse)Y=I.parse(Y);let J=await I.run(Y);return{type:"tool_result",tool_use_id:Z.id,content:J}
}

// Message append pattern
if(!messages.has(msg.uuid)){if(fs.appendFileSync(

// Thinking patterns
case"thinking_delta":{if(G.type==="thinking")this._emit("thinking",Q.delta.thinking,G.thinking)

// Stream patterns
case"message_start":{q=QA.message,N=Date.now()-H
case"text_delta":{if(G.type==="text")
case"message_stop":{this._addMessageParam

// App component pattern
function mainApp({commands:a,debug:b,initialPrompt:c,initialTools:d,initialMessages:e,initialCheckpoints:f,initialFileHistorySnapshots:g,mcpClients:h,dynamicMcpConfig:i,mcpCliEndpoint:j,autoConnectIdeFlag:k,strictMcpConfig:l,systemPrompt:m,appendSystemPrompt:n,onBeforeQuery:o,onTurnComplete:p,disabled:q}){

// Slash command array pattern
=>[AB,CD,EF,GH,IJ,KL,MN,OP,QR,ST,UV,WX,YZ,AA,BB,CC,DD,EE,FF,GG,HH,II,JJ,KK,LL,MM,NN,OO,PP,QQ,RR]
`;

describe('events.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('findEventEmitterInsertionPoint', () => {
    it('should find insertion point after imports', () => {
      const content = 'import{foo}from"bar";var x=1;var y=2;function main(){}';
      const point = findEventEmitterInsertionPoint(content);
      expect(point).toBeGreaterThan(0);
      expect(point).toBeLessThan(content.length);
    });

    it('should return 0 for empty content', () => {
      const point = findEventEmitterInsertionPoint('');
      expect(point).toBe(0);
    });

    it('should return 0 for content without imports', () => {
      const content = 'function main() { console.log("hello"); }';
      const point = findEventEmitterInsertionPoint(content);
      expect(point).toBe(0);
    });
  });

  describe('generateEventEmitterCode', () => {
    it('should generate valid event emitter code', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [
          {
            id: 'test-hook',
            name: 'Test Hook',
            events: 'tool:before',
            type: 'command',
            command: 'echo test',
            enabled: true,
          },
        ],
        logging: {
          enabled: true,
          logFile: '~/.tweakcc/events.log',
          logLevel: 'info',
        },
      };

      const code = generateEventEmitterCode('require', config);

      expect(code).toContain('TWEAKCC_EVENTS');
      expect(code).toContain('function emit(event, data');
      expect(code).toContain('function executeHook');
      expect(code).toContain('function matchesFilter');
      expect(code).toContain('test-hook');
    });

    it('should filter out disabled hooks', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [
          {
            id: 'enabled-hook',
            events: 'tool:before',
            type: 'command',
            command: 'echo enabled',
            enabled: true,
          },
          {
            id: 'disabled-hook',
            events: 'tool:after',
            type: 'command',
            command: 'echo disabled',
            enabled: false,
          },
        ],
      };

      const code = generateEventEmitterCode('require', config);

      expect(code).toContain('enabled-hook');
      expect(code).not.toContain('disabled-hook');
    });

    it('should include base64 encoding for security', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [{ id: 'test', events: 'tool:before', type: 'command', command: 'echo', enabled: true }],
      };

      const code = generateEventEmitterCode('require', config);

      expect(code).toContain('TWEAKCC_DATA_BASE64');
      expect(code).toContain('Buffer.from(jsonData).toString(\'base64\')');
    });

    it('should include regex caching and validation', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [{ id: 'test', events: 'tool:before', type: 'command', command: 'echo', enabled: true }],
      };

      const code = generateEventEmitterCode('require', config);

      expect(code).toContain('regexCache');
      expect(code).toContain('getCompiledRegex');
      expect(code).toContain('MAX_REGEX_LENGTH');
      expect(code).toContain('ReDoS');
    });
  });

  describe('writeEventEmitter', () => {
    it('should inject event emitter into file', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [{ id: 'test', events: 'tool:before', type: 'command', command: 'echo', enabled: true }],
      };

      const result = writeEventEmitter(SAMPLE_CLI_JS, config);

      expect(result).not.toBeNull();
      expect(result).toContain('TWEAKCC_EVENTS');
      expect(result!.length).toBeGreaterThan(SAMPLE_CLI_JS.length);
    });
  });

  describe('writeToolLifecycleEvents', () => {
    it('should find and wrap tool.run pattern', () => {
      const content = 'let Y=Z.input;if("parse"in I&&I.parse)Y=I.parse(Y);let J=await I.run(Y);return{type:"tool_result",tool_use_id:Z.id,content:J}';

      const result = writeToolLifecycleEvents(content);

      expect(result).not.toBeNull();
      expect(result).toContain("TWEAKCC_EVENTS.emit('tool:before'");
      expect(result).toContain("TWEAKCC_EVENTS.emit('tool:after'");
    });

    it('should return null if pattern not found', () => {
      const content = 'function foo() { return bar; }';

      const result = writeToolLifecycleEvents(content);

      expect(result).toBeNull();
    });
  });

  describe('writeThinkingEvents', () => {
    it('should inject thinking events if pattern found', () => {
      const content = 'case"thinking_delta":{if(G.type==="thinking")this._emit("thinking",Q.delta.thinking,G.thinking)';

      const result = writeThinkingEvents(content);

      expect(result).not.toBeNull();
      expect(result).toContain("TWEAKCC_EVENTS.emit('thinking:update'");
    });

    it('should return original content if pattern not found', () => {
      const content = 'function foo() { return bar; }';

      const result = writeThinkingEvents(content);

      expect(result).toBe(content);
    });
  });

  describe('writeStreamEvents', () => {
    it('should inject stream:start event', () => {
      const content = 'case"message_start":{q=QA.message,N=Date.now()-H';

      const result = writeStreamEvents(content);

      expect(result).toContain("TWEAKCC_EVENTS.emit('stream:start'");
    });

    it('should inject stream:chunk event', () => {
      const content = 'case"text_delta":{if(G.type==="text")';

      const result = writeStreamEvents(content);

      expect(result).toContain("TWEAKCC_EVENTS.emit('stream:chunk'");
    });

    it('should inject stream:end event', () => {
      const content = 'case"message_stop":{this._addMessageParam';

      const result = writeStreamEvents(content);

      expect(result).toContain("TWEAKCC_EVENTS.emit('stream:end'");
    });
  });

  describe('writeEvents (orchestrator)', () => {
    it('should return null if events not enabled', () => {
      const config: EventsConfig = {
        enabled: false,
        hooks: [],
      };

      const result = writeEvents(SAMPLE_CLI_JS, config);

      expect(result).toBeNull();
    });

    it('should return null if no hooks configured', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [],
      };

      const result = writeEvents(SAMPLE_CLI_JS, config);

      expect(result).toBeNull();
    });

    it('should apply all patches when properly configured', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [
          {
            id: 'test-hook',
            events: ['tool:before', 'tool:after'],
            type: 'command',
            command: 'echo test',
            enabled: true,
          },
        ],
        logging: {
          enabled: true,
          logLevel: 'debug',
        },
      };

      const result = writeEvents(SAMPLE_CLI_JS, config);

      expect(result).not.toBeNull();
      expect(result).toContain('TWEAKCC_EVENTS');
    });
  });

  describe('hook configuration validation', () => {
    it('should handle webhook hooks', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [
          {
            id: 'webhook-hook',
            events: 'tool:after',
            type: 'webhook',
            webhook: 'http://localhost:8080/events',
            enabled: true,
          },
        ],
      };

      const code = generateEventEmitterCode('require', config);

      expect(code).toContain('webhook-hook');
      expect(code).toContain('http');
      expect(code).toContain('https');
    });

    it('should handle script hooks', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [
          {
            id: 'script-hook',
            events: 'tool:before',
            type: 'script',
            script: '~/.tweakcc/hooks/my-hook.js',
            enabled: true,
          },
        ],
      };

      const code = generateEventEmitterCode('require', config);

      expect(code).toContain('script-hook');
      expect(code).toContain('spawn');
    });

    it('should handle filters', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [
          {
            id: 'filtered-hook',
            events: 'tool:before',
            type: 'command',
            command: 'echo filtered',
            enabled: true,
            filter: {
              tools: ['Bash', 'Edit'],
              toolsExclude: ['Read'],
              regex: 'pattern',
            },
          },
        ],
      };

      const code = generateEventEmitterCode('require', config);

      expect(code).toContain('filter');
      expect(code).toContain('Bash');
      expect(code).toContain('Edit');
    });

    it('should handle retry configuration', () => {
      const config: EventsConfig = {
        enabled: true,
        hooks: [
          {
            id: 'retry-hook',
            events: 'tool:before',
            type: 'command',
            command: 'echo retry',
            enabled: true,
            onError: 'retry',
            retryCount: 5,
            retryDelay: 2000,
          },
        ],
      };

      const code = generateEventEmitterCode('require', config);

      expect(code).toContain('retry-hook');
      expect(code).toContain('retryCount');
    });
  });
});
