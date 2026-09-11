/**
 * Shared keyset-paginated CSV export stream (#1230 wave-4b).
 *
 * Both statutory exporters (payouts, invoices) walk a table newest-first in
 * fixed-size chunks using (createdAt, id) keyset pagination and emit
 * RFC-4180-safe output. This module owns that machinery once so Sonar's
 * new-code duplication gate stays green and every future export inherits:
 *
 *   - pull-based backpressure (pages enqueue only when the client drains)
 *   - request-abort awareness (findMany chain stops on _req.signal)
 *   - bounded iterations with an explicit TRUNCATED marker row
 *   - generic in-band error notices; real errors logged server-side
 *   - RFC 4180 escaping and full-width single-cell notice rows
 */

export function escapeCsvField(v: string | number | null | undefined): string {
  if (v === "" || v === null || v === undefined) return "";
  // CR #1243 r3 — neutralize spreadsheet formula triggers BEFORE quoting:
  // invoiceNumber carries an org-supplied prefix, so a crafted "=cmd" value
  // would execute in Excel/LibreOffice on open.
  // #1354 — a bare negative number is not a formula in any spreadsheet, and
  // quoting it corrupts a numeric column (the TDS return's reversal rows carry
  // negative paise and must import as `-500`, not `'-500`).
  const raw = String(v);
  const isPlainNumber = /^-?\d+(\.\d+)?$/.test(raw);
  const guarded = !isPlainNumber && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  const s = String(guarded);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export interface KeysetCsvOptions<TRow> {
  /** Column count — notice rows pad to this width for strict parsers. */
  columnCount: number;
  header: string;
  /** AbortSignal from the request; checked before every page fetch. */
  signal: AbortSignal;
  /**
   * Fetch up to `take` rows older than `cursor`. Return `{ rows,
   * nextCursor }`; set `nextCursor: null` when fewer than `take` rows came
   * back (table exhausted) — the stream emits that final page THEN closes.
   */
  fetchPage: (
    cursor: { createdAt: Date; id: string } | null,
    take: number,
  ) => Promise<{
    rows: TRow[];
    nextCursor: { createdAt: Date; id: string } | null;
  }>;
  /** Convert one row to ordered CSV cells (pre-escaping). */
  rowToCells: (row: TRow) => Array<string | number | null | undefined>;
  /** Server-side sink for mid-stream failures (client only sees a notice). */
  onError?: (err: unknown, context: { iterations: number }) => void;
  chunkSize?: number;
  /** Iteration ceiling; default 400 × chunkSize = 200k rows. */
  maxIterations?: number;
}

export function keysetCsvStream<TRow>(
  opts: KeysetCsvOptions<TRow>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunkSize = opts.chunkSize ?? 500;
  const maxIterations = opts.maxIterations ?? 400;

  const noticeRow = (message: string): Uint8Array =>
    encoder.encode(
      [
        escapeCsvField(message),
        ...new Array(Math.max(0, opts.columnCount - 1)).fill(""),
      ].join(",") + "\n",
    );

  let cursor: { createdAt: Date; id: string } | null = null;
  let iterations = 0;
  let headerSent = false;
  let truncated = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(encoder.encode(opts.header));
      }
      // Abort or ceiling: close. An honest marker only when the last page
      // was FULL (rows likely remain); an exactly-exhausted table closes
      // silently so complete exports never carry a false TRUNCATED row.
      if (opts.signal.aborted || iterations >= maxIterations) {
        if (truncated) {
          controller.enqueue(
            noticeRow(
              "TRUNCATED: row limit reached — re-export with a narrower period via the API.",
            ),
          );
        }
        controller.close();
        return;
      }
      iterations += 1;

      try {
        // CR #1243 r3 — rows are emitted BEFORE the exhaustion check so a
        // doc-compliant caller returning nextCursor:null never loses its
        // final page. take flows in so truncation detection cannot drift
        // from a route-side hardcode.
        const page = await opts.fetchPage(cursor, chunkSize);
        if (page.rows.length === 0) {
          controller.close();
          return;
        }
        const lines = page.rows.map((r) =>
          opts.rowToCells(r).map(escapeCsvField).join(","),
        );
        controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
        cursor = page.nextCursor;
        if (cursor === null || iterations >= maxIterations) {
          if (page.rows.length === chunkSize && cursor !== null) {
            truncated = true;
          }
          controller.close();
          return;
        }
      } catch (err) {
        opts.onError?.(err, { iterations });
        controller.enqueue(
          noticeRow(
            "EXPORT ERROR: export failed mid-stream — contact support.",
          ),
        );
        controller.close();
      }
    },
  });
}

/** Convenience for callers building Prisma where-clauses from the cursor. */
export function keysetWhere<Base>(
  base: Base,
  cursor: { createdAt: Date; id: string } | null,
) {
  if (!cursor) return base;
  return {
    AND: [
      base,
      {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      },
    ],
  };
}
