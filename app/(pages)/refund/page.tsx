"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import {
  COMPANY_INFO,
  PAGE_META,
  POLICY_DATES,
  getMailtoLink,
} from "../constants";

export default function RefundPolicyPage() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <div className="flex justify-center mb-4">
            <RefreshCw className="h-16 w-16 text-foreground" />
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            {PAGE_META.refund.title}
          </h1>
          <p className="text-muted-foreground max-w-3xl mx-auto">
            {PAGE_META.refund.description}
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Cancellation & Refund Policy
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Last Updated: {POLICY_DATES.refundLastUpdated}
              </p>
            </CardHeader>
            <CardContent className="prose prose-slate max-w-none">
              <h2 className="text-2xl font-semibold mt-6 mb-4">
                1. Introduction
              </h2>
              <p>
                At Familiarise ("{COMPANY_INFO.name}"), we understand that
                circumstances change and plans may need to be adjusted. This
                Cancellation & Refund Policy outlines the terms and conditions
                for cancellations and refunds for all services offered on our
                platform.
              </p>
              <p>
                By booking any service on our platform, you agree to this
                policy. Please read it carefully before making a booking or
                purchase.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                2. General Cancellation Policy
              </h2>
              <p>
                Our cancellation and refund policies vary depending on the type
                of service you have booked. We strive to be fair to both
                students and consultants while maintaining the integrity of
                scheduled services.
              </p>
              <div className="bg-muted border border-border p-4 rounded-lg mt-4">
                <p className="text-sm">
                  <strong>Important:</strong> All cancellation requests must be
                  submitted through the platform. Cancellations made outside the
                  platform or via direct communication with the consultant will
                  not be eligible for refunds.
                </p>
              </div>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                3. Service-Specific Cancellation Policies
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.1 One-on-One Consultations
              </h3>
              <div className="space-y-3">
                <div>
                  <p>
                    <strong>Cancellation by Student:</strong>
                  </p>
                  <ul>
                    <li>
                      <strong>More than 24 hours before:</strong> Full refund
                      (100% of booking amount)
                    </li>
                    <li>
                      <strong>12-24 hours before:</strong> Partial refund (50%
                      of booking amount)
                    </li>
                    <li>
                      <strong>Less than 12 hours before:</strong> No refund
                    </li>
                    <li>
                      <strong>No-show:</strong> No refund
                    </li>
                  </ul>
                </div>
                <div>
                  <p>
                    <strong>Cancellation by Consultant:</strong>
                  </p>
                  <ul>
                    <li>Full refund (100%) regardless of timing</li>
                    <li>
                      Platform may offer a bonus credit as compensation for
                      inconvenience
                    </li>
                  </ul>
                </div>
                <div>
                  <p>
                    <strong>Rescheduling:</strong>
                  </p>
                  <ul>
                    <li>
                      Students can request one free reschedule if done more than
                      24 hours in advance
                    </li>
                    <li>
                      Consultants must accommodate reasonable reschedule
                      requests
                    </li>
                  </ul>
                </div>
              </div>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.2 Live Interactive Classes
              </h3>
              <div className="space-y-3">
                <div>
                  <p>
                    <strong>Before First Session Starts:</strong>
                  </p>
                  <ul>
                    <li>
                      <strong>More than 7 days before start date:</strong> Full
                      refund (100%)
                    </li>
                    <li>
                      <strong>3-7 days before start date:</strong> Partial
                      refund (75%)
                    </li>
                    <li>
                      <strong>Less than 3 days before start date:</strong>{" "}
                      Partial refund (50%)
                    </li>
                  </ul>
                </div>
                <div>
                  <p>
                    <strong>After Course Has Started:</strong>
                  </p>
                  <ul>
                    <li>
                      <strong>
                        Within first week (after attending max 1 session):
                      </strong>{" "}
                      Pro-rated refund for remaining sessions minus 20%
                      administration fee
                    </li>
                    <li>
                      <strong>After first week:</strong> No refund available
                    </li>
                    <li>
                      Missed sessions due to student absence are not refundable
                    </li>
                  </ul>
                </div>
                <div>
                  <p>
                    <strong>Course Cancellation by Consultant:</strong>
                  </p>
                  <ul>
                    <li>
                      Full refund (100%) if course is canceled before it starts
                    </li>
                    <li>
                      Pro-rated refund for remaining sessions if canceled
                      mid-course
                    </li>
                  </ul>
                </div>
              </div>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.3 Webinars & Workshops
              </h3>
              <div className="space-y-3">
                <div>
                  <p>
                    <strong>Cancellation by Student:</strong>
                  </p>
                  <ul>
                    <li>
                      <strong>More than 48 hours before event:</strong> Full
                      refund (100%)
                    </li>
                    <li>
                      <strong>24-48 hours before event:</strong> Partial refund
                      (50%)
                    </li>
                    <li>
                      <strong>Less than 24 hours before event:</strong> No
                      refund
                    </li>
                    <li>
                      <strong>No-show:</strong> No refund
                    </li>
                  </ul>
                </div>
                <div>
                  <p>
                    <strong>Event Cancellation by Organizer:</strong>
                  </p>
                  <ul>
                    <li>Full refund (100%) regardless of timing</li>
                    <li>
                      Platform may offer priority booking for future events
                    </li>
                  </ul>
                </div>
              </div>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.4 Subscription Plans
              </h3>
              <div className="space-y-3">
                <div>
                  <p>
                    <strong>Cancellation by Student:</strong>
                  </p>
                  <ul>
                    <li>Subscriptions can be canceled at any time</li>
                    <li>No refund for the current billing period</li>
                    <li>Access continues until the end of the paid period</li>
                    <li>
                      Pro-rated refunds available only in case of consultant
                      cancellation or service failure
                    </li>
                  </ul>
                </div>
                <div>
                  <p>
                    <strong>Mid-Subscription Issues:</strong>
                  </p>
                  <ul>
                    <li>
                      If consultant discontinues service mid-subscription,
                      pro-rated refund for unused portion
                    </li>
                    <li>
                      If platform experiences prolonged downtime, pro-rated
                      refund or credit may be issued
                    </li>
                  </ul>
                </div>
              </div>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                4. Refund Eligibility and Conditions
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.1 Eligible for Refund
              </h3>
              <ul>
                <li>
                  Cancellations made within the allowed timeframe as per service
                  type
                </li>
                <li>
                  Consultant cancels or fails to attend the scheduled session
                </li>
                <li>
                  Technical issues on our platform prevent service delivery
                  (verified by our team)
                </li>
                <li>
                  Service quality does not match the description (subject to
                  review)
                </li>
                <li>Duplicate or erroneous charges</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.2 Not Eligible for Refund
              </h3>
              <ul>
                <li>Late cancellations outside the allowed timeframe</li>
                <li>No-shows or missed sessions by students</li>
                <li>
                  Technical issues on the student's side (internet, device,
                  etc.)
                </li>
                <li>Change of mind after attending sessions</li>
                <li>
                  Dissatisfaction with service after consuming majority of
                  purchased sessions
                </li>
                <li>Platform commission fees (non-refundable)</li>
                <li>Payment gateway charges (non-refundable)</li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                5. Refund Process
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                5.1 How to Request a Refund
              </h3>
              <ol>
                <li>Log in to your Familiarise account</li>
                <li>Navigate to "My Bookings" or "My Subscriptions"</li>
                <li>Select the booking you wish to cancel</li>
                <li>Click "Request Cancellation" or "Request Refund"</li>
                <li>
                  Provide a reason for cancellation (optional but helpful)
                </li>
                <li>Submit your request</li>
              </ol>
              <p className="mt-3">
                Alternatively, you can contact our support team at{" "}
                <a
                  href={getMailtoLink()}
                  className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                >
                  {COMPANY_INFO.email}
                </a>{" "}
                with:
              </p>
              <ul>
                <li>Your booking ID or subscription ID</li>
                <li>Reason for cancellation/refund request</li>
                <li>Any supporting documentation (if applicable)</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                5.2 Refund Processing Time
              </h3>
              <ul>
                <li>
                  <strong>Review Period:</strong> Refund requests are reviewed
                  within 2-3 business days
                </li>
                <li>
                  <strong>Approval Notification:</strong> You will receive an
                  email confirmation once approved
                </li>
                <li>
                  <strong>Refund Initiation:</strong> Refunds are initiated
                  within 24-48 hours of approval
                </li>
                <li>
                  <strong>Bank Processing Time:</strong> 5-7 business days for
                  the amount to reflect in your account
                </li>
                <li>
                  <strong>Payment Gateway Delays:</strong> Razorpay may take
                  additional time based on your bank's processing schedule
                </li>
              </ul>
              <div className="bg-yellow-50 dark:bg-yellow-950 p-4 rounded-lg mt-4">
                <p className="text-sm">
                  <strong>Note:</strong> The total time from refund request to
                  receiving funds in your account may take 7-14 business days
                  depending on your bank and payment method.
                </p>
              </div>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                5.3 Refund Method
              </h3>
              <ul>
                <li>
                  Refunds are processed to the original payment method used for
                  the transaction
                </li>
                <li>
                  If the original payment method is unavailable, refunds may be
                  issued as platform credits
                </li>
                <li>
                  UPI payments are refunded to the UPI ID used for payment
                </li>
                <li>Card payments are refunded to the original card</li>
                <li>
                  Net banking and wallet payments are refunded to the source
                  account/wallet
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                6. Platform Commission and Fees
              </h2>
              <ul>
                <li>
                  The platform service fee is <strong>non-refundable</strong> in
                  all cases
                </li>
                <li>
                  Payment gateway charges (Razorpay fees) are{" "}
                  <strong>non-refundable</strong>
                </li>
                <li>
                  Only the consultant's service fee portion is eligible for
                  refunds
                </li>
                <li>
                  The displayed refund amount will be the amount you receive
                  after deducting non-refundable fees
                </li>
              </ul>
              <div className="bg-muted p-4 rounded-lg mt-4">
                <p className="text-sm">
                  <strong>Example:</strong> If you paid ₹1,000 for a
                  consultation (₹850 consultant fee + ₹150 platform/gateway
                  fees), a full refund would return ₹850, not ₹1,000.
                </p>
              </div>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                7. Partial Refunds
              </h2>
              <p>
                Partial refunds may be issued in the following circumstances:
              </p>
              <ul>
                <li>
                  Pro-rated refunds for multi-session courses canceled mid-way
                </li>
                <li>
                  Late cancellations within specific timeframes (as outlined
                  above)
                </li>
                <li>
                  Subscription cancellations with remaining unused sessions
                </li>
                <li>
                  Service quality issues affecting only part of the booked
                  service
                </li>
              </ul>
              <p>Partial refund amounts are calculated based on:</p>
              <ul>
                <li>
                  Number of sessions attended vs. total sessions purchased
                </li>
                <li>Cancellation timing relative to the service date</li>
                <li>Administration fees for processing (where applicable)</li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                8. Technical Issues and Service Failures
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                8.1 Platform Technical Issues
              </h3>
              <p>
                If our platform experiences technical difficulties that prevent
                service delivery:
              </p>
              <ul>
                <li>Full refund or free rescheduling option</li>
                <li>Compensation credit for significant inconvenience</li>
                <li>
                  Issue must be reported immediately and verified by our
                  technical team
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                8.2 User-Side Technical Issues
              </h3>
              <p>
                If technical issues occur on the user's side (poor internet,
                device problems, etc.):
              </p>
              <ul>
                <li>No refund is applicable</li>
                <li>
                  Consultant may offer a partial make-up session (at their
                  discretion)
                </li>
                <li>
                  Users are responsible for ensuring their setup is compatible
                  before sessions
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                9. Emergency and Exceptional Circumstances
              </h2>
              <p>
                We understand that emergencies happen. In cases of genuine
                emergency situations:
              </p>
              <ul>
                <li>Medical emergencies (documentation may be required)</li>
                <li>Family emergencies</li>
                <li>Natural disasters or force majeure events</li>
                <li>
                  Government-mandated restrictions affecting service delivery
                </li>
              </ul>
              <p>
                Please contact our support team immediately with relevant
                documentation. We will review such cases individually and may
                make exceptions to the standard policy at our discretion.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                10. Disputed Charges
              </h2>
              <p>
                If you believe you have been incorrectly charged or notice
                unauthorized charges:
              </p>
              <ol>
                <li>
                  Contact our support team immediately at{" "}
                  <a
                    href={getMailtoLink()}
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    {COMPANY_INFO.email}
                  </a>
                </li>
                <li>
                  Provide details of the disputed charge with transaction ID
                </li>
                <li>Do not initiate a chargeback before contacting us</li>
                <li>We will investigate and resolve within 7 business days</li>
              </ol>
              <div className="bg-red-50 dark:bg-red-950 p-4 rounded-lg mt-4">
                <p className="text-sm">
                  <strong>Important:</strong> Initiating a chargeback without
                  contacting us first may result in immediate suspension of your
                  account until the matter is resolved.
                </p>
              </div>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                11. Consultant-Initiated Refunds
              </h2>
              <p>
                Consultants have the discretion to issue refunds or offer
                alternative compensation in the following situations:
              </p>
              <ul>
                <li>If they are unable to fulfill the service as described</li>
                <li>If they need to cancel or reschedule multiple times</li>
                <li>
                  If the student is not satisfied with the session quality
                </li>
              </ul>
              <p>
                Consultant-initiated refunds follow the same processing timeline
                and methods as standard refunds.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                12. Refund Tracking
              </h2>
              <p>You can track the status of your refund request by:</p>
              <ul>
                <li>
                  Checking the "My Bookings" section in your account dashboard
                </li>
                <li>Viewing refund status updates via email notifications</li>
                <li>Contacting support for detailed status information</li>
              </ul>
              <p>Refund statuses include:</p>
              <ul>
                <li>
                  <strong>Pending Review:</strong> Your request is being
                  evaluated
                </li>
                <li>
                  <strong>Approved:</strong> Refund has been approved and will
                  be processed
                </li>
                <li>
                  <strong>Processing:</strong> Refund is being processed by
                  payment gateway
                </li>
                <li>
                  <strong>Completed:</strong> Refund has been sent to your
                  account
                </li>
                <li>
                  <strong>Rejected:</strong> Request does not meet refund
                  criteria (reason provided)
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                13. Appeals and Disputes
              </h2>
              <p>
                If your refund request is denied and you believe the decision
                was incorrect:
              </p>
              <ol>
                <li>
                  You may appeal the decision within 7 days of the denial
                  notification
                </li>
                <li>
                  Provide additional information or documentation supporting
                  your case
                </li>
                <li>
                  Our review team will re-evaluate and respond within 5 business
                  days
                </li>
                <li>The decision after appeal is final</li>
              </ol>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                14. Changes to This Policy
              </h2>
              <p>
                We may update this Cancellation & Refund Policy from time to
                time. Any changes will be:
              </p>
              <ul>
                <li>Posted on this page with an updated "Last Updated" date</li>
                <li>Communicated via email to all active users</li>
                <li>
                  Applied to bookings made after the effective date of the
                  change
                </li>
              </ul>
              <p>
                Existing bookings will be governed by the policy in effect at
                the time of booking.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                15. Contact Us
              </h2>
              <p>
                If you have questions about our Cancellation & Refund Policy or
                need assistance with a cancellation or refund request, please
                contact us:
              </p>
              <div className="bg-muted p-4 rounded-lg mt-4">
                <p>
                  <strong>Company Name:</strong> {COMPANY_INFO.name}
                </p>
                <p>
                  <strong>Email:</strong>{" "}
                  <a
                    href={getMailtoLink()}
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    {COMPANY_INFO.email}
                  </a>
                </p>
                <p>
                  <strong>Support:</strong>{" "}
                  <Link
                    href="/contactus"
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    Contact Form
                  </Link>
                </p>
                <p>
                  <strong>Response Time:</strong> We aim to respond to all
                  inquiries within 24-48 hours
                </p>
              </div>

              <Separator className="my-6" />

              <div className="bg-secondary border border-border p-6 rounded-lg mt-8">
                <h3 className="text-lg font-semibold mb-2">
                  Fair Treatment for All
                </h3>
                <p className="text-sm">
                  Our cancellation and refund policies are designed to be fair
                  to both students and consultants. We encourage clear
                  communication between all parties and are here to help
                  facilitate positive outcomes. If you have any concerns about a
                  booking or service, please reach out to us before requesting a
                  refund so we can explore all available options.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
