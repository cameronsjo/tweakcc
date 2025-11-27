import { render } from 'ink';
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import App from './App.js';
import {
  CLIJS_SEARCH_PATH_INFO,
  CONFIG_FILE,
  CONFIG_DIR,
} from './utils/types.js';
import { startupCheck, readConfigFile } from './utils/config.js';
import { enableDebug } from './utils/misc.js';
import { applyCustomization } from './utils/patches/index.js';
import { preloadStringsFile } from './utils/promptSync.js';
import { analyzeCliJs, printReport, searchPattern, printSearchResults } from './utils/patches/analyzer.js';

const createExampleConfigIfMissing = async (
  examplePath: string
): Promise<void> => {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    // Only create if config file doesn't exist
    try {
      await fs.stat(CONFIG_FILE);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        const exampleConfig = {
          ccInstallationDir: examplePath,
        };
        await fs.writeFile(CONFIG_FILE, JSON.stringify(exampleConfig, null, 2));
      }
    }
  } catch {
    // Silently fail if we can't write the config file
  }
};

const main = async () => {
  const program = new Command();
  program
    .name('tweakcc')
    .description(
      'Command-line tool to customize your Claude Code theme colors, thinking verbs and more.'
    )
    .version('3.1.3')
    .option('-d, --debug', 'enable debug mode')
    .option('-a, --apply', 'apply saved customizations without interactive UI')
    .option('--analyze', 'analyze cli.js patterns for debugging')
    .option('--verbose', 'show verbose output (with --analyze)')
    .option('--search <pattern>', 'search for custom regex pattern in cli.js');

  // Hooks management subcommand
  const hooksCmd = program
    .command('hooks')
    .description('Manage event hooks');

  hooksCmd
    .command('list')
    .description('List all configured hooks')
    .action(async () => {
      const config = await readConfigFile();
      const hooks = config.settings?.events?.hooks || [];

      if (hooks.length === 0) {
        console.log(chalk.yellow('No hooks configured.'));
        console.log(chalk.gray('Add hooks to your config.json under settings.events.hooks'));
        process.exit(0);
      }

      console.log(chalk.cyan('\n═══ Configured Hooks ═══\n'));
      for (const hook of hooks) {
        const status = hook.enabled ? chalk.green('✓') : chalk.red('✗');
        const events = Array.isArray(hook.events) ? hook.events.join(', ') : hook.events;
        console.log(`${status} ${chalk.bold(hook.id)} ${chalk.gray(`(${hook.name || 'unnamed'})`)}`);
        console.log(`   Events: ${chalk.cyan(events)}`);
        console.log(`   Type: ${hook.type}`);
        if (hook.type === 'command') console.log(`   Command: ${chalk.gray(hook.command)}`);
        if (hook.type === 'webhook') console.log(`   Webhook: ${chalk.gray(hook.webhook)}`);
        if (hook.type === 'script') console.log(`   Script: ${chalk.gray(hook.script)}`);
        if (hook.filter) console.log(`   Filter: ${chalk.gray(JSON.stringify(hook.filter))}`);
        console.log();
      }
      process.exit(0);
    });

  hooksCmd
    .command('add <event> <command>')
    .description('Add a quick command hook')
    .option('-n, --name <name>', 'hook name')
    .option('--sync', 'run synchronously (blocking)')
    .option('--filter-tool <tool>', 'only trigger for specific tool')
    .action(async (event, command, opts) => {
      const config = await readConfigFile();

      if (!config.settings.events) {
        config.settings.events = { enabled: true, hooks: [] };
      }

      const hookId = `hook-${Date.now()}`;
      const newHook = {
        id: hookId,
        name: opts.name || `Quick hook for ${event}`,
        events: event,
        type: 'command' as const,
        command: command,
        enabled: true,
        async: !opts.sync,
        ...(opts.filterTool ? { filter: { tools: [opts.filterTool] } } : {})
      };

      config.settings.events.hooks.push(newHook);

      await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
      console.log(chalk.green(`✓ Added hook: ${hookId}`));
      console.log(chalk.gray('Run `tweakcc --apply` to apply changes.'));
      process.exit(0);
    });

  hooksCmd
    .command('remove <id>')
    .description('Remove a hook by ID')
    .action(async (id) => {
      const config = await readConfigFile();

      if (!config.settings.events?.hooks) {
        console.error(chalk.red('No hooks configured.'));
        process.exit(1);
      }

      const idx = config.settings.events.hooks.findIndex(h => h.id === id);
      if (idx === -1) {
        console.error(chalk.red(`Hook not found: ${id}`));
        process.exit(1);
      }

      config.settings.events.hooks.splice(idx, 1);
      await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
      console.log(chalk.green(`✓ Removed hook: ${id}`));
      console.log(chalk.gray('Run `tweakcc --apply` to apply changes.'));
      process.exit(0);
    });

  hooksCmd
    .command('test <event>')
    .description('Test hooks for an event (simulates emission)')
    .option('-d, --data <json>', 'JSON data to pass with event')
    .action(async (event, opts) => {
      const config = await readConfigFile();
      const hooks = config.settings?.events?.hooks || [];

      const matchingHooks = hooks.filter(h => {
        const events = Array.isArray(h.events) ? h.events : [h.events];
        return h.enabled && events.includes(event);
      });

      if (matchingHooks.length === 0) {
        console.log(chalk.yellow(`No enabled hooks listening for: ${event}`));
        process.exit(0);
      }

      console.log(chalk.cyan(`\nTesting ${matchingHooks.length} hook(s) for event: ${event}\n`));

      const data = opts.data ? JSON.parse(opts.data) : {};
      const env = {
        ...process.env,
        TWEAKCC_EVENT: event,
        TWEAKCC_DATA: JSON.stringify({ event, timestamp: new Date().toISOString(), ...data })
      };

      for (const hook of matchingHooks) {
        console.log(chalk.gray(`Testing: ${hook.id} (${hook.type})`));

        if (hook.type === 'command' && hook.command) {
          const { execSync } = await import('child_process');
          try {
            const output = execSync(hook.command, { env, timeout: 5000, encoding: 'utf8' });
            console.log(chalk.green(`  ✓ Success`));
            if (output.trim()) console.log(chalk.gray(`  Output: ${output.trim()}`));
          } catch (e) {
            console.log(chalk.red(`  ✗ Failed: ${e instanceof Error ? e.message : String(e)}`));
          }
        } else {
          console.log(chalk.yellow(`  ⚠ Skipped (${hook.type} hooks need Claude Code running)`));
        }
      }
      process.exit(0);
    });

  hooksCmd
    .command('enable <id>')
    .description('Enable a hook')
    .action(async (id) => {
      const config = await readConfigFile();
      const hook = config.settings?.events?.hooks?.find(h => h.id === id);
      if (!hook) {
        console.error(chalk.red(`Hook not found: ${id}`));
        process.exit(1);
      }
      hook.enabled = true;
      await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
      console.log(chalk.green(`✓ Enabled hook: ${id}`));
      process.exit(0);
    });

  hooksCmd
    .command('disable <id>')
    .description('Disable a hook')
    .action(async (id) => {
      const config = await readConfigFile();
      const hook = config.settings?.events?.hooks?.find(h => h.id === id);
      if (!hook) {
        console.error(chalk.red(`Hook not found: ${id}`));
        process.exit(1);
      }
      hook.enabled = false;
      await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
      console.log(chalk.green(`✓ Disabled hook: ${id}`));
      process.exit(0);
    });

  program.parse();
  const options = program.opts();

  if (options.debug) {
    enableDebug();
  }

  // Handle --analyze flag for pattern debugging
  if (options.analyze || options.search) {
    console.log(chalk.cyan('Analyzing Claude Code installation...'));

    // Find Claude Code installation
    const startupCheckInfo = await startupCheck();

    if (!startupCheckInfo || !startupCheckInfo.ccInstInfo) {
      console.error(chalk.red('Cannot find Claude Code installation.'));
      console.error('Run tweakcc without --analyze to see search paths.');
      process.exit(1);
    }

    // Read cli.js content
    let cliContent: string;
    if (startupCheckInfo.ccInstInfo.nativeInstallationPath) {
      // For native installations, we need to extract the JS
      console.log(chalk.yellow('Note: Native installation detected. Analyzing extracted JS.'));
      // Try to read from the debug output location
      const debugPath = `${process.env.HOME}/.tweakcc/native-claudejs-patched.js`;
      try {
        cliContent = await fs.readFile(debugPath, 'utf8');
        console.log(chalk.gray(`Reading from: ${debugPath}`));
      } catch {
        console.error(chalk.red('Cannot read native installation JS.'));
        console.error('Run tweakcc --apply --debug first to extract the JS.');
        process.exit(1);
      }
    } else {
      const cliPath = startupCheckInfo.ccInstInfo.cliPath!;
      console.log(chalk.gray(`Reading from: ${cliPath}`));
      cliContent = await fs.readFile(cliPath, 'utf8');
    }

    // Custom search mode
    if (options.search) {
      console.log(chalk.cyan(`\nSearching for: ${options.search}\n`));
      const results = searchPattern(cliContent, options.search);
      printSearchResults(options.search, results);
      process.exit(0);
    }

    // Full analysis mode
    const report = analyzeCliJs(cliContent);
    printReport(report, options.verbose);
    process.exit(0);
  }

  // Handle --apply flag for non-interactive mode
  if (options.apply) {
    console.log('Applying saved customizations to Claude Code...');
    console.log(`Configuration saved at: ${CONFIG_FILE}`);

    // Read the saved configuration
    const config = await readConfigFile();

    if (!config.settings || Object.keys(config.settings).length === 0) {
      console.error('No saved customizations found in ' + CONFIG_FILE);
      process.exit(1);
    }

    // Find Claude Code installation
    const startupCheckInfo = await startupCheck();

    if (!startupCheckInfo || !startupCheckInfo.ccInstInfo) {
      const examplePath =
        process.platform == 'win32'
          ? 'C:\\absolute\\path\\to\\node_modules\\@anthropic-ai\\claude-code'
          : '/absolute/path/to/node_modules/@anthropic-ai/claude-code';

      await createExampleConfigIfMissing(examplePath);

      console.error(`Cannot find Claude Code's cli.js`);
      console.error('Searched for cli.js at the following locations:');
      CLIJS_SEARCH_PATH_INFO.forEach(info => {
        if (info.isGlob) {
          if (info.expandedPaths.length === 0) {
            console.error(`  - ${info.pattern} (no matches)`);
          } else {
            console.error(`  - ${info.pattern}`);
            info.expandedPaths.forEach(path => {
              console.error(`    - ${path}`);
            });
          }
        } else {
          console.error(`  - ${info.pattern}`);
        }
      });
      console.error(
        `\nAlso checked for 'claude' executable on PATH using '${process.platform === 'win32' ? 'where claude.exe' : 'which claude'}'.`
      );
      process.exit(1);
    }

    if (startupCheckInfo.ccInstInfo.nativeInstallationPath) {
      console.log(
        `Found Claude Code (native installation): ${startupCheckInfo.ccInstInfo.nativeInstallationPath}`
      );
    } else {
      console.log(
        `Found Claude Code at: ${startupCheckInfo.ccInstInfo.cliPath}`
      );
    }
    console.log(`Version: ${startupCheckInfo.ccInstInfo.version}`);

    // Preload strings file for system prompts
    console.log('Loading system prompts...');
    const result = await preloadStringsFile(
      startupCheckInfo.ccInstInfo.version
    );
    if (!result.success) {
      console.log(chalk.red('\n✖ Error downloading system prompts:'));
      console.log(chalk.red(`  ${result.errorMessage}`));
      console.log(
        chalk.yellow(
          '\n⚠ System prompts not available - skipping system prompt customizations'
        )
      );
    }

    // Apply the customizations
    console.log('Applying customizations...');
    await applyCustomization(config, startupCheckInfo.ccInstInfo);
    console.log('Customizations applied successfully!');
    process.exit(0);
  }

  const startupCheckInfo = await startupCheck();

  if (startupCheckInfo) {
    // Preload strings file for system prompts (for interactive mode)
    const result = await preloadStringsFile(
      startupCheckInfo.ccInstInfo.version
    );
    if (!result.success) {
      console.log(chalk.red('\n✖ Error downloading system prompts:'));
      console.log(chalk.red(`  ${result.errorMessage}`));
      console.log(
        chalk.yellow(
          '⚠ System prompts not available - system prompt customizations will be skipped\n'
        )
      );
    }

    render(<App startupCheckInfo={startupCheckInfo} />);
  } else {
    // Format the search paths to show glob patterns with their expansions
    const formatSearchPaths = () => {
      return CLIJS_SEARCH_PATH_INFO.map(info => {
        if (info.isGlob) {
          if (info.expandedPaths.length === 0) {
            return `- ${info.pattern} (no matches)`;
          } else {
            const result = [`- ${info.pattern}`];
            info.expandedPaths.forEach(path => {
              result.push(`  - ${path}`);
            });
            return result.join('\n');
          }
        } else {
          return `- ${info.pattern}`;
        }
      }).join('\n');
    };

    const examplePath =
      process.platform == 'win32'
        ? 'C:\\absolute\\path\\to\\node_modules\\@anthropic-ai\\claude-code'
        : '/absolute/path/to/node_modules/@anthropic-ai/claude-code';

    await createExampleConfigIfMissing(examplePath);

    console.error(`Cannot find Claude Code's cli.js -- do you have Claude Code installed?

Searched for cli.js at the following locations:
${formatSearchPaths()}

Also checked for 'claude' executable on PATH using '${process.platform === 'win32' ? 'where claude.exe' : 'which claude'}'.

If you have it installed but it's in a location not listed above, please open an issue at
https://github.com/piebald-ai/tweakcc/issues and tell us where you have it--we'll add that location
to our search list and release an update today!  And in the meantime, you can get tweakcc working
by manually specifying that location in ${CONFIG_FILE} with the "ccInstallationDir" property:

{
  "ccInstallationDir": "${examplePath}"
}

Notes:
- Don't include cli.js in the path.
- Don't specify the path to your Claude Code executable's directory.  It needs to be the path
  to the folder that contains **cli.js**.
- Please also open an issue so that we can add your path to the search list for all users!
`);
    process.exit(1);
  }
};

main();
