import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  findTransformRunnerInsertionPoint,
  generateTransformRunnerCode,
  writeTransformRunner,
  writePromptTransform,
  writeResponseTransform,
  writeToolInputTransform,
  writeToolOutputTransform,
  writeTransforms,
} from './transforms.js';
import { TransformsConfig, TransformConfig } from '../types.js';

// Sample cli.js content for pattern matching
const SAMPLE_CLI_JS = `
import{createRequire as abc}from"node:module";
var xyz=abc(import.meta.url);
var someVar=123;

function processMessages() {
  // User message pattern
  const msg = {role:"user",content:userInput};
  messages.push(msg);

  // Assistant message pattern
  const response = {role:"assistant",content:assistantResponse};

  // Tool execution pattern
  let Y=Z.input;if("parse"in I&&I.parse)Y=I.parse(Y);let J=await I.run(Y);return{type:"tool_result",tool_use_id:Z.id,content:J}
}
`;

describe('transforms.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('findTransformRunnerInsertionPoint', () => {
    it('should find insertion point after imports', () => {
      const content = 'import{foo}from"bar";var x=1;function main(){}';
      const point = findTransformRunnerInsertionPoint(content);
      expect(point).toBeGreaterThan(0);
    });

    it('should return 0 for content without imports', () => {
      const content = 'function main() {}';
      const point = findTransformRunnerInsertionPoint(content);
      expect(point).toBe(0);
    });
  });

  describe('generateTransformRunnerCode', () => {
    it('should generate valid transform runner code', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          {
            id: 'test-transform',
            name: 'Test Transform',
            transform: 'tool:input',
            script: '~/.tweakcc/transforms/test.js',
            enabled: true,
            priority: 10,
          },
        ],
      };

      const code = generateTransformRunnerCode('require', config);

      expect(code).toContain('TWEAKCC_TRANSFORMS');
      expect(code).toContain('function executeTransform');
      expect(code).toContain('function runTransforms');
      expect(code).toContain('test-transform');
    });

    it('should filter out disabled transforms', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          {
            id: 'enabled-transform',
            transform: 'tool:input',
            script: 'enabled.js',
            enabled: true,
          },
          {
            id: 'disabled-transform',
            transform: 'tool:output',
            script: 'disabled.js',
            enabled: false,
          },
        ],
      };

      const code = generateTransformRunnerCode('require', config);

      expect(code).toContain('enabled-transform');
      expect(code).not.toContain('disabled-transform');
    });

    it('should sort transforms by priority', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          { id: 'low-priority', transform: 'tool:input', script: 'low.js', enabled: true, priority: 200 },
          { id: 'high-priority', transform: 'tool:input', script: 'high.js', enabled: true, priority: 10 },
          { id: 'default-priority', transform: 'tool:input', script: 'default.js', enabled: true },
        ],
      };

      const code = generateTransformRunnerCode('require', config);

      // Verify all transforms are included
      expect(code).toContain('low-priority');
      expect(code).toContain('high-priority');
      expect(code).toContain('default-priority');

      // High priority should appear before low priority in the sorted array
      const highIndex = code.indexOf('high-priority');
      const lowIndex = code.indexOf('low-priority');
      expect(highIndex).toBeLessThan(lowIndex);
    });

    it('should include secure temp file handling', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          { id: 'test', transform: 'tool:input', script: 'test.js', enabled: true },
        ],
      };

      const code = generateTransformRunnerCode('require', config);

      // Check for secure temp directory creation
      expect(code).toContain('mkdtempSync');
      expect(code).toContain('chmodSync');
      expect(code).toContain('0o700');
      expect(code).toContain('rmdirSync');
    });

    it('should include timeout configuration', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          { id: 'test', transform: 'tool:input', script: 'test.js', enabled: true, timeout: 10000 },
        ],
      };

      const code = generateTransformRunnerCode('require', config);

      expect(code).toContain('timeout');
      expect(code).toContain('10000');
    });
  });

  describe('writeTransformRunner', () => {
    it('should inject transform runner into file', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          { id: 'test', transform: 'tool:input', script: 'test.js', enabled: true },
        ],
      };

      const result = writeTransformRunner(SAMPLE_CLI_JS, config);

      expect(result).not.toBeNull();
      expect(result).toContain('TWEAKCC_TRANSFORMS');
      expect(result!.length).toBeGreaterThan(SAMPLE_CLI_JS.length);
    });
  });

  describe('writePromptTransform', () => {
    it('should wrap user message content with transform', () => {
      const content = 'const msg = {role:"user",content:userInput}';

      const result = writePromptTransform(content);

      expect(result).not.toBeNull();
      expect(result).toContain('TWEAKCC_TRANSFORMS.hasTransforms');
      expect(result).toContain("'prompt:before'");
    });

    it('should return null if pattern not found', () => {
      const content = 'function foo() { return bar; }';

      const result = writePromptTransform(content);

      expect(result).toBeNull();
    });
  });

  describe('writeResponseTransform', () => {
    it('should wrap assistant message content with transform', () => {
      const content = 'const response = {role:"assistant",content:assistantResponse}';

      const result = writeResponseTransform(content);

      expect(result).not.toBeNull();
      expect(result).toContain('TWEAKCC_TRANSFORMS.hasTransforms');
      expect(result).toContain("'response:before'");
    });

    it('should return original content if pattern not found', () => {
      const content = 'function foo() { return bar; }';

      const result = writeResponseTransform(content);

      expect(result).toBe(content);
    });
  });

  describe('writeToolInputTransform', () => {
    it('should wrap tool input with transform', () => {
      const content = 'let Y=Z.input;if("parse"in I&&I.parse)Y=I.parse(Y);let J=await I.run(Y)';

      const result = writeToolInputTransform(content);

      expect(result).not.toBeNull();
      expect(result).toContain('TWEAKCC_TRANSFORMS.hasTransforms');
      expect(result).toContain("'tool:input'");
    });

    it('should return original content if pattern not found', () => {
      const content = 'function foo() { return bar; }';

      const result = writeToolInputTransform(content);

      expect(result).toBe(content);
    });
  });

  describe('writeToolOutputTransform', () => {
    it('should wrap tool output with transform', () => {
      const content = 'return{type:"tool_result",tool_use_id:Z.id,content:J}';

      const result = writeToolOutputTransform(content);

      expect(result).not.toBeNull();
      expect(result).toContain('TWEAKCC_TRANSFORMS.hasTransforms');
      expect(result).toContain("'tool:output'");
    });

    it('should return original content if pattern not found', () => {
      const content = 'function foo() { return bar; }';

      const result = writeToolOutputTransform(content);

      expect(result).toBe(content);
    });
  });

  describe('writeTransforms (orchestrator)', () => {
    it('should return null if transforms not enabled', () => {
      const config: TransformsConfig = {
        enabled: false,
        transforms: [],
      };

      const result = writeTransforms(SAMPLE_CLI_JS, config);

      expect(result).toBeNull();
    });

    it('should return null if no transforms configured', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [],
      };

      const result = writeTransforms(SAMPLE_CLI_JS, config);

      expect(result).toBeNull();
    });

    it('should apply transform runner when configured', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          {
            id: 'test-transform',
            transform: 'tool:input',
            script: 'test.js',
            enabled: true,
          },
        ],
      };

      const result = writeTransforms(SAMPLE_CLI_JS, config);

      expect(result).not.toBeNull();
      expect(result).toContain('TWEAKCC_TRANSFORMS');
    });

    it('should only apply relevant transforms based on type', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          { id: 'prompt-transform', transform: 'prompt:before', script: 'prompt.js', enabled: true },
        ],
      };

      const result = writeTransforms(SAMPLE_CLI_JS, config);

      expect(result).not.toBeNull();
      // Should have transform runner
      expect(result).toContain('TWEAKCC_TRANSFORMS');
    });
  });

  describe('transform configuration options', () => {
    it('should handle filter configuration', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          {
            id: 'filtered-transform',
            transform: 'tool:input',
            script: 'filtered.js',
            enabled: true,
            filter: {
              tools: ['Bash', 'Edit'],
            },
          },
        ],
      };

      const code = generateTransformRunnerCode('require', config);

      expect(code).toContain('filter');
      expect(code).toContain('Bash');
      expect(code).toContain('Edit');
    });

    it('should handle timeout configuration', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          {
            id: 'timeout-transform',
            transform: 'tool:output',
            script: 'timeout.js',
            enabled: true,
            timeout: 15000,
          },
        ],
      };

      const code = generateTransformRunnerCode('require', config);

      expect(code).toContain('15000');
    });

    it('should resolve home directory paths', () => {
      const config: TransformsConfig = {
        enabled: true,
        transforms: [
          {
            id: 'home-path',
            transform: 'tool:input',
            script: '~/.tweakcc/transforms/test.js',
            enabled: true,
          },
        ],
      };

      const code = generateTransformRunnerCode('require', config);

      expect(code).toContain('resolvePath');
      expect(code).toContain('homedir()');
    });
  });

  describe('transform types', () => {
    const transformTypes: Array<TransformConfig['transform']> = [
      'prompt:before',
      'prompt:system',
      'response:before',
      'response:stream',
      'tool:input',
      'tool:output',
    ];

    transformTypes.forEach(transformType => {
      it(`should handle ${transformType} transform type`, () => {
        const config: TransformsConfig = {
          enabled: true,
          transforms: [
            {
              id: `${transformType}-test`,
              transform: transformType,
              script: 'test.js',
              enabled: true,
            },
          ],
        };

        const code = generateTransformRunnerCode('require', config);

        expect(code).toContain(`${transformType}-test`);
        expect(code).toContain(transformType);
      });
    });
  });
});
