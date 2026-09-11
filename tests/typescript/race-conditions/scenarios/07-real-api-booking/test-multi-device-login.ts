/**
 * Test: Same User Logging In From Multiple Devices Concurrently
 * Category: 07 - Real API booking races (#837 scenario 12)
 *
 * Five concurrent credential sign-ins for one user (phone + laptop + tabs).
 * Every login must succeed with its own independent session; sessions must
 * not clobber each other (each cookie resolves to the same user).
 */
import "dotenv/config";
import {
  apiFetch,
  check,
  finish,
  fireConcurrent,
  loginAs,
  ensureServerOrSkip,
} from "../../utilities/api-client";

async function run() {
  await ensureServerOrSkip();

  const email = process.env.CHAOS_USER_EMAIL ?? "daniel.anderson@outlook.com";

  const sessions = await fireConcurrent(5, async () => {
    const s = await loginAs(email);
    return { status: 200, body: s } as const;
  }).catch((e) => {
    check("five concurrent logins all succeed", false, String(e));
    return [];
  });

  if (sessions.length === 5) {
    check("five concurrent logins all succeed", true);

    const cookies = new Set(
      sessions.map((s) => (s.body as { cookie: string }).cookie),
    );
    check("each device gets its own session token", cookies.size === 5, {
      distinct: cookies.size,
    });

    // Every session independently resolves to the same user.
    const lookups = await Promise.all(
      sessions.map((s) =>
        apiFetch("/api/auth/get-session", {
          method: "GET",
          session: s.body as { cookie: string; email: string },
        }),
      ),
    );
    const allValid = lookups.every(
      (r) =>
        r.status === 200 &&
        (r.body as { user?: { email?: string } })?.user?.email === email,
    );
    check("all five sessions are concurrently valid", allValid, {
      statuses: lookups.map((l) => l.status),
    });
  }

  finish("multi-device-login");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
