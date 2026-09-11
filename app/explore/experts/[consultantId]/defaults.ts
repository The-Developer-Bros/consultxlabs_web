export interface PricingOption {
  /** Backing plan id from ConsultationPlan / SubscriptionPlan. Required so
   *  tabs are uniquely keyed and booking handlers can route to the exact plan
   *  the user selected, even when multiple plans share the same duration. */
  id: string;
  title: string;
  description: string;
  price: number;
  priceCurrency: string; // Currency code (e.g., "INR", "USD")
  duration: string;
  durationInHours?: number; // For consultation plans
  durationInMonths?: number; // For subscription plans
  totalHours?: number; // Total hours of service included
  totalSessions?: number; // Total number of sessions
  sessionsPerWeek?: number; // Calls per week for subscriptions
  sessionDurationInHours?: number; // Duration of each session
  features?: string[];
}
