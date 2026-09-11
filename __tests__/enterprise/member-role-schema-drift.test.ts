/**
 * @jest-environment node
 */

/**
 * #817 — pins the canonical role Zod enums in org-labels to their contracts.
 * The invitations and members routes used to carry LOCAL duplicates of these
 * enums, and both drifted (BILLING_ADMIN went missing), making the
 * finance-operator role unassignable through invite OR direct add. The routes
 * now import the canonical schemas, and this suite stops the canon itself
 * from drifting against the Prisma enum.
 */

import { MemberRole } from "@prisma/client";

import {
  MemberRoleSchema,
  SelfServiceMemberRoleSchema,
  HostInvitableMemberRoleSchema,
} from "@/lib/labels/org-labels";

describe("member-role schema drift (#817)", () => {
  it("MemberRoleSchema mirrors the Prisma enum exactly", () => {
    const zod = [...MemberRoleSchema.options].sort();
    const prisma = Object.values(MemberRole).sort();
    expect(zod).toEqual(prisma);
  });

  it("self-service set includes BILLING_ADMIN and excludes the marketplace + operator-only roles", () => {
    expect(SelfServiceMemberRoleSchema.options).toContain("BILLING_ADMIN");
    expect(SelfServiceMemberRoleSchema.options).not.toContain("EXPERT");
    expect(SelfServiceMemberRoleSchema.options).not.toContain("SUPPORT");
  });

  it("host-invitable set is exactly self-service + EXPERT (SUPPORT stays owner-console-only)", () => {
    const host = [...HostInvitableMemberRoleSchema.options].sort();
    const expected = [...SelfServiceMemberRoleSchema.options, "EXPERT"].sort();
    expect(host).toEqual(expected);
  });
});
