/**
 * The billing roll-up's query key, shared by the two server shells that
 * SSR-prefetch it (home, billing) and by the client hook that reads it back.
 *
 * It lives OUTSIDE useWorkspaceBilling.ts on purpose. That module is "use
 * client", which makes every one of its exports a client reference — a server
 * component importing this function from there got a proxy and crashed the page
 * with "Attempted to call workspaceBillingQueryKey() from the server but
 * workspaceBillingQueryKey is on the client". No directive here, so both
 * environments can call it.
 */
export function workspaceBillingQueryKey(orgWorkspaceId: string) {
  return ["org-workspace-billing", orgWorkspaceId] as const;
}
