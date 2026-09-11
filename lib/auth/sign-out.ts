import { signOut } from "@/lib/auth-client";
import { disconnectStreamClients } from "@/providers/StreamProvider";

/**
 * Sign out from every live surface: tear down Stream video/chat sockets
 * first (they hold their own auth tokens and would otherwise linger as
 * zombie connections), then end the better-auth session and hard-navigate
 * to the sign-in page. Shared by every dashboard shell — previously each
 * layout inlined its own copy of this sequence.
 */
export async function signOutEverywhere(redirectTo = "/auth/signin") {
  try {
    await disconnectStreamClients();
  } catch {
    // Best-effort: a failed socket teardown must not block sign-out.
  }
  signOut({
    fetchOptions: {
      onSuccess: () => {
        window.location.href = redirectTo;
      },
      onError: () => {
        // Even if the server call fails, don't strand the user on an
        // authenticated-looking page with torn-down Stream sockets — the
        // sign-in page will re-establish or reject the session honestly.
        window.location.href = redirectTo;
      },
    },
  });
}
