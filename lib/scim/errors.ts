/**
 * SCIM 2.0 error envelope helper.
 *
 * Per RFC 7644 §3.12, errors must come back wrapped in the
 * `urn:ietf:params:scim:api:messages:2.0:Error` schema with a
 * `status` string and an optional `scimType` token. Most IdPs
 * (Okta, Azure AD, OneLogin) display `detail` directly to the
 * provisioning admin, so the wording should be human-friendly.
 */

import { NextResponse } from "next/server";

export interface ScimErrorBody {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"];
  status: string;
  /// Token enum from RFC 7644 §3.12 — `invalidFilter`, `invalidPath`,
  /// `invalidSyntax`, `invalidValue`, `mutability`, `noTarget`,
  /// `sensitive`, `tooMany`, `uniqueness`. Omit when no specific token
  /// applies.
  scimType?: string;
  detail: string;
}

export function scimError(
  status: number,
  detail: string,
  scimType?: string,
): NextResponse<ScimErrorBody> {
  const body: ScimErrorBody = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
  };
  if (scimType) body.scimType = scimType;
  return NextResponse.json(body, {
    status,
    headers: { "Content-Type": "application/scim+json" },
  });
}
