"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Mail, Phone, Clock, MessageSquare } from "lucide-react";
import { ContactForm } from "./ContactForm";
import {
  COMPANY_INFO,
  PAGE_META,
  BUSINESS_HOURS,
  SUPPORT_LINKS,
  getMailtoLink,
  getTelLink,
} from "../constants";

export default function ContactUsPage() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <div className="flex justify-center mb-4">
            <MessageSquare className="h-16 w-16 text-foreground" />
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            {PAGE_META.contact.title}
          </h1>
          <p className="text-fluid-lg text-muted-foreground max-w-3xl mx-auto">
            {PAGE_META.contact.description}
          </p>
        </div>

        <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-8">
          {/* Contact Information */}
          <div className="space-y-6">
            <Card className="shadow-elevation-1">
              <CardHeader>
                <CardTitle className="text-fluid-2xl">Get in Touch</CardTitle>
                <CardDescription>
                  Our team is available to assist you with any inquiries
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Email */}
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <Mail className="h-5 w-5 text-foreground" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Email</h3>
                    <p className="text-sm text-muted-foreground">
                      General Inquiries:{" "}
                      <a
                        href={getMailtoLink()}
                        className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                      >
                        {COMPANY_INFO.email}
                      </a>
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Support:{" "}
                      <a
                        href={getMailtoLink(COMPANY_INFO.supportEmail)}
                        className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                      >
                        {COMPANY_INFO.supportEmail}
                      </a>
                    </p>
                  </div>
                </div>

                <Separator />

                {/* Phone */}
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <Phone className="h-5 w-5 text-foreground" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Phone</h3>
                    <p className="text-sm text-muted-foreground">
                      <a
                        href={getTelLink()}
                        className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                      >
                        {COMPANY_INFO.phone}
                      </a>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      (Available during business hours)
                    </p>
                  </div>
                </div>

                <Separator />

                {/* Business Hours */}
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <Clock className="h-5 w-5 text-foreground" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Business Hours</h3>
                    <p className="text-sm text-muted-foreground">
                      {BUSINESS_HOURS.weekdays}
                      <br />
                      {BUSINESS_HOURS.saturday}
                      <br />
                      {BUSINESS_HOURS.sunday}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Support Information */}
            <Card className="shadow-elevation-1">
              <CardHeader>
                <CardTitle>Support Resources</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Before contacting us, you may find answers to your questions
                  in our help resources:
                </p>
                <ul className="space-y-2">
                  {SUPPORT_LINKS.map((link) => (
                    <li key={link.href} className="text-sm">
                      <a
                        href={link.href}
                        className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                      >
                        • {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>

          {/* Contact Form */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">Send us a Message</CardTitle>
              <CardDescription>
                Fill out the form below and we'll get back to you as soon as
                possible
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ContactForm />
            </CardContent>
          </Card>
        </div>

        {/* Additional Information */}
        <div className="max-w-6xl mx-auto mt-8">
          <Card className="shadow-elevation-1">
            <CardContent className="p-6">
              <div className="grid md:grid-cols-3 gap-6 text-center">
                <div>
                  <h3 className="font-semibold mb-2">Quick Response</h3>
                  <p className="text-sm text-muted-foreground">
                    We aim to respond to all inquiries within 24-48 hours
                  </p>
                </div>
                <div>
                  <h3 className="font-semibold mb-2">Professional Support</h3>
                  <p className="text-sm text-muted-foreground">
                    Our dedicated team is here to assist with any questions
                  </p>
                </div>
                <div>
                  <h3 className="font-semibold mb-2">Multiple Channels</h3>
                  <p className="text-sm text-muted-foreground">
                    Reach us via email, phone, or contact form
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
