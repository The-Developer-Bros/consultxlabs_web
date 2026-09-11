"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { DollarSign, Users, Video, Calendar, Repeat } from "lucide-react";
import { PAGE_META, PRICING_DATA } from "../constants";

export default function PricingPage() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            {PAGE_META.pricing.title}
          </h1>
          <p className="text-fluid-lg text-muted-foreground max-w-3xl mx-auto">
            {PAGE_META.pricing.description}
          </p>
        </div>

        <div className="max-w-4xl mx-auto space-y-8">
          {/* Pricing Model Overview */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <div className="flex items-center gap-2">
                <DollarSign className="h-6 w-6 text-foreground" />
                <CardTitle className="text-fluid-2xl">
                  How Our Pricing Works
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                At Familiarise, we believe in empowering consultants to set
                their own prices based on their expertise, experience, and the
                value they provide. Our platform operates on a
                <strong> dynamic pricing model</strong> where:
              </p>
              <div className="bg-muted p-4 rounded-lg space-y-2">
                {PRICING_DATA.howItWorks.map((item, index) => (
                  <p key={index} className="flex items-start gap-2">
                    <span className="text-green-600 mt-1">✓</span>
                    <span>
                      <strong>{item.split(" ").slice(0, 3).join(" ")}</strong>{" "}
                      {item.split(" ").slice(3).join(" ")}
                    </span>
                  </p>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Platform Commission */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Platform Commission
              </CardTitle>
              <CardDescription>
                Our commission structure enables us to maintain and improve the
                platform
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                Familiarise charges a small platform fee on each transaction.
                This fee helps us:
              </p>
              <ul className="list-disc list-inside space-y-2 text-muted-foreground ml-4">
                {PRICING_DATA.commissionBenefits.map((benefit, index) => (
                  <li key={index}>{benefit}</li>
                ))}
              </ul>
              <div className="bg-muted border border-border p-4 rounded-lg mt-4">
                <p className="text-sm">
                  <strong>Note:</strong> The commission is automatically
                  included in the prices shown to students. Consultants receive
                  their earnings after the platform fee is deducted.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Service Categories */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">Service Categories</CardTitle>
              <CardDescription>
                Explore the different types of services available on our
                platform
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6">
                {/* Consultations */}
                <div className="flex gap-4 p-4 border border-border rounded-lg">
                  <div className="flex-shrink-0">
                    <Users className="h-8 w-8 text-foreground" />
                  </div>
                  <div className="flex-grow">
                    <h3 className="font-semibold text-lg mb-2 flex items-center gap-2">
                      One-on-One Consultations
                      <Badge variant="secondary">Per Session</Badge>
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Personalized expert guidance sessions tailored to your
                      specific needs. Duration typically ranges from 30 minutes
                      to 2 hours.
                    </p>
                    <p className="text-sm">
                      <strong>Pricing:</strong> Varies by consultant expertise
                      and session duration. Consultants set their own rates.
                    </p>
                  </div>
                </div>

                {/* Classes */}
                <div className="flex gap-4 p-4 border border-border rounded-lg">
                  <div className="flex-shrink-0">
                    <Calendar className="h-8 w-8 text-foreground" />
                  </div>
                  <div className="flex-grow">
                    <h3 className="font-semibold text-lg mb-2 flex items-center gap-2">
                      Live Interactive Classes
                      <Badge variant="secondary">Course-based</Badge>
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Group learning sessions with scheduled appointments.
                      Includes multiple sessions over weeks or months, course
                      materials, and certificates.
                    </p>
                    <p className="text-sm">
                      <strong>Pricing:</strong> Varies by course duration,
                      number of sessions, and consultant expertise. Full course
                      payment required at enrollment.
                    </p>
                  </div>
                </div>

                {/* Webinars */}
                <div className="flex gap-4 p-4 border border-border rounded-lg">
                  <div className="flex-shrink-0">
                    <Video className="h-8 w-8 text-foreground" />
                  </div>
                  <div className="flex-grow">
                    <h3 className="font-semibold text-lg mb-2 flex items-center gap-2">
                      Webinars & Workshops
                      <Badge variant="secondary">Event-based</Badge>
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Large-scale educational events and workshops on specific
                      topics. Typically 1-3 hours long with Q&A sessions.
                    </p>
                    <p className="text-sm">
                      <strong>Pricing:</strong> Generally more affordable than
                      1-on-1 sessions due to group participation. Set by event
                      organizer.
                    </p>
                  </div>
                </div>

                {/* Subscriptions */}
                <div className="flex gap-4 p-4 border border-border rounded-lg">
                  <div className="flex-shrink-0">
                    <Repeat className="h-8 w-8 text-foreground" />
                  </div>
                  <div className="flex-grow">
                    <h3 className="font-semibold text-lg mb-2 flex items-center gap-2">
                      Subscription Plans
                      <Badge variant="secondary">Recurring</Badge>
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Ongoing learning programs with recurring sessions.
                      Includes regular meetings, continuous support, and
                      progressive curriculum.
                    </p>
                    <p className="text-sm">
                      <strong>Pricing:</strong> Monthly or course-based
                      subscriptions. Varies by frequency of sessions and
                      duration of commitment.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Payment Information */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Payment Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h3 className="font-semibold mb-2">Accepted Payment Methods</h3>
                <p className="text-muted-foreground mb-2">
                  We accept a wide range of payment methods through our secure
                  payment partner, Razorpay:
                </p>
                <div className="flex flex-wrap gap-2">
                  {PRICING_DATA.paymentMethods.map((method) => (
                    <Badge key={method} variant="outline">
                      {method}
                    </Badge>
                  ))}
                </div>
              </div>
              <Separator />
              <div>
                <h3 className="font-semibold mb-2">Currency</h3>
                <p className="text-muted-foreground">
                  All prices are displayed in{" "}
                  <strong>INR (Indian Rupees)</strong> unless otherwise
                  specified.
                </p>
              </div>
              <Separator />
              <div>
                <h3 className="font-semibold mb-2">Security</h3>
                <p className="text-muted-foreground">
                  All payments are processed securely through Razorpay with
                  industry-standard encryption. Your payment information is
                  never stored on our servers.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* FAQ Section */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Frequently Asked Questions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                {PRICING_DATA.faqs.map((faq, index) => (
                  <AccordionItem key={index} value={`item-${index + 1}`}>
                    <AccordionTrigger>{faq.question}</AccordionTrigger>
                    <AccordionContent>
                      {faq.answer}
                      {faq.question.includes("refund") && (
                        <>
                          {" "}
                          Please refer to our{" "}
                          <Link
                            href="/refund"
                            className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                          >
                            Cancellation & Refund Policy
                          </Link>{" "}
                          for detailed information.
                        </>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </CardContent>
          </Card>

          {/* CTA Section */}
          <Card className="bg-secondary border-border shadow-elevation-2">
            <CardContent className="text-center py-8">
              <h3 className="text-fluid-2xl font-bold tracking-tight mb-4">
                Ready to Start Learning?
              </h3>
              <p className="text-muted-foreground mb-6 max-w-2xl mx-auto">
                Browse our consultants, explore their expertise, and find the
                perfect match for your learning goals. Transparent pricing,
                secure payments, quality education.
              </p>
              <div className="flex gap-4 justify-center flex-wrap">
                <Link href="/explore/experts">
                  <Button size="lg">Explore Experts</Button>
                </Link>
                <Link href="/explore/programs">
                  <Button size="lg" variant="outline">
                    Browse Programs
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
