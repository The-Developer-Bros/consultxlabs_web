"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { FileText } from "lucide-react";
import {
  COMPANY_INFO,
  PAGE_META,
  POLICY_DATES,
  getMailtoLink,
} from "../constants";

export default function TermsPage() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <div className="flex justify-center mb-4">
            <FileText className="h-16 w-16 text-foreground" />
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            {PAGE_META.terms.title}
          </h1>
          <p className="text-muted-foreground max-w-3xl mx-auto">
            {PAGE_META.terms.description}
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Terms & Conditions
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Last Updated: {POLICY_DATES.termsLastUpdated}
              </p>
            </CardHeader>
            <CardContent className="prose prose-slate max-w-none">
              <h2 className="text-2xl font-semibold mt-6 mb-4">
                1. Agreement to Terms
              </h2>
              <p>
                Welcome to Familiarise ("{COMPANY_INFO.name}"). These Terms &
                Conditions ("Terms") govern your access to and use of our
                website, platform, and services. By accessing or using our
                services, you agree to be bound by these Terms and our Privacy
                Policy.
              </p>
              <p>
                If you do not agree to these Terms, you must not access or use
                our services. We reserve the right to modify these Terms at any
                time, and your continued use of the services after such
                modifications constitutes your acceptance of the updated Terms.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                2. Service Description
              </h2>
              <p>
                Familiarise is an online educational technology platform that
                connects consultants, educators, and subject matter experts
                ("Consultants") with students and learners ("Students"). Our
                platform facilitates:
              </p>
              <ul>
                <li>
                  <strong>Live Interactive Classes:</strong> Group learning
                  sessions with scheduled appointments
                </li>
                <li>
                  <strong>Webinars:</strong> Large-scale educational events and
                  workshops
                </li>
                <li>
                  <strong>One-on-One Consultations:</strong> Personalized expert
                  guidance sessions
                </li>
                <li>
                  <strong>Subscription Plans:</strong> Ongoing learning programs
                  with recurring sessions
                </li>
              </ul>
              <p>
                Familiarise acts as a marketplace platform connecting
                Consultants and Students. We are not a party to the educational
                services provided by Consultants and do not guarantee the
                quality, accuracy, or outcomes of such services.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                3. User Accounts
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.1 Registration
              </h3>
              <p>
                To use certain features of our platform, you must create an
                account by providing:
              </p>
              <ul>
                <li>Accurate and complete registration information</li>
                <li>A valid email address and phone number</li>
                <li>A secure password</li>
              </ul>
              <p>
                You are responsible for maintaining the confidentiality of your
                account credentials and for all activities that occur under your
                account.
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.2 Account Responsibilities
              </h3>
              <p>You agree to:</p>
              <ul>
                <li>Provide accurate, current, and complete information</li>
                <li>Update your information to keep it accurate and current</li>
                <li>
                  Notify us immediately of any unauthorized use of your account
                </li>
                <li>Not share your account with others</li>
                <li>Not create multiple accounts for fraudulent purposes</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                3.3 Account Termination
              </h3>
              <p>
                We reserve the right to suspend or terminate your account if
                you:
              </p>
              <ul>
                <li>Violate these Terms & Conditions</li>
                <li>Engage in fraudulent or illegal activities</li>
                <li>Provide false or misleading information</li>
                <li>Abuse or harass other users</li>
                <li>Violate intellectual property rights</li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                4. Payment Terms
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.1 Payment Processing
              </h3>
              <p>
                All payments are processed securely through our payment partner,
                Razorpay. By making a payment, you agree to Razorpay's terms and
                conditions. We do not store your complete payment card
                information on our servers.
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.2 Pricing and Fees
              </h3>
              <ul>
                <li>Consultants set their own pricing for services</li>
                <li>
                  All prices are displayed in INR (Indian Rupees) unless
                  otherwise specified
                </li>
                <li>The platform charges a commission on each transaction</li>
                <li>
                  Prices displayed to Students include the platform commission
                </li>
                <li>
                  Prices are subject to change at the Consultant's discretion
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.3 Payment Authorization
              </h3>
              <p>
                By providing payment information, you authorize us (through
                Razorpay) to charge the specified amount for the services you
                have selected. You represent that:
              </p>
              <ul>
                <li>
                  You have the legal right to use the payment method provided
                </li>
                <li>The payment information is accurate and current</li>
                <li>
                  You will notify us of any changes to your payment information
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.4 Currency and Taxes
              </h3>
              <ul>
                <li>All transactions are processed in Indian Rupees (INR)</li>
                <li>
                  Prices may or may not include applicable taxes (GST, etc.)
                </li>
                <li>
                  You are responsible for any taxes applicable in your
                  jurisdiction
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                4.5 Failed Payments
              </h3>
              <p>
                If a payment fails or is declined, we reserve the right to
                cancel your booking. You will not have access to the service
                until successful payment is received.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                5. Consultant Obligations
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                5.1 Service Delivery
              </h3>
              <p>Consultants agree to:</p>
              <ul>
                <li>
                  Provide accurate information about their expertise and
                  qualifications
                </li>
                <li>Deliver services as described and scheduled</li>
                <li>Maintain professional conduct at all times</li>
                <li>Respond to Student inquiries in a timely manner</li>
                <li>
                  Honor confirmed bookings or provide adequate notice for
                  cancellations
                </li>
                <li>Provide course materials and resources as promised</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                5.2 Content Ownership
              </h3>
              <p>
                Consultants retain ownership of their original educational
                content. However, by uploading content to our platform, you
                grant us a non-exclusive license to use, display, and distribute
                the content as necessary to provide our services.
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                5.3 Prohibited Content
              </h3>
              <p>Consultants must not upload or share content that:</p>
              <ul>
                <li>Infringes on intellectual property rights</li>
                <li>Contains illegal, harmful, or offensive material</li>
                <li>Promotes violence, discrimination, or hate speech</li>
                <li>Contains viruses, malware, or other harmful code</li>
                <li>Violates privacy or data protection laws</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                5.4 Payment to Consultants
              </h3>
              <p>
                Consultants will receive payment for completed services
                according to our settlement schedule, after deduction of the
                platform commission. Payments are subject to successful service
                delivery and compliance with these Terms.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                6. Student Obligations
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                6.1 Booking and Attendance
              </h3>
              <p>Students agree to:</p>
              <ul>
                <li>Make bookings in good faith with intent to attend</li>
                <li>Attend scheduled sessions on time</li>
                <li>
                  Provide timely notice if unable to attend (as per cancellation
                  policy)
                </li>
                <li>Pay the agreed amount for services</li>
                <li>
                  Respect Consultants' intellectual property and teaching
                  materials
                </li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                6.2 Professional Conduct
              </h3>
              <p>Students must:</p>
              <ul>
                <li>Maintain respectful and professional behavior</li>
                <li>Not record sessions without explicit permission</li>
                <li>Not share course materials without authorization</li>
                <li>Not engage in harassment, abuse, or discrimination</li>
                <li>Follow the Consultant's guidelines and instructions</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                6.3 Prohibited Activities
              </h3>
              <p>Students must not:</p>
              <ul>
                <li>Use the platform for any illegal purposes</li>
                <li>Attempt to circumvent payment systems</li>
                <li>Share account credentials with others</li>
                <li>Submit fraudulent payment information</li>
                <li>
                  Engage in activities that disrupt the platform or other users
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                7. Intellectual Property Rights
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.1 Platform Rights
              </h3>
              <p>
                The Familiarise platform, including its design, features, code,
                logos, and trademarks, is owned by {COMPANY_INFO.name} and
                protected by intellectual property laws. You may not copy,
                modify, distribute, or create derivative works without our
                express written permission.
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.2 User Content
              </h3>
              <p>
                You retain ownership of content you create and upload to the
                platform. However, by uploading content, you grant us a
                worldwide, non-exclusive, royalty-free license to use, display,
                and distribute your content as necessary to provide our
                services.
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                7.3 Copyright Infringement
              </h3>
              <p>
                We respect intellectual property rights. If you believe your
                copyright has been infringed, please contact us with:
              </p>
              <ul>
                <li>Description of the copyrighted work</li>
                <li>Location of the infringing material</li>
                <li>Your contact information</li>
                <li>
                  A statement of good faith belief that use is unauthorized
                </li>
                <li>
                  A statement under penalty of perjury that the information is
                  accurate
                </li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                8. Cancellation and Refunds
              </h2>
              <p>
                Cancellations and refunds are governed by our{" "}
                <a
                  href="/refund"
                  className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                >
                  Cancellation & Refund Policy
                </a>
                . Please review that policy for detailed information about
                cancellation rules, refund eligibility, and processing times.
              </p>
              <p>Key points:</p>
              <ul>
                <li>Cancellation rules vary by service type</li>
                <li>Refunds are processed based on timing of cancellation</li>
                <li>Platform may charge cancellation fees in certain cases</li>
                <li>Refunds are processed within 5-7 business days</li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                9. Platform Termination Rights
              </h2>
              <p>We reserve the right to:</p>
              <ul>
                <li>Cancel bookings if payment is not received</li>
                <li>
                  Remove content that violates these Terms or applicable laws
                </li>
                <li>Suspend or terminate accounts for violations</li>
                <li>Modify or discontinue services with reasonable notice</li>
                <li>Refuse service to anyone for any reason</li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                10. Disclaimers and Limitations of Liability
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                10.1 Service "As Is"
              </h3>
              <p>
                Our platform and services are provided "as is" without
                warranties of any kind, either express or implied. We do not
                guarantee:
              </p>
              <ul>
                <li>Uninterrupted or error-free service</li>
                <li>Quality or accuracy of Consultant services</li>
                <li>Specific outcomes or results from educational services</li>
                <li>That the platform will meet your specific requirements</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                10.2 Third-Party Services
              </h3>
              <p>
                We are not responsible for the conduct, content, or services
                provided by:
              </p>
              <ul>
                <li>Consultants using our platform</li>
                <li>
                  Third-party service providers (Razorpay, GetStream, etc.)
                </li>
                <li>External websites linked from our platform</li>
              </ul>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                10.3 Limitation of Liability
              </h3>
              <p>
                To the maximum extent permitted by law, {COMPANY_INFO.name}{" "}
                shall not be liable for:
              </p>
              <ul>
                <li>Indirect, incidental, special, or consequential damages</li>
                <li>Loss of profits, data, or business opportunities</li>
                <li>
                  Damages arising from use or inability to use the platform
                </li>
                <li>Issues arising from Consultant services or conduct</li>
                <li>Technical failures, security breaches, or data loss</li>
              </ul>
              <p>
                Our total liability for any claim shall not exceed the amount
                you paid to us in the 12 months preceding the claim, or INR
                10,000, whichever is less.
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                10.4 Force Majeure
              </h3>
              <p>
                We are not liable for any failure or delay in performance due to
                circumstances beyond our reasonable control, including natural
                disasters, wars, pandemics, strikes, or technical failures.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                11. Indemnification
              </h2>
              <p>
                You agree to indemnify, defend, and hold harmless{" "}
                {COMPANY_INFO.name}, its officers, directors, employees, and
                agents from any claims, damages, losses, liabilities, and
                expenses (including legal fees) arising from:
              </p>
              <ul>
                <li>Your use of the platform</li>
                <li>Your violation of these Terms</li>
                <li>Your violation of any rights of another party</li>
                <li>Your content uploaded to the platform</li>
                <li>Your conduct as a Consultant or Student</li>
              </ul>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                12. Dispute Resolution
              </h2>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                12.1 Informal Resolution
              </h3>
              <p>
                In the event of any dispute, you agree to first contact us at{" "}
                <a
                  href={getMailtoLink()}
                  className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                >
                  {COMPANY_INFO.email}
                </a>{" "}
                to attempt to resolve the issue informally. We will work in good
                faith to resolve disputes amicably.
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                12.2 Mediation
              </h3>
              <p>
                If informal resolution fails, disputes may be referred to
                mediation before pursuing legal action.
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                12.3 Governing Law
              </h3>
              <p>
                These Terms shall be governed by and construed in accordance
                with the laws of {COMPANY_INFO.jurisdiction}, without regard to
                its conflict of law provisions.
              </p>

              <h3 className="text-xl font-semibold mt-4 mb-2">
                12.4 Jurisdiction
              </h3>
              <p>
                You agree to submit to the exclusive jurisdiction of the courts
                located in {COMPANY_INFO.jurisdiction} for the resolution of any
                disputes.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                13. Privacy and Data Protection
              </h2>
              <p>
                Your use of our services is also governed by our{" "}
                <a
                  href="/privacy"
                  className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                >
                  Privacy Policy
                </a>
                , which describes how we collect, use, and protect your personal
                information. By using our services, you consent to our data
                practices as described in the Privacy Policy.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                14. Changes to Terms
              </h2>
              <p>
                We reserve the right to modify these Terms at any time. We will
                notify you of material changes by:
              </p>
              <ul>
                <li>Posting the updated Terms on this page</li>
                <li>Updating the "Last Updated" date</li>
                <li>Sending email notifications for significant changes</li>
                <li>Displaying a notice on the platform</li>
              </ul>
              <p>
                Your continued use of the platform after changes are posted
                constitutes your acceptance of the updated Terms. If you do not
                agree to the changes, you must stop using our services.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                15. Severability
              </h2>
              <p>
                If any provision of these Terms is found to be invalid or
                unenforceable, the remaining provisions will continue to be
                valid and enforceable to the fullest extent permitted by law.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                16. Entire Agreement
              </h2>
              <p>
                These Terms, together with our Privacy Policy and Cancellation &
                Refund Policy, constitute the entire agreement between you and
                {COMPANY_INFO.name} regarding your use of the platform and
                supersede all prior agreements and understandings.
              </p>

              <Separator className="my-6" />

              <h2 className="text-2xl font-semibold mt-6 mb-4">
                17. Contact Information
              </h2>
              <p>
                If you have any questions about these Terms & Conditions, please
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
                  <strong>Contact Form:</strong>{" "}
                  <a
                    href="/contactus"
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    Contact Us
                  </a>
                </p>
              </div>

              <Separator className="my-6" />

              <div className="bg-secondary border border-border p-6 rounded-lg mt-8">
                <h3 className="text-lg font-semibold mb-2">
                  Acceptance of Terms
                </h3>
                <p className="text-sm">
                  By creating an account, booking a service, or using any part
                  of our platform, you acknowledge that you have read,
                  understood, and agree to be bound by these Terms & Conditions.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
