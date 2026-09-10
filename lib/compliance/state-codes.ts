/**
 * GST state-code normalisation — shared by the IRP payload builder and the
 * GST place-of-supply derivation.
 *
 * Two representations reach us for the same state and they never compare
 * equal: the seller side is env-sourced alpha (`SUPPLIER_STATE_CODE`, e.g.
 * "KA") while the buyer side is written numeric, because the settings form
 * strips non-digits from `OrganizationTaxInfo.gstStateCode` (e.g. "29").
 * Normalise both through `numericStateCode` before any comparison — see #1132.
 */

// 2-digit numeric GST state codes keyed by the alpha codes this codebase
// stores in gstStateCode / SUPPLIER_STATE_CODE. The GSTIN prefix is
// authoritative; this only covers the env-sourced seller fallback.
export const STATE_ALPHA_TO_NUMERIC: Record<string, string> = {
  JK: "01",
  HP: "02",
  PB: "03",
  CH: "04",
  UT: "05",
  HR: "06",
  DL: "07",
  RJ: "08",
  UP: "09",
  BR: "10",
  SK: "11",
  AR: "12",
  NL: "13",
  MN: "14",
  MZ: "15",
  TR: "16",
  ML: "17",
  AS: "18",
  WB: "19",
  JH: "20",
  OD: "21",
  CG: "22",
  MP: "23",
  GJ: "24",
  DD: "26",
  MH: "27",
  KA: "29",
  GA: "30",
  LD: "31",
  KL: "32",
  TN: "33",
  PY: "34",
  AN: "35",
  TG: "36",
  AP: "37",
  LA: "38",
};

/**
 * Resolve a state to its 2-digit numeric GST code. GSTIN[0:2] wins when
 * present; otherwise map the stored alpha code; pass through anything already
 * numeric. Returns null when the state cannot be determined — callers must
 * treat null as "unknown" and fall back to IGST, never as a match.
 */
export function numericStateCode(
  gstin: string | null | undefined,
  alphaOrNumeric: string | null | undefined,
): string | null {
  if (gstin && /^[0-9]{2}/.test(gstin)) return gstin.slice(0, 2);
  if (!alphaOrNumeric) return null;
  const v = alphaOrNumeric.trim().toUpperCase();
  if (/^[0-9]{2}$/.test(v)) return v;
  return STATE_ALPHA_TO_NUMERIC[v] ?? null;
}

/**
 * Human-readable names for the 2-digit numeric GST state codes, in code order
 * — the list a buyer picks their billing state from at checkout (#1365). It
 * lives beside the alpha map so the two representations of a state are never
 * maintained in two places.
 */
export const STATE_NUMERIC_TO_NAME: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  // 25 (Daman and Diu) merged into 26 in 2020; the merged UT keeps code 26.
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
};

/**
 * The picker's options, ordered by state code. The sort is explicit because
 * `Object.entries` returns canonical integer-like keys ("26", "27") before the
 * zero-padded ones ("01"). Every key here is a two-digit numeral, so ordering
 * them numerically is exact and gives the same result on every runtime —
 * unlike `localeCompare`, whose collation is ICU-dependent.
 */
export const GST_STATE_OPTIONS: ReadonlyArray<{ code: string; name: string }> =
  Object.entries(STATE_NUMERIC_TO_NAME)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => Number(a.code) - Number(b.code));
