/**
 * RSC boundary serializer.
 *
 * Rows from models with #780/#781 result extensions (every money model)
 * are Proxy-backed and carry Prisma's Symbol(nodejs.util.inspect.custom);
 * object spread copies the enumerable symbol, and React's serializer then
 * rejects the row ("Only plain objects can be passed to Client
 * Components"). structuredClone cannot help — Proxies are not cloneable —
 * so this walks own enumerable string-keyed props into genuinely plain
 * objects, preserving Dates as Dates. Every lib/data return that can reach
 * a client component passes through here.
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(toPlain) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = toPlain((value as Record<string, unknown>)[key]);
  }
  return out as T;
}
