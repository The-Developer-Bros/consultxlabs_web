/**
 * Egress guard for customer-supplied outbound-webhook URLs (#1132).
 *
 * The endpoint URL is attacker-chosen by design — an org admin registers it.
 * Without a guard, `https://their-host/redir` → `http://169.254.169.254/…`
 * turns our delivery worker into a proxy for the platform's own metadata and
 * internal services. Two layers close it:
 *
 *   1. `assertPublicUrl` at registration AND again immediately before each
 *      delivery, so a hostname that later re-resolves to a private address
 *      (DNS rebinding) is caught on the next attempt rather than trusted from
 *      registration time.
 *   2. `redirect: "manual"` at the fetch call site, so a public host cannot
 *      bounce us to a private one after the check has passed.
 *
 * Fails closed: anything we cannot resolve or cannot classify is rejected.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`Webhook URL rejected: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

/** Hostnames that must never be reachable regardless of what DNS says. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

// CIDRs that must never be dialled. Covers loopback, RFC1918, CGNAT, link-local
// (which is where cloud metadata lives), benchmarking, TEST-NET, multicast and
// reserved space.
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedV4(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  if (addr === null) return true; // unparseable → fail closed
  for (const [base, bits] of BLOCKED_V4) {
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) === (baseInt & mask)) return true;
  }
  return false;
}

/**
 * Expand an IPv6 address to its 16 bytes. Returns null if it does not parse.
 *
 * #1132 — string-prefix matching was not enough: `::ffff:7f00:1` and `::7f00:1`
 * are loopback written in hex, and neither matches a dotted-quad regex nor a
 * `fe8`/`fc` prefix. Classifying on the bytes catches every spelling of the
 * same address.
 */
function ipv6ToBytes(ip: string): Uint8Array | null {
  const v = ip.toLowerCase().split("%")[0]; // strip zone index
  if (v.length === 0) return null;

  // A trailing dotted-quad (::ffff:127.0.0.1) contributes the last 4 bytes.
  let tail: number[] = [];
  let head = v;
  const dotted = v.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const quad = dotted[1].split(".").map(Number);
    if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tail = quad;
    head = v.slice(0, v.length - dotted[1].length);
    if (head.endsWith(":")) head = head.slice(0, -1);
  }

  const [left, right, ...rest] = head.split("::");
  if (rest.length > 0) return null; // more than one "::" is invalid

  const toWords = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const lw = toWords(left);
  if (lw === null) return null;
  const rw = right === undefined ? null : toWords(right);
  if (right !== undefined && rw === null) return null;

  const bytesFromWords = (w: number[]) => w.flatMap((n) => [n >> 8, n & 0xff]);
  const leftBytes = bytesFromWords(lw);
  const rightBytes = [...bytesFromWords(rw ?? []), ...tail];

  let bytes: number[];
  if (right === undefined) {
    bytes = [...leftBytes, ...tail];
    if (bytes.length !== 16) return null;
  } else {
    const fill = 16 - leftBytes.length - rightBytes.length;
    if (fill < 0) return null;
    bytes = [...leftBytes, ...new Array(fill).fill(0), ...rightBytes];
    if (bytes.length !== 16) return null;
  }
  return Uint8Array.from(bytes);
}

function isBlockedV6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (b === null) return true; // unparseable → fail closed

  const allZeroUpTo = (n: number) => b.slice(0, n).every((x) => x === 0);

  // ::  (unspecified) and ::1 (loopback)
  if (allZeroUpTo(15) && (b[15] === 0 || b[15] === 1)) return true;

  // ::ffff:a.b.c.d — IPv4-mapped. Classify the embedded v4 address.
  if (allZeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  // 64:ff9b::/96 — NAT64, likewise wraps a v4 address.
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  ) {
    return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  // Any other address inside ::/96 embeds a v4 address in its low word
  // (e.g. ::7f00:1 is 127.0.0.1) — treat it the same way.
  if (allZeroUpTo(12) && !(b[12] === 0 && b[13] === 0)) {
    return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }

  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4
  return false;
}

function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true; // not an IP we understand → fail closed
}

/**
 * Rejects a webhook URL that is not plainly a public https endpoint.
 * Throws `SsrfBlockedError` with a customer-safe reason; never returns false.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("not a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new SsrfBlockedError("must use https://");
  }
  if (url.port && url.port !== "443") {
    throw new SsrfBlockedError("only port 443 is allowed");
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError("credentials in the URL are not allowed");
  }

  // #1132 — `url.hostname` KEEPS the brackets on an IPv6 literal ("[::1]"),
  // so `isIP` returned 0 and the address fell through to a DNS lookup that
  // could never succeed. That happened to reject loopback, but for the wrong
  // reason, and it made every legitimate IPv6-only endpoint unusable. Strip
  // the brackets so literals are classified as addresses.
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  ) {
    throw new SsrfBlockedError("host is not publicly routable");
  }

  // A literal IP skips DNS entirely — classify it directly.
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new SsrfBlockedError("host is not publicly routable");
    }
    return;
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError("host could not be resolved");
  }
  if (resolved.length === 0) {
    throw new SsrfBlockedError("host could not be resolved");
  }
  // EVERY answer must be public: a host that returns one public and one private
  // address would otherwise be dialled on the private one at connect time.
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError("host resolves to a non-public address");
    }
  }
}

/**
 * Shared guard→400 mapping for the webhook CRUD routes (#1132 review).
 *
 * Both the create and the update route need identical handling, and a future
 * mutation route is easy to add without it. Returns a 400 `NextResponse` when
 * the URL is refused, or `null` when it is safe to proceed. Non-SSRF errors
 * (a genuine DNS/runtime fault) are rethrown rather than reported as the
 * customer's mistake.
 */
export async function rejectIfNotPublicUrl(
  url: string,
): Promise<Response | null> {
  try {
    await assertPublicUrl(url);
    return null;
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
