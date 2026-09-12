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

/** Every identifier a Liquid output or control tag can name. */
const LIQUID_OUTPUT = /\{\{-?\s*([a-zA-Z_][\w.]*)/g;
const LIQUID_TAG = /\{%-?\s*([\s\S]*?)\s*-?%\}/g;
const LIQUID_KEYWORDS = new Set([
  "if",
  "elsif",
  "else",
  "endif",
  "unless",
  "endunless",
  "case",
  "when",
  "endcase",
  "and",
  "or",
  "contains",
  "true",
  "false",
  "nil",
  "null",
  "empty",
  "blank",
]);

/** Identifiers referenced anywhere in a template's Liquid. */
function liquidIdentifiers(text: string): string[] {
  const found: string[] = [];
  for (const [, v] of text.matchAll(LIQUID_OUTPUT)) found.push(v);
  for (const [, tag] of text.matchAll(LIQUID_TAG)) {
    const withoutStrings = tag.replace(/"[^"]*"|'[^']*'/g, " ");
    for (const [token] of withoutStrings.matchAll(/[a-zA-Z_][\w.]*/g)) {
      if (!LIQUID_KEYWORDS.has(token)) found.push(token);
    }
  }
  return found;
}
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

  it("references payload and subscriber fields only through their namespace, in output and control tags alike", () => {
    for (const t of NOVU_WORKFLOW_TEMPLATES) {
      const text = [t.inApp.subject, t.inApp.body].filter(Boolean).join("\n");
      for (const variable of liquidIdentifiers(text)) {
        expect({ id: t.workflowId, variable }).toMatchObject({
          variable: expect.stringMatching(/^(payload|subscriber)\./),
        });
      }
      // A redirect names a payload FIELD, never a Liquid expression.
      expect(t.inApp.redirect ?? "dashboardUrl").toMatch(/^[a-zA-Z]\w*$/);
    }
    // The check itself must catch the legacy shapes.
    expect(
      liquidIdentifiers("{% if status %}x{% endif %} {{- amount }}"),
    ).toEqual(["amount", "status"]);
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
    // Novu's IN_APP_REDIRECT_URL_REGEX admits `{{var}}…`, `http(s)://…` or
    // `/…` only — a `case` there is rejected on write and dropped on render.
    const urls = FAMILIES.map(
      (f) =>
        (
          toFamilyDto(f).steps[0] as {
            controlValues: { redirect?: { url: string } };
          }
        ).controlValues.redirect?.url,
    ).filter((u): u is string => u !== undefined);
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(["{{payload.href}}"]));
  });

  it("sends the family as the workflow, the event and its destination in the payload", () => {
    expect(
      toWire("support-ticket-activity", {
        ticketId: "t1",
        dashboardUrl: "/dashboard/admin/tickets",
      }),
    ).toEqual({
      workflowId: "support-ticket",
      payload: {
        ticketId: "t1",
        dashboardUrl: "/dashboard/admin/tickets",
        event: "support-ticket-activity",
        href: "/dashboard/admin/tickets",
      },
    });
    // The destination follows the event's own field, and is absent when the
    // payload has none (the redirect then renders empty and is dropped).
    expect(
      toWire("org-wallet-low", { topUpUrl: "/o/x/wallet" }).payload.href,
    ).toBe("/o/x/wallet");
    expect(
      toWire("moderation-warning", { reason: "r" }).payload,
    ).not.toHaveProperty("href");
    expect(() => toWire("no-such-event" as never, {})).toThrow(
      /no workflow family/,
    );
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
