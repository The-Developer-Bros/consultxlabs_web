/**
 * Class Plan Defaults Utility
 *
 * Provides standardized class plan detection and default values
 * for Basic, Extended, and Comprehensive class types.
 *
 * Used across the booking system to ensure consistent class configuration.
 */

export type ClassPlanType = "Basic" | "Extended" | "Comprehensive" | "Custom";

export interface ClassPlanDefaults {
  type: ClassPlanType;
  classesPerWeek: number;
  durationInMonths: number;
  sessionDurationInHours: number;
}

/**
 * Interface for class plan input data
 */
export interface ClassPlan {
  title?: string;
  classesPerWeek?: number;
  sessionsPerWeek?: number;
  durationInMonths?: number;
  sessionDurationInHours?: number;
}

/**
 * Class plan defaults based on plan type
 */
const CLASS_PLAN_DEFAULTS: Record<
  Exclude<ClassPlanType, "Custom">,
  Omit<ClassPlanDefaults, "type">
> = {
  Basic: {
    classesPerWeek: 2,
    durationInMonths: 1,
    sessionDurationInHours: 1,
  },
  Extended: {
    classesPerWeek: 3,
    durationInMonths: 2,
    sessionDurationInHours: 1,
  },
  Comprehensive: {
    classesPerWeek: 4,
    durationInMonths: 4,
    sessionDurationInHours: 1,
  },
};

/**
 * Detect class plan type from plan title
 * @param plan Class plan object with title field
 * @returns Detected class plan type
 */
export function detectClassPlanType(plan: ClassPlan): ClassPlanType {
  const title: string = (plan?.title || "").toString().toLowerCase();

  if (title.includes("comprehens")) return "Comprehensive";
  if (title.includes("extended")) return "Extended";
  if (title.includes("basic")) return "Basic";

  return "Custom";
}

/**
 * Get class plan defaults with fallbacks
 *
 * Uses plan values if available, otherwise falls back to type-based defaults.
 * For Custom plans, uses provided values or sensible defaults.
 *
 * @param plan Class plan object
 * @returns Complete class plan configuration with defaults applied
 */
export function getClassPlanDefaults(plan: ClassPlan): ClassPlanDefaults {
  const type = detectClassPlanType(plan);

  // Extract values from plan
  const classesPerWeekFromPlan = plan?.classesPerWeek ?? plan?.sessionsPerWeek;
  const durationInMonthsFromPlan = plan?.durationInMonths;
  const sessionDurationInHours = plan?.sessionDurationInHours ?? 1;

  // Determine final values with fallbacks
  let classesPerWeek = classesPerWeekFromPlan;
  let durationInMonths = durationInMonthsFromPlan;

  // Apply defaults if values are missing or invalid
  if (
    classesPerWeek === undefined ||
    classesPerWeek === null ||
    Number.isNaN(Number(classesPerWeek))
  ) {
    classesPerWeek =
      type !== "Custom" ? CLASS_PLAN_DEFAULTS[type].classesPerWeek : 2; // Default for Custom
  }

  if (
    durationInMonths === undefined ||
    durationInMonths === null ||
    Number.isNaN(Number(durationInMonths))
  ) {
    durationInMonths =
      type !== "Custom" ? CLASS_PLAN_DEFAULTS[type].durationInMonths : 1; // Default for Custom
  }

  return {
    type,
    classesPerWeek: Number(classesPerWeek),
    durationInMonths: Number(durationInMonths),
    sessionDurationInHours: Number(sessionDurationInHours),
  };
}

/**
 * Get default values for a specific class plan type
 * @param type Class plan type
 * @returns Default configuration for the plan type
 */
export function getDefaultsForType(
  type: Exclude<ClassPlanType, "Custom">,
): Omit<ClassPlanDefaults, "type"> {
  return CLASS_PLAN_DEFAULTS[type];
}

/**
 * Validate class plan configuration
 * @param config Class plan configuration
 * @returns Validation result with errors if any
 */
export function validateClassPlanConfig(config: ClassPlanDefaults): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (config.classesPerWeek < 1 || config.classesPerWeek > 7) {
    errors.push("Classes per week must be between 1 and 7");
  }

  if (config.durationInMonths < 1 || config.durationInMonths > 12) {
    errors.push("Duration must be between 1 and 12 months");
  }

  if (
    config.sessionDurationInHours < 0.5 ||
    config.sessionDurationInHours > 8
  ) {
    errors.push("Session duration must be between 0.5 and 8 hours");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
