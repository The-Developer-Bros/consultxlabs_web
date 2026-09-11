/**
 * Regression guard for the Arch-4 terminology purge: the feature flag
 * renamed from `ENABLE_PROVIDER_ORGS` to `ENABLE_HOST_ORGS`. If someone
 * reverts the rename by accident, the named export disappears and this
 * file fails to type-check.
 *
 * The env-var behaviour is tested dynamically via `jest.isolateModules`
 * because the constant reads `process.env` at module-load time; setting
 * the env then importing gives us a fresh binding for each assertion.
 */

describe("ENABLE_HOST_ORGS feature flag", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ENABLE_HOST_ORGS;
    delete process.env.ENABLE_PROVIDER_ORGS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("resolves to true when ENABLE_HOST_ORGS=true", () => {
    process.env.ENABLE_HOST_ORGS = "true";
    jest.isolateModules(() => {
      const mod = require("../../lib/feature-flags");
      expect(mod.ENABLE_HOST_ORGS).toBe(true);
    });
  });

  it("resolves to false when ENABLE_HOST_ORGS is unset", () => {
    jest.isolateModules(() => {
      const mod = require("../../lib/feature-flags");
      expect(mod.ENABLE_HOST_ORGS).toBe(false);
    });
  });

  it("does NOT honour the old ENABLE_PROVIDER_ORGS env var (no back-compat shim)", () => {
    // Pre-launch app, single-release rename. If ops forgets to flip the
    // env var the flag stays false — intentional fail-closed.
    process.env.ENABLE_PROVIDER_ORGS = "true";
    jest.isolateModules(() => {
      const mod = require("../../lib/feature-flags");
      expect(mod.ENABLE_HOST_ORGS).toBe(false);
    });
  });

  it("does not export the old ENABLE_PROVIDER_ORGS name", () => {
    jest.isolateModules(() => {
      const mod = require("../../lib/feature-flags");
      expect(mod.ENABLE_PROVIDER_ORGS).toBeUndefined();
    });
  });
});
