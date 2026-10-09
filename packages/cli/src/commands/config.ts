/**
 * `gateforge config get|set|list` — reads and writes settings in
 * `.gateforge.yml` by dotted key (owner decision 2026-10-06: settings are
 * changeable through presets, the file, and this command).
 *
 * `get` and `list` report the EFFECTIVE value (schema defaults included).
 * `set` writes only text that the pinned schema accepts: the whole edited
 * file is parsed again, the key must be a known schema key, and the file is
 * left untouched on any refusal.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { parseConfig, type GateforgeConfig } from '@gate-forge/core';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';

const CONFIG_FILE = '.gateforge.yml';

const USAGE = 'usage: gateforge config get <key> | set <key> <value> | list';

function readConfigText(io: Io): string {
  const path = join(io.cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new UsageError(`${CONFIG_FILE} not found; run gateforge init first`);
  }
  return readFileSync(path, 'utf8');
}

function effectiveConfig(text: string): GateforgeConfig {
  return parseConfig(parseYaml(text) ?? {}, { file: CONFIG_FILE });
}

/** Walks a dotted key through the effective config; undefined when absent. */
function valueAt(config: unknown, keyPath: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of keyPath) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    const entry = Object.entries(current).find(([name]) => name === segment);
    if (entry === undefined) return undefined;
    current = entry[1];
  }
  return current;
}

function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Every leaf of the effective config as `[dotted key, value]`, in schema order. */
function leafEntries(value: unknown, prefix: string, out: Array<[string, unknown]>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, child] of Object.entries(value)) {
      leafEntries(child, prefix === '' ? name : `${prefix}.${name}`, out);
    }
    return;
  }
  out.push([prefix, value]);
}

function keyPathOf(key: string): string[] {
  const segments = key.split('.');
  if (key === '' || segments.some((segment) => segment === '')) {
    throw new UsageError(`invalid config key '${key}'; use dotted names such as http.responseShape`);
  }
  return segments;
}

export function configCommand(io: Io, args: readonly string[]): number {
  const [subcommand, ...rest] = args;
  if (subcommand === 'list' && rest.length === 0) {
    const entries: Array<[string, unknown]> = [];
    leafEntries(effectiveConfig(readConfigText(io)), '', entries);
    for (const [key, value] of entries) writeLine(io.stdout, `${key} = ${renderValue(value)}`);
    return 0;
  }
  if (subcommand === 'get' && rest.length === 1) {
    const [key = ''] = rest;
    const keyPath = keyPathOf(key);
    const value = valueAt(effectiveConfig(readConfigText(io)), keyPath);
    if (value === undefined) throw new UsageError(`unknown config key '${key}'`);
    writeLine(io.stdout, renderValue(value));
    return 0;
  }
  if (subcommand === 'set' && rest.length === 2) {
    const [key = '', valueText = ''] = rest;
    const keyPath = keyPathOf(key);
    const path = join(io.cwd, CONFIG_FILE);
    const before = readConfigText(io);
    const value: unknown = parseYaml(valueText);
    const doc = parseDocument(before);
    doc.setIn(keyPath, value);
    const after = doc.toString();
    let accepted: GateforgeConfig;
    try {
      accepted = effectiveConfig(after);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new UsageError(`refusing to set '${key}' to ${renderValue(value)}: ${reason}`);
    }
    if (valueAt(accepted, keyPath) === undefined) {
      throw new UsageError(`unknown config key '${key}'; the schema has no such setting`);
    }
    writeFileSync(path, after);
    writeLine(io.stdout, `${key} = ${renderValue(valueAt(accepted, keyPath))}`);
    return 0;
  }
  throw new UsageError(USAGE);
}
