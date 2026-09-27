import { describe, expect, it } from 'vitest';
import {
  installedPlaywrightCompatibilityError,
  packageCompatibilityError,
  SUPERVISED_FIXTURE_PROTOCOL,
} from '../src/package-compatibility.js';

describe('supervised fixture package contract', () => {
  it('rejects equal version text when the protocol contract differs', () => {
    const result = packageCompatibilityError(
      { name: '@gate-forge/cli', version: '0.7.0', supervisedFixtureProtocol: SUPERVISED_FIXTURE_PROTOCOL },
      { name: '@gate-forge/pack-playwright', version: '0.7.0', supervisedFixtureProtocol: 'legacy-v0' },
    );
    expect(result).toContain('GATEFORGE_PACKAGE_INCOMPATIBLE');
    expect(result).toContain('@gate-forge/cli 0.7.0');
    expect(result).toContain('@gate-forge/pack-playwright 0.7.0');
    expect(result).toContain('Install matching Gateforge packages');
  });

  it('accepts different version text when the declared protocol contract matches', () => {
    expect(
      packageCompatibilityError(
        { name: '@gate-forge/cli', version: '0.7.0', supervisedFixtureProtocol: SUPERVISED_FIXTURE_PROTOCOL },
        { name: '@gate-forge/pack-playwright', version: '0.9.0', supervisedFixtureProtocol: SUPERVISED_FIXTURE_PROTOCOL },
      ),
    ).toBeNull();
  });

  it('checks the physical manifests resolved from the installed package paths', () => {
    expect(installedPlaywrightCompatibilityError()).toBeNull();
  });
});
