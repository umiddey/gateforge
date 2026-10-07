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

// A closed output reader (`| head`, a pager that quits, a CI log tailer
// that stops following) is not a Gateforge failure. Without a listener,
// Node raises the stream's 'error' event OUTSIDE main's error handling —
// an unhandled `write EPIPE` crash with exit 1 that can overwrite the
// command's own verdict (fresh-clone snag 5a: `tests discover` exited 0
// on the first run and 1 on identical re-runs, decided by how the output
// was captured, not by the repository). The error is swallowed here so
// the process always exits with the exit code the command itself
// returned; anything other than EPIPE still crashes loudly.
for (const output of [process.stdout, process.stderr]) {
  output.on('error', (error) => {
    if (error !== null && typeof error === 'object' && error.code === 'EPIPE') return;
    throw error;
  });
}

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
