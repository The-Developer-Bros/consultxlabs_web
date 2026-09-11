import { isBlockedRoleTransition } from "@/lib/enterprise/role-transitions";

describe("isBlockedRoleTransition", () => {
  it("blocks LEARNER -> EXPERT", () => {
    expect(isBlockedRoleTransition("LEARNER", "EXPERT")).toBe(true);
  });

  it("blocks EXPERT -> LEARNER", () => {
    expect(isBlockedRoleTransition("EXPERT", "LEARNER")).toBe(true);
  });

  it("allows same-role no-op", () => {
    expect(isBlockedRoleTransition("LEARNER", "LEARNER")).toBe(false);
    expect(isBlockedRoleTransition("EXPERT", "EXPERT")).toBe(false);
  });

  it("allows MAINTAINER <-> MANAGER", () => {
    expect(isBlockedRoleTransition("MAINTAINER", "MANAGER")).toBe(false);
    expect(isBlockedRoleTransition("MANAGER", "MAINTAINER")).toBe(false);
  });

  it("allows MANAGER -> LEARNER and MAINTAINER -> EXPERT", () => {
    // Non-LEARNER/EXPERT roles can downgrade into either consumer or
    // provider role without tripping the guard — that path still
    // requires OWNER authorization upstream, but the transition itself
    // is not blocked by policy.
    expect(isBlockedRoleTransition("MANAGER", "LEARNER")).toBe(false);
    expect(isBlockedRoleTransition("MAINTAINER", "EXPERT")).toBe(false);
  });

  it("allows OWNER transitions in either direction", () => {
    expect(isBlockedRoleTransition("OWNER", "MAINTAINER")).toBe(false);
    expect(isBlockedRoleTransition("MAINTAINER", "OWNER")).toBe(false);
  });
});
