/**
 * Pins the manifest against the ways the live templates went wrong: an event
 * the app triggers with no template behind it (48 of them, silently
 * `workflow_not_found`), a body naming a payload field without its namespace
 * (`{{status}}` rendered empty in every legacy template), and a family count
 * above the plan's 20-workflow cap.
 */

// humanize.ts reaches prisma for recipient timezones; nothing here does.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import {
  EVENT_FAMILY,
  FAMILIES,
  NOVU_WORKFLOW_TEMPLATES,
  familyOf,
  templatesInFamily,
  toFamilyDto,
  toWire,
} from "@/lib/novu/templates";
import { inAppSkipRule } from "@/lib/novu/templates/conditions";
import { supportTicketStatusLabel } from "@/lib/novu/humanize";

const LIQUID_VARIABLE = /\{\{\s*([a-zA-Z_][\w.]*)/g;
const NOVU_WORKFLOW_CAP = 20;

describe("Novu workflow templates", () => {
  const ids = Object.values(NOVU_WORKFLOWS);

  it("covers every event the app can trigger, exactly once, in exactly one family", () => {
    expect(NOVU_WORKFLOW_TEMPLATES.map((t) => t.workflowId).sort()).toEqual(
      [...ids].sort(),
    );
    expect(Object.keys(EVENT_FAMILY).sort()).toEqual([...ids].sort());
  });

  it("fits the plan's workflow cap with room to spare", () => {
    expect(FAMILIES.length).toBeLessThanOrEqual(NOVU_WORKFLOW_CAP - 3);
    for (const f of FAMILIES) {
      expect(templatesInFamily(f.id).length).toBeGreaterThan(0);
    }
  });

  it("keeps every event on its family's opt-out switch", () => {
    for (const t of NOVU_WORKFLOW_TEMPLATES) {
      const family = FAMILIES.find((f) => f.id === familyOf(t.workflowId))!;
      expect({ event: t.workflowId, category: t.category }).toEqual({
        event: t.workflowId,
        category: family.category,
      });
    }
  });

  it("references payload and subscriber fields only through their namespace", () => {
    for (const t of NOVU_WORKFLOW_TEMPLATES) {
      const text = [t.inApp.subject, t.inApp.body, t.inApp.redirectUrl]
        .filter(Boolean)
        .join("\n");
      for (const [, variable] of text.matchAll(LIQUID_VARIABLE)) {
        expect({ id: t.workflowId, variable }).toMatchObject({
          variable: expect.stringMatching(/^(payload|subscriber)\./),
        });
      }
    }
  });

  it("composes a family as one case over payload.event, one branch per member", () => {
    const family = FAMILIES.find((f) => f.id === "support-ticket")!;
    const dto = toFamilyDto(family);
    const step = dto.steps[0] as {
      controlValues: { body: string; redirect: { url: string } };
    };
    for (const t of templatesInFamily("support-ticket")) {
      expect(step.controlValues.body).toContain(`{% when "${t.workflowId}" %}`);
    }
    expect(step.controlValues.body.startsWith("{% case payload.event %}")).toBe(
      true,
    );
    expect(step.controlValues.redirect.url).toContain(
      "{{payload.dashboardUrl}}",
    );
  });

  it("sends the family as the workflow and the event in the payload", () => {
    expect(toWire("support-ticket-activity", { ticketId: "t1" })).toEqual({
      workflowId: "support-ticket",
      payload: { ticketId: "t1", event: "support-ticket-activity" },
    });
    expect(() => toWire("no-such-event", {})).toThrow(/no workflow family/);
  });

  it("gates the bell on 'not explicitly false', never 'is true'", () => {
    expect(inAppSkipRule("support")).toEqual({
      and: [
        { "!=": [{ var: "subscriber.data.routingBell" }, false] },
        { "!=": [{ var: "subscriber.data.categorySupport" }, false] },
      ],
    });
    expect(inAppSkipRule(null).and).toHaveLength(1);
  });

  it("humanises a ticket status for the owner's bell", () => {
    expect(supportTicketStatusLabel("IN_PROGRESS")).toBe("in progress");
    expect(supportTicketStatusLabel("ON_HOLD")).toBe("on hold");
  });
});
