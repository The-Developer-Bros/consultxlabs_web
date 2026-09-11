/**
 * Typed error classes for slot allocation.
 *
 * Used by SlotAllocationService.classifyError() to map errors to HTTP status
 * codes via instanceof checks instead of brittle string-prefix matching.
 */

import { AllocationErrorCode } from "./types";

abstract class AllocationError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly errorCode: AllocationErrorCode;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** 400 — validation failures, bad input, business rule violations.
 * The optional code override lets callers distinguish cause-specific
 * sub-types (NO_AVAILABILITY, PERIOD_ENDED, SLOT_SHORTAGE) while keeping
 * the same HTTP status. */
export class AllocationValidationError extends AllocationError {
  readonly httpStatus = 400 as const;
  readonly errorCode: AllocationErrorCode;
  constructor(message: string, code: AllocationErrorCode = "VALIDATION_ERROR") {
    super(message);
    this.errorCode = code;
  }
}

/**
 * 400 — SLOT_SHORTAGE, carrying how many WHOLE sessions the search COULD place
 * (#1206). Without that number the client can only say "not enough free
 * slots"; with it, it can offer the consultant the choice between waiting and
 * placing what fits now.
 */
export class SlotShortageError extends AllocationValidationError {
  constructor(
    message: string,
    readonly placeableSessions: number,
    readonly requiredSessions: number,
  ) {
    super(message, "SLOT_SHORTAGE");
  }
}

/** 400 — event or consultant not found */
export class AllocationNotFoundError extends AllocationError {
  readonly httpStatus = 400 as const;
  readonly errorCode = "NOT_FOUND" as const;
}

/** 409 — lock contention, duplicate booking race, already allocated */
export class AllocationConflictError extends AllocationError {
  readonly httpStatus = 409 as const;
  readonly errorCode = "LOCK_CONTENTION" as const;
}
