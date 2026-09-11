/**
 * @jest-environment node
 */

/**
 * The GET and the POST must agree on which intents exist.
 *
 * They did not. The turn route transcribed the category list by hand and lost
 * DOCUMENTS, while `documentsFlow` carries no `available` gate — so the GET
 * offered "Session materials" on every appointment and every press came back
 * VALIDATION_FAILED. Nothing rendered: the chip was dead on arrival and the
 * only signal was a toast.
 *
 * This asserts the invariant rather than the one symptom, so the next flow
 * added with a fresh category cannot reintroduce it.
 */

import { SupportThreadCategory } from "@prisma/client";
import { ALL_FLOWS } from "@/lib/support/flows";
import { ALL_PLATFORM_FLOWS } from "@/lib/support/platform-flows";
import {
  SupportThreadCategoryEnum,
  SupportThreadStatusEnum,
} from "@/schemas/enums";

describe("intent offer/accept parity", () => {
  it("accepts every category the appointment flow registry can offer", () => {
    expect(ALL_FLOWS.length).toBeGreaterThan(0);
    for (const flow of ALL_FLOWS) {
      expect(SupportThreadCategoryEnum.safeParse(flow.category).success).toBe(
        true,
      );
    }
  });

  it("covers the whole Prisma enum, so no member can be silently unreachable", () => {
    for (const member of Object.values(SupportThreadCategory)) {
      expect(SupportThreadCategoryEnum.safeParse(member).success).toBe(true);
    }
  });

  it("rejects a category that is not a real thread category", () => {
    // The schema must still be a gate, not a pass-through.
    expect(SupportThreadCategoryEnum.safeParse("NOT_A_CATEGORY").success).toBe(
      false,
    );
    expect(SupportThreadStatusEnum.safeParse("ESCALATED").success).toBe(true);
    expect(SupportThreadStatusEnum.safeParse("ON_HOLD").success).toBe(false);
  });

  it("gives every appointment flow a distinct entry node and a title to echo", () => {
    // The title is persisted as the user's first message, so a blank one would
    // put an empty bubble in the transcript a staff member reads.
    for (const flow of ALL_FLOWS) {
      expect(flow.title.trim().length).toBeGreaterThan(0);
      expect(flow.nodes[flow.entryNodeId]).toBeDefined();
    }
  });

  it("gives every platform flow a resolvable entry node", () => {
    for (const flow of ALL_PLATFORM_FLOWS) {
      expect(flow.nodes[flow.entryNodeId]).toBeDefined();
    }
  });
});
