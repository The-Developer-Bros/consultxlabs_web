/** @jsxImportSource @/lib/pdf/react-runtime */
/**
 * The shared page furniture for the consumer (B2C) statutory documents.
 *
 * A tax invoice and the credit note that reverses it are the same document
 * with different words: identical supplier block, identical recipient block,
 * a number and a date, a table of what was supplied, a tax breakdown that
 * totals, and a footer. Rendering those twice meant two places to keep Rule 46
 * and Rule 53 satisfied, and two places to get the buyer's Devanagari name
 * wrong. `StatutoryDocumentFrame` is that furniture once; each document
 * supplies its own words and its own numbers.
 *
 * The ORG documents (`OrgInvoiceDocument`, `OrgCreditNoteDocument`) are
 * deliberately NOT built on this. They carry an IRN block, a status badge, a
 * dunning due date and a billing cycle that have no consumer counterpart, and
 * their layout is what B2B customers' finance teams already receive.
 */

import fs from "node:fs";
import path from "node:path";
import { View, Text, StyleSheet, Font } from "@react-pdf/renderer";
import type { Currency } from "@prisma/client";

// ============================================================================
// Devanagari font registration (#1365)
// ============================================================================

/**
 * Helvetica, the only face the org documents use, has no Devanagari coverage:
 * a buyer whose name or address is written in Hindi or Marathi renders as
 * blank boxes on their own tax invoice. Noto Sans Devanagari is registered
 * here once, at module scope, from a copy that ships inside the deployment
 * bundle (`public/fonts/`, traced in next.config.mjs) — never fetched over the
 * network at render time, because a download the buyer is owed must not depend
 * on an outbound request from a serverless function.
 *
 * Registration is guarded rather than assumed: if the traced copy is missing
 * for any reason we fall back to Helvetica and still produce a document.
 * A Latin-script invoice looks identical either way; a Devanagari one degrades
 * to boxes instead of 500-ing.
 */
const DEVANAGARI_FONT_DIR = path.join(process.cwd(), "public", "fonts");
const DEVANAGARI_FILES = [
  { file: "NotoSansDevanagari-Regular.ttf", fontWeight: 400 as const },
  { file: "NotoSansDevanagari-Bold.ttf", fontWeight: 700 as const },
];

function registerDevanagari(): boolean {
  try {
    const fonts = DEVANAGARI_FILES.map(({ file, fontWeight }) => ({
      src: path.join(DEVANAGARI_FONT_DIR, file),
      fontWeight,
    }));
    // `Font.register` defers the read to render time, so existence is checked
    // here — otherwise a missing file surfaces as a failed download, not a
    // fallback.
    if (!fonts.every((f) => fs.existsSync(f.src))) return false;
    Font.register({ family: "NotoSansDevanagari", fonts });
    return true;
  } catch {
    return false;
  }
}

const devanagariReady = registerDevanagari();

/** The face used for buyer-supplied names and addresses on the CONSUMER
 *  documents only. The org stylesheet is deliberately untouched. */
export const BODY_FONT = devanagariReady ? "NotoSansDevanagari" : "Helvetica";

// ============================================================================
// Formatting
// ============================================================================

/** #1365 — S3358: named per-currency lookup instead of a nested ternary. */
const STATUTORY_MONEY_LOCALES: Record<Currency, string> = {
  INR: "en-IN",
  GBP: "en-GB",
  USD: "en-US",
  EUR: "en-US",
};

/** Locale-aware money, picking a digit-grouping locale by currency so the
 *  figure reads idiomatically to whoever receives it. */
export function formatStatutoryMoney(
  paise: number,
  currency: Currency,
): string {
  const locale = STATUTORY_MONEY_LOCALES[currency] ?? "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(paise / 100);
}

/** Date-precision, in UTC: these are filing dates, and a host west of UTC
 *  would otherwise render a UTC-midnight value as the previous day. */
export function formatStatutoryDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ============================================================================
// Styles
// ============================================================================

export const statutoryStyles = StyleSheet.create({
  page: { padding: 36, fontFamily: "Helvetica", fontSize: 10, color: "#222" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottom: "1 solid #222",
    paddingBottom: 12,
    marginBottom: 18,
  },
  title: { fontSize: 16, fontWeight: "bold", marginBottom: 4 },
  subtitle: { fontSize: 9, color: "#555", marginTop: 3 },
  docNumber: { fontSize: 10, color: "#666" },
  right: { flexDirection: "column", alignItems: "flex-end" },
  sectionTitle: {
    fontSize: 9,
    fontWeight: "bold",
    marginTop: 14,
    marginBottom: 5,
    textTransform: "uppercase",
    color: "#666",
  },
  parties: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  party: { width: "48%" },
  partyName: { fontSize: 11, fontWeight: "bold", marginBottom: 2 },
  line: { fontSize: 9, color: "#444", marginBottom: 1 },
  /** Buyer-supplied text may be Devanagari; everything else stays Helvetica. */
  buyerText: {
    fontSize: 9,
    color: "#444",
    marginBottom: 1,
    fontFamily: BODY_FONT,
  },
  buyerName: {
    fontSize: 11,
    fontWeight: "bold",
    marginBottom: 2,
    fontFamily: BODY_FONT,
  },
  tableHeader: {
    flexDirection: "row",
    borderBottom: "1 solid #222",
    paddingBottom: 4,
    marginBottom: 4,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 4,
    borderBottom: "0.5 solid #ddd",
  },
  cDesc: { width: "58%" },
  cCode: { width: "18%", textAlign: "center" },
  cAmount: { width: "24%", textAlign: "right" },
  totalsBox: { alignSelf: "flex-end", width: "55%", marginTop: 14 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  totalLabel: { fontSize: 10, color: "#444" },
  totalValue: { fontSize: 10 },
  grandTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTop: "1 solid #222",
    marginTop: 6,
    paddingTop: 6,
  },
  grandLabel: { fontSize: 11, fontWeight: "bold" },
  grandValue: { fontSize: 12, fontWeight: "bold" },
  footnote: { marginTop: 16, fontSize: 8, color: "#777" },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 36,
    right: 36,
    borderTop: "0.5 solid #ccc",
    paddingTop: 8,
    fontSize: 8,
    color: "#888",
    textAlign: "center",
  },
});

// ============================================================================
// Frame
// ============================================================================

export interface StatutorySupplier {
  name: string;
  gstin: string;
  address: string;
  stateCode: string;
}

export interface StatutoryBuyer {
  name: string;
  email: string;
  address?: string | null;
  stateCode?: string | null;
}

/** One row of the right-hand "Details" block: dates, place of supply, and on a
 *  credit note the invoice it adjusts (s.34(1)). */
export interface StatutoryDetail {
  label: string;
  value: string;
}

/** One row of the supply / adjustment table. */
export interface StatutoryLineItem {
  description: string;
  code: string;
  amountPaise: number;
}

/** One labelled amount above the rule in the totals box. */
export interface StatutoryTotalLine {
  label: string;
  paise: number;
}

export interface StatutoryDocumentFrameProps {
  title: string;
  /** The statutory authority line, e.g. the s.34 citation on a credit note. */
  subtitle?: string | null;
  documentNumber: string;
  currency: Currency;
  supplier: StatutorySupplier;
  buyer: StatutoryBuyer;
  /** Heading over the buyer block — "Bill to" or "Recipient". */
  buyerHeading: string;
  details: StatutoryDetail[];
  itemsHeading: string;
  /** Column header for the classification code — "SAC" on both documents. */
  codeHeading: string;
  items: StatutoryLineItem[];
  totals: StatutoryTotalLine[];
  grandTotalLabel: string;
  grandTotalPaise: number;
  /** Rendered small and grey under the totals; the s.12(2)(b) note uses it. */
  footnote?: string | null;
  footer: string;
}

export function StatutoryDocumentFrame({
  title,
  subtitle,
  documentNumber,
  currency,
  supplier,
  buyer,
  buyerHeading,
  details,
  itemsHeading,
  codeHeading,
  items,
  totals,
  grandTotalLabel,
  grandTotalPaise,
  footnote,
  footer,
}: Readonly<StatutoryDocumentFrameProps>) {
  return (
    <>
      <View style={statutoryStyles.header}>
        <View>
          <Text style={statutoryStyles.title}>{title}</Text>
          <Text style={statutoryStyles.docNumber}>#{documentNumber}</Text>
          {subtitle ? (
            <Text style={statutoryStyles.subtitle}>{subtitle}</Text>
          ) : null}
        </View>
        <View style={statutoryStyles.right}>
          <Text style={statutoryStyles.partyName}>{supplier.name}</Text>
          <Text style={statutoryStyles.line}>GSTIN: {supplier.gstin}</Text>
          <Text style={statutoryStyles.line}>{supplier.address}</Text>
          <Text style={statutoryStyles.line}>
            State code: {supplier.stateCode}
          </Text>
        </View>
      </View>

      <View style={statutoryStyles.parties}>
        <View style={statutoryStyles.party}>
          <Text style={statutoryStyles.sectionTitle}>{buyerHeading}</Text>
          <Text style={statutoryStyles.buyerName}>{buyer.name}</Text>
          <Text style={statutoryStyles.buyerText}>{buyer.email}</Text>
          {buyer.address ? (
            <Text style={statutoryStyles.buyerText}>{buyer.address}</Text>
          ) : null}
          {buyer.stateCode ? (
            <Text style={statutoryStyles.line}>
              State code: {buyer.stateCode}
            </Text>
          ) : null}
        </View>
        <View style={statutoryStyles.party}>
          <Text style={statutoryStyles.sectionTitle}>Details</Text>
          {details.map((detail) => (
            <Text key={detail.label} style={statutoryStyles.line}>
              {detail.label}: {detail.value}
            </Text>
          ))}
        </View>
      </View>

      <Text style={statutoryStyles.sectionTitle}>{itemsHeading}</Text>
      <View>
        <View style={statutoryStyles.tableHeader}>
          <Text style={statutoryStyles.cDesc}>Description</Text>
          <Text style={statutoryStyles.cCode}>{codeHeading}</Text>
          <Text style={statutoryStyles.cAmount}>Taxable value</Text>
        </View>
        {items.map((item) => (
          <View key={item.description} style={statutoryStyles.tableRow}>
            <Text style={statutoryStyles.cDesc}>{item.description}</Text>
            <Text style={statutoryStyles.cCode}>{item.code}</Text>
            <Text style={statutoryStyles.cAmount}>
              {formatStatutoryMoney(item.amountPaise, currency)}
            </Text>
          </View>
        ))}
      </View>

      <View style={statutoryStyles.totalsBox}>
        {totals.map((total) => (
          <View key={total.label} style={statutoryStyles.totalRow}>
            <Text style={statutoryStyles.totalLabel}>{total.label}</Text>
            <Text style={statutoryStyles.totalValue}>
              {formatStatutoryMoney(total.paise, currency)}
            </Text>
          </View>
        ))}
        <View style={statutoryStyles.grandTotal}>
          <Text style={statutoryStyles.grandLabel}>{grandTotalLabel}</Text>
          <Text style={statutoryStyles.grandValue}>
            {formatStatutoryMoney(grandTotalPaise, currency)}
          </Text>
        </View>
      </View>

      {footnote ? (
        <Text style={statutoryStyles.footnote}>{footnote}</Text>
      ) : null}

      <View style={statutoryStyles.footer} fixed>
        <Text>{footer}</Text>
      </View>
    </>
  );
}

/**
 * The tax lines that actually carry a figure. Both documents show only the
 * heads that were used, so an intra-state document never prints an empty IGST
 * row and vice versa.
 */
export function taxTotalLines(heads: {
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  taxRateBps?: number;
}): StatutoryTotalLine[] {
  const half = heads.taxRateBps
    ? ` @ ${(heads.taxRateBps / 200).toFixed(0)}%`
    : "";
  const full = heads.taxRateBps
    ? ` @ ${(heads.taxRateBps / 100).toFixed(0)}%`
    : "";
  const lines: StatutoryTotalLine[] = [];
  if (heads.igstPaise > 0) {
    lines.push({ label: `IGST${full}`, paise: heads.igstPaise });
  }
  if (heads.cgstPaise > 0) {
    lines.push({ label: `CGST${half}`, paise: heads.cgstPaise });
  }
  if (heads.sgstPaise > 0) {
    lines.push({ label: `SGST${half}`, paise: heads.sgstPaise });
  }
  return lines;
}
