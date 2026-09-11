/**
 * Every sign-out path in the app imports `signOut` from `@/lib/auth-client`
 * (`grep -rn "signOut" app components lib providers` — nothing calls
 * `authClient.signOut` directly). That makes the wrapper the one place the
 * cached display identity has to be cleared, so this test pins it: without it,
 * a shared or public device keeps the previous user's name and avatar in
 * localStorage until someone else's session happens to resolve. #636
 */
jest.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    signIn: {},
    signUp: {},
    // Declared inside the factory: `jest.mock` is hoisted above the imports,
    // so a module-scope const would still be in its TDZ here.
    signOut: jest.fn(() => Promise.resolve({ data: null })),
    useSession: jest.fn(),
    getSession: jest.fn(),
    sendVerificationEmail: jest.fn(),
  }),
}));
jest.mock("better-auth/client/plugins", () => ({
  customSessionClient: () => ({}),
}));
jest.mock("@better-auth/sso/client", () => ({ ssoClient: () => ({}) }));

import { authClient, signOut } from "@/lib/auth-client";
import {
  readAuthedFlag,
  readAuthedIdentity,
  writeAuthedFlag,
} from "@/lib/auth-broadcast";

const mockSignOut = authClient.signOut as unknown as jest.Mock;

describe("signOut", () => {
  beforeEach(() => {
    localStorage.clear();
    mockSignOut.mockImplementation(() => Promise.resolve({ data: null }));
  });

  it("forgets the remembered identity and still delegates", () => {
    writeAuthedFlag(true, {
      name: "Zara Brown",
      image: "https://cdn.test/z.png",
    });

    const options = { fetchOptions: { onSuccess: jest.fn() } };
    void signOut(options);

    expect(readAuthedIdentity()).toBeNull();
    expect(readAuthedFlag()).toBe(false);
    expect(mockSignOut).toHaveBeenCalledWith(options);
  });

  it("clears before the request, so a failed sign-out still forgets", () => {
    writeAuthedFlag(true, { name: "Zara Brown", image: null });
    mockSignOut.mockImplementationOnce(() =>
      Promise.reject(new Error("network")),
    );

    void signOut().catch(() => {});

    expect(readAuthedIdentity()).toBeNull();
  });
});
