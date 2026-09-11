/**
 * Setup file for booking-algorithm tests.
 * Polyfills TextEncoder/TextDecoder needed by Prisma client in jsdom.
 */

import { TextEncoder, TextDecoder } from "util";

if (typeof global.TextEncoder === "undefined") {
  (global as any).TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === "undefined") {
  (global as any).TextDecoder = TextDecoder;
}

// PR 2c — SlotAllocationService now imports lib/novu (allocation-time
// notification). @novu/node pulls undici's Request at import time, which the
// Jest environment lacks; every suite that loads the allocator would fail to
// even parse. The notification itself is fire-and-forget and asserted via
// these mocks where relevant.
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifyAppointmentBooked: jest.fn(),
  notifyAppointmentCancelled: jest.fn(),
  notifyAppointmentRescheduled: jest.fn(),
  notifyAppointmentCompleted: jest.fn(),
  notifyAppointmentReminder: jest.fn(),
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyNewBookingRequest: jest.fn(),
}));
