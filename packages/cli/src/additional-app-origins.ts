/**
 * The owner's DECLARED additional app origins
 * (`.gateforge.yml` `additionalAppOrigins`) resolved to the base URLs the
 * run's environment carries.
 *
 * The declaration holds environment VARIABLE NAMES, not addresses: a
 * consumer whose UI runs on a second browser app (a platform admin console
 * beside the tenant app) names the variable its harness already exports, so
 * the address never enters a candidate-controlled file — exactly the split
 * `GATEFORGE_APP_BASE_URL` already keeps between config and operator env.
 *
 * Resolution FAILS CLOSED. A declared name the environment does not set (or
 * sets to something that is not an absolute http(s) base URL) refuses the
 * run instead of being skipped: a skip would put the consumer back where it
 * started — a test that passes and earns nothing — behind a config that
 * reads perfectly correct. The run boundary is the only place a declared
 * origin can still be missing, so that is where the refusal belongs.
 */
import type { GateforgeConfig } from '@gate-forge/core';
import { UsageError } from './errors.js';

/**
 * The declared base URLs, in declaration order.
 *
 * Args:
 *   config: the loaded `.gateforge.yml` (its `additionalAppOrigins` list is
 *     the declaration; absent means none).
 *   env: the run's trusted operator environment (never the suite's).
 *
 * Returns:
 *   string[]: one absolute http(s) base URL per declared name. Empty for a
 *     repository that declares nothing — the single-origin path, byte for
 *     byte as before.
 *
 * Raises:
 *   UsageError: when a declared name is unset, blank, or does not hold an
 *     absolute http(s) base URL (fail closed, never a silent skip).
 */
export function resolveAdditionalAppOrigins(
  config: GateforgeConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const declared = config.additionalAppOrigins ?? [];
  const resolved: string[] = [];
  for (const name of declared) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      throw new UsageError(
        `additionalAppOrigins declares '${name}', but the run environment does not set it: ` +
          `export ${name}=<the second app's base URL>, or remove the declaration — a declared origin ` +
          'that cannot be resolved would run the suite against an unwitnessed app origin',
      );
    }
    const value = raw.trim();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new UsageError(
        `additionalAppOrigins declares '${name}', but it is not an absolute URL (got '${value}'): ` +
          'it must hold a base URL such as http://localhost:26303',
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UsageError(
        `additionalAppOrigins declares '${name}', but '${value}' is not an http(s) base URL: ` +
          'the observation proxy only fronts an HTTP app origin',
      );
    }
    resolved.push(value);
  }
  return resolved;
}