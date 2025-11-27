// Pattern Analyzer for Claude Code cli.js
// This utility helps discover and validate patterns in the minified JavaScript
//
// Usage: npx tweakcc --analyze
//        npx tweakcc --analyze --verbose
//        npx tweakcc --analyze --search "pattern"

import chalk from 'chalk';
import {
  findChalkVar,
  getReactVar,
  getRequireFuncName,
  findTextComponent,
  findBoxComponent,
  getModuleLoaderFunction,
} from './index.js';
import { findSelectComponentName, findDividerComponentName, getMainAppComponentBodyStart, getAppStateVarAndGetterFunction } from './toolsets.js';
import { findSlashCommandListEndPosition } from './slashCommands.js';

export interface PatternResult {
  name: string;
  found: boolean;
  value?: string;
  location?: number;
  context?: string;
}

export interface AnalysisReport {
  version: string;
  fileSize: number;
  patterns: PatternResult[];
  potentialHooks: {
    name: string;
    count: number;
    samples: string[];
  }[];
  warnings: string[];
}

/**
 * Analyze cli.js content and report on pattern matches
 */
export const analyzeCliJs = (
  content: string
): AnalysisReport => {
  const report: AnalysisReport = {
    version: 'unknown',
    fileSize: content.length,
    patterns: [],
    potentialHooks: [],
    warnings: [],
  };

  // Extract version
  const versionMatch = content.match(/VERSION:"(\d+\.\d+\.\d+)"/);
  if (versionMatch) {
    report.version = versionMatch[1];
  }

  // =========================================================================
  // Test existing patterns (from patches)
  // =========================================================================

  // Core utilities
  testPattern(report, 'chalkVar', () => findChalkVar(content));
  testPattern(report, 'reactVar', () => getReactVar(content));
  testPattern(report, 'requireFunc', () => getRequireFuncName(content));
  testPattern(report, 'moduleLoader', () => getModuleLoaderFunction(content));

  // Components
  testPattern(report, 'textComponent', () => findTextComponent(content));
  testPattern(report, 'boxComponent', () => findBoxComponent(content));
  testPattern(report, 'selectComponent', () => findSelectComponentName(content));
  testPattern(report, 'dividerComponent', () => findDividerComponentName(content));

  // App structure
  testPattern(report, 'mainAppBodyStart', () => {
    const pos = getMainAppComponentBodyStart(content);
    return pos !== null ? `position: ${pos}` : null;
  });
  testPattern(report, 'appStateVar', () => {
    const result = getAppStateVarAndGetterFunction(content);
    return result ? `${result.appStateVar} / ${result.appStateGetterFunction}` : null;
  });
  testPattern(report, 'slashCommandArrayEnd', () => {
    const pos = findSlashCommandListEndPosition(content);
    return pos !== null ? `position: ${pos}` : null;
  });

  // =========================================================================
  // Search for potential hook points
  // =========================================================================

  // Tool-related patterns - VERIFIED patterns from cli.js 2.0.55
  searchForHookPoints(report, content, 'tool_use case', /case\s*["']tool_use["']\s*:/g);
  searchForHookPoints(report, content, 'tool.run pattern (VERIFIED)', /let\s+[$\w]+=await\s+[$\w]+\.run\([$\w]+\);return\{type:"tool_result"/g);
  searchForHookPoints(report, content, 'tool input parse (VERIFIED)', /let\s+[$\w]+=[$\w]+\.input;if\("parse"in/g);
  searchForHookPoints(report, content, 'tool result return (VERIFIED)', /return\{type:"tool_result",tool_use_id:[$\w]+\.id,content:[$\w]+\}/g);
  searchForHookPoints(report, content, 'tool name check', /if\(([$\w]+)\.name===["'](\w+)["']\)/g);

  // Message-related patterns
  searchForHookPoints(report, content, 'role:user', /\{role:\s*["']user["']/g);
  searchForHookPoints(report, content, 'role:assistant', /\{role:\s*["']assistant["']/g);
  searchForHookPoints(report, content, 'role:system', /\{role:\s*["']system["']/g);
  searchForHookPoints(report, content, 'message append', /appendFileSync\(/g);
  searchForHookPoints(report, content, 'messages.push', /messages\.push\(/g);

  // Thinking-related patterns
  searchForHookPoints(report, content, 'thinking case', /case\s*["']thinking["']\s*:/g);
  searchForHookPoints(report, content, 'thinking words', /\{words:\s*\[/g);
  searchForHookPoints(report, content, 'isThinking', /isThinking/g);
  searchForHookPoints(report, content, 'streamMode', /streamMode/g);

  // Streaming patterns
  searchForHookPoints(report, content, 'stream chunk', /chunk|onChunk|handleChunk/gi);
  searchForHookPoints(report, content, 'SSE/stream', /text\/event-stream|EventSource/g);

  // API/Network patterns
  searchForHookPoints(report, content, 'fetch call', /\bfetch\s*\(/g);
  searchForHookPoints(report, content, 'API endpoint', /\/v1\/messages|\/v1\/complete/g);
  searchForHookPoints(report, content, 'anthropic', /anthropic/gi);

  // MCP patterns
  searchForHookPoints(report, content, 'MCP client', /mcpClient|MCP|mcp_/gi);
  searchForHookPoints(report, content, 'MCP connect', /\.connect\s*\(/g);

  // State management patterns
  searchForHookPoints(report, content, 'useState', /useState\s*\(/g);
  searchForHookPoints(report, content, 'useEffect', /useEffect\s*\(/g);
  searchForHookPoints(report, content, 'useMemo', /useMemo\s*\(/g);

  // Permission patterns
  searchForHookPoints(report, content, 'permission check', /checkPermission|hasPermission|askPermission/g);
  searchForHookPoints(report, content, 'auto-accept', /autoAccept|auto_accept/gi);

  return report;
};

function testPattern(
  report: AnalysisReport,
  name: string,
  finder: () => string | undefined | null
): void {
  try {
    const result = finder();
    report.patterns.push({
      name,
      found: result != null && result !== undefined,
      value: result ?? undefined,
    });
  } catch (error) {
    report.patterns.push({
      name,
      found: false,
      value: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function searchForHookPoints(
  report: AnalysisReport,
  content: string,
  name: string,
  pattern: RegExp
): void {
  const matches = Array.from(content.matchAll(pattern));
  const samples: string[] = [];

  for (const match of matches.slice(0, 3)) {
    if (match.index !== undefined) {
      // Get context around the match
      const start = Math.max(0, match.index - 30);
      const end = Math.min(content.length, match.index + match[0].length + 50);
      const context = content.slice(start, end).replace(/\n/g, '\\n');
      samples.push(`[${match.index}] ...${context}...`);
    }
  }

  report.potentialHooks.push({
    name,
    count: matches.length,
    samples,
  });
}

/**
 * Search for a custom pattern in cli.js
 */
export const searchPattern = (
  content: string,
  pattern: string,
  maxResults: number = 10
): { count: number; matches: { index: number; context: string }[] } => {
  const regex = new RegExp(pattern, 'gi');
  const matches = Array.from(content.matchAll(regex));
  const results: { index: number; context: string }[] = [];

  for (const match of matches.slice(0, maxResults)) {
    if (match.index !== undefined) {
      const start = Math.max(0, match.index - 50);
      const end = Math.min(content.length, match.index + match[0].length + 100);
      results.push({
        index: match.index,
        context: content.slice(start, end),
      });
    }
  }

  return { count: matches.length, matches: results };
};

/**
 * Print analysis report to console
 */
export const printReport = (report: AnalysisReport, verbose: boolean = false): void => {
  console.log(chalk.bold('\n═══════════════════════════════════════════════════════════'));
  console.log(chalk.bold('  TWEAKCC PATTERN ANALYZER'));
  console.log(chalk.bold('═══════════════════════════════════════════════════════════\n'));

  console.log(chalk.cyan('Version:'), report.version);
  console.log(chalk.cyan('File size:'), `${(report.fileSize / 1024).toFixed(1)} KB`);

  // Patterns section
  console.log(chalk.bold('\n─── Core Patterns ───────────────────────────────────────────\n'));

  const foundPatterns = report.patterns.filter(p => p.found);
  const missingPatterns = report.patterns.filter(p => !p.found);

  for (const pattern of foundPatterns) {
    console.log(chalk.green('✓'), chalk.white(pattern.name + ':'), chalk.gray(pattern.value));
  }

  if (missingPatterns.length > 0) {
    console.log();
    for (const pattern of missingPatterns) {
      console.log(chalk.red('✗'), chalk.white(pattern.name + ':'), chalk.red(pattern.value || 'not found'));
    }
  }

  console.log(chalk.bold(`\n─── Pattern Summary: ${foundPatterns.length}/${report.patterns.length} found ───\n`));

  // Potential hooks section
  console.log(chalk.bold('─── Potential Hook Points ───────────────────────────────────\n'));

  // Sort by count descending
  const sortedHooks = [...report.potentialHooks].sort((a, b) => b.count - a.count);

  for (const hook of sortedHooks) {
    const countColor = hook.count > 0 ? chalk.green : chalk.red;
    console.log(countColor(`[${hook.count.toString().padStart(4)}]`), chalk.white(hook.name));

    if (verbose && hook.samples.length > 0) {
      for (const sample of hook.samples) {
        console.log(chalk.gray('        ' + sample.slice(0, 100) + (sample.length > 100 ? '...' : '')));
      }
    }
  }

  // Warnings
  if (report.warnings.length > 0) {
    console.log(chalk.bold('\n─── Warnings ────────────────────────────────────────────────\n'));
    for (const warning of report.warnings) {
      console.log(chalk.yellow('⚠'), warning);
    }
  }

  console.log(chalk.bold('\n═══════════════════════════════════════════════════════════\n'));
};

/**
 * Print custom search results
 */
export const printSearchResults = (
  pattern: string,
  results: { count: number; matches: { index: number; context: string }[] }
): void => {
  console.log(chalk.bold(`\nSearch results for: ${chalk.cyan(pattern)}`));
  console.log(chalk.gray(`Found ${results.count} matches\n`));

  for (const match of results.matches) {
    console.log(chalk.yellow(`[${match.index}]`));
    // Highlight the pattern in context
    console.log(chalk.gray(match.context.replace(/\n/g, '\\n')));
    console.log();
  }
};
