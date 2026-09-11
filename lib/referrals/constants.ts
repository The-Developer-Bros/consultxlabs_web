export const QUALIFICATION_WINDOW_DAYS = 30;
// #880 — tightened from 6 months to bound outstanding referral-credit liability.
export const CREDIT_EXPIRY_DAYS = 90;
// #880 — referral credits redeem only on orders of ₹500+ so a credit never
// exceeds the value of the transaction it discounts.
export const MIN_CREDIT_REDEMPTION_PAISE = 50000; // ₹500
// #880 — a single referrer can earn at most this much in referral bonuses over
// a trailing year, mirroring the annual caps Indian fintech programs use.
export const ANNUAL_REWARD_CAP_PAISE = 1000000; // ₹10,000
// #880 — a referred consultant's seller instrument: 0% platform commission on
// their first N settled (paid) sessions, instead of a booking credit they can't
// use. Applied to individual (non-org-hosted) consultants.
export const CONSULTANT_WAIVER_SESSIONS = 3;
