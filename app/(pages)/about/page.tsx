"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Users, Target, Award, BookOpen } from "lucide-react";
import {
  COMPANY_INFO,
  PAGE_META,
  ABOUT_DATA,
  getMailtoLink,
} from "../constants";

export default function AboutPage() {
  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Hero Section */}
        <div className="text-center mb-12">
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            {PAGE_META.about.title}
          </h1>
          <p className="text-fluid-lg text-muted-foreground max-w-3xl mx-auto">
            {PAGE_META.about.description}
          </p>
        </div>

        {/* Main Content */}
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Mission & Vision */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Target className="h-6 w-6 text-foreground" />
                <CardTitle className="text-fluid-2xl">
                  Our Mission & Vision
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h3 className="font-semibold text-lg mb-2">Mission</h3>
                <p className="text-muted-foreground">{ABOUT_DATA.mission}</p>
              </div>
              <Separator />
              <div>
                <h3 className="font-semibold text-lg mb-2">Vision</h3>
                <p className="text-muted-foreground">{ABOUT_DATA.vision}</p>
              </div>
            </CardContent>
          </Card>

          {/* What We Offer */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <div className="flex items-center gap-2">
                <BookOpen className="h-6 w-6 text-foreground" />
                <CardTitle className="text-fluid-2xl">What We Offer</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-6">
                {ABOUT_DATA.offerings.map((offering) => (
                  <div key={offering.title} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{offering.title}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {offering.description}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* How It Works */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Users className="h-6 w-6 text-foreground" />
                <CardTitle className="text-fluid-2xl">How It Works</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {ABOUT_DATA.howItWorks.map((item) => (
                  <div key={item.step} className="flex gap-4">
                    <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold">
                      {item.step}
                    </div>
                    <div>
                      <h4 className="font-semibold mb-1">{item.title}</h4>
                      <p className="text-sm text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Platform Benefits */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Award className="h-6 w-6 text-foreground" />
                <CardTitle className="text-fluid-2xl">
                  Why Choose Familiarise
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4">
                {ABOUT_DATA.benefits.map((benefit) => (
                  <div key={benefit.title} className="flex items-start gap-2">
                    <div className="text-green-600 mt-1">✓</div>
                    <div>
                      <p className="font-semibold">{benefit.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {benefit.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Company Information */}
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">
                Company Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Business Name
                </p>
                <p>{COMPANY_INFO.name}</p>
              </div>
              <Separator />
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Contact Email
                </p>
                <p>
                  <a
                    href={getMailtoLink()}
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    {COMPANY_INFO.email}
                  </a>
                </p>
              </div>
              <Separator />
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Support
                </p>
                <p>
                  For any questions or support, please{" "}
                  <a
                    href="/contactus"
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    contact us
                  </a>
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
