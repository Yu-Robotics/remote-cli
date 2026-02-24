/**
 * Tests for RouterServer GET /api/version endpoint
 */
import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, MIN_SUPPORTED_CLI_VERSION, ROUTER_VERSION } from '../src/types/index';

// ---------------------------------------------------------------------------
// Unit tests for the version constants that drive the endpoint response.
// We test the contract (shape + values) without spinning up a real HTTP server,
// consistent with the pattern used in RouterServer.redacted.test.ts.
// ---------------------------------------------------------------------------

describe('ROUTER_VERSION constant', () => {
  it('should be a valid semver string', () => {
    expect(typeof ROUTER_VERSION).toBe('string');
    expect(ROUTER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should be non-empty', () => {
    expect(ROUTER_VERSION.length).toBeGreaterThan(0);
  });
});

describe('/api/version response shape', () => {
  // Simulate the response object the route handler would produce
  function buildVersionResponse() {
    return {
      success: true,
      version: ROUTER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      minSupportedCliVersion: MIN_SUPPORTED_CLI_VERSION,
    };
  }

  it('should include required fields', () => {
    const body = buildVersionResponse();
    expect(body).toHaveProperty('success', true);
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('protocolVersion');
    expect(body).toHaveProperty('minSupportedCliVersion');
  });

  it('version field should match ROUTER_VERSION constant', () => {
    const body = buildVersionResponse();
    expect(body.version).toBe(ROUTER_VERSION);
  });

  it('protocolVersion should be a positive integer', () => {
    const body = buildVersionResponse();
    expect(typeof body.protocolVersion).toBe('number');
    expect(body.protocolVersion).toBeGreaterThan(0);
    expect(Number.isInteger(body.protocolVersion)).toBe(true);
  });

  it('minSupportedCliVersion should be <= protocolVersion', () => {
    const body = buildVersionResponse();
    expect(body.minSupportedCliVersion).toBeLessThanOrEqual(body.protocolVersion);
  });
});
