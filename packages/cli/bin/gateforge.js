#!/usr/bin/env node
/**
 * gateforge CLI entry point.
 *
 * Thin ESM wrapper over the compiled `dist/cli.js` `main`. Everything the
 * subcommands need (config, plugins, changed-file providers, reports) is
 * implemented in the TypeScript sources; this file only wires argv to it
 * and maps the returned exit code onto the process.
 */
import { main } from '../dist/cli.js';

main(process.argv.slice(2)) //
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // main catches and prints expected failures; anything escaping here
    // is an internal error and must never look like a clean run.
    process.stderr.write(`gateforge: internal error: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });