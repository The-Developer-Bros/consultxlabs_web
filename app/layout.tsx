import AnnouncementBar from "@/components/AnnouncementBar";
import MaintenanceBanner from "@/components/banners/MaintenanceBanner";
import CookieConsentBanner from "@/components/CookieConsent";
import Footer from "@/components/Footer";
import HeaderSpacer from "@/components/HeaderSpacer";
import Navbar from "@/components/Navbar";
import NavigationProgress from "@/components/NavigationProgress";
import { Toaster } from "@/components/ui/toaster";
import { AnnouncementBarProvider } from "@/providers/AnnouncementBarProvider";
import AuthSyncProvider from "@/providers/AuthSyncProvider";
import { MaintenanceProvider } from "@/providers/MaintenanceProvider";
import ReactQueryProvider from "@/providers/ReactQueryProvider";
import type { Metadata, Viewport } from "next";

import { sora } from "@/lib/fonts";

import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const SITE_DESCRIPTION =
  "Connect with world-class experts for 1-on-1 sessions, classes, webinars, and personalized career guidance. Transform your career with Familiarise.";
const SITE_TITLE = "Familiarise | Expert Consultations & Career Mentorship";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  keywords: [
    "consulting",
    "mentorship",
    "career guidance",
    "expert sessions",
    "webinars",
    "professional development",
  ],
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: "website",
    url: "/",
    siteName: "Familiarise",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
};

// Intentionally NO server-side session read here. Calling getSession() invokes
// headers(), which forces the ENTIRE app to render dynamically — so even the
// loading.tsx skeletons had to wait on a (cold) server render, which is why a
// soft navigation sat blank for ~20-30s before the skeleton appeared. Keeping
// the root layout static lets the shell + loading skeletons prefetch and paint
// instantly; the Navbar hydrates the session client-side via useSession(), and
// AuthSyncProvider keeps it live. The brief first-paint unknown state is shown
// as a neutral placeholder in the Navbar rather than a signed-out flash. (#932)
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={sora.variable}>
      <body
        className={`${sora.className} flex flex-col min-h-svh antialiased`}
      >
        <ReactQueryProvider>
          <AuthSyncProvider />
          <MaintenanceProvider>
            <AnnouncementBarProvider>
              <NavigationProgress />
              <Toaster />
              <MaintenanceBanner />
              <AnnouncementBar />
              <Navbar />
              <HeaderSpacer />
              <div className="flex-1 w-full">{children}</div>
              <Footer />
            </AnnouncementBarProvider>
            <CookieConsentBanner />
          </MaintenanceProvider>
        </ReactQueryProvider>
      </body>
    </html>
  );
}
