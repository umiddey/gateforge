export interface ParsedArgs {
    /** Map of flag name (without `--`) to value (true for bare flags). */
    options: Record<string, string | boolean | string[]>;
    /** Positional arguments after flag parsing. */
    positionals: string[];
}
/**
 * Parses argv (without node/script) into options + positionals.
 *
 * Args:
 *   argv: argument vector from the command line.
 *
 * Returns:
 *   ParsedArgs: option map + positionals.
 * @throws UsageError on an unknown flag shape or a missing flag value.
 */
export declare function parseArgs(argv: readonly string[]): ParsedArgs;
/**
 * Reads a string flag value; repeated occurrences are an error (callers
 * that accept repeats read the array form themselves).
 *
 * Args:
 *   options: parsed options.
 *   name: flag name.
 *
 * Returns:
 *   string | undefined: the value, or undefined when the flag is absent.
 * @throws UsageError when the flag was repeated.
 */
export declare function stringFlag(options: Record<string, unknown>, name: string): string | undefined;
//# sourceMappingURL=args.d.ts.map