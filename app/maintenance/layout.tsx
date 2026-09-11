import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Maintenance | Familiarise",
  description: "We're improving things. We'll be back shortly.",
  robots: { index: false, follow: false },
};

// `app/maintenance/` is a plain nested segment, not a route group, so this
// layout renders *inside* the root layout's <body>. It previously returned its
// own <html>/<body> (plus a second `Sora()` call): the browser discarded the
// nested pair and the duplicate font, leaving this route — which middleware can
// rewrite ANY url to during a maintenance window — on a different Sora instance
// than the rest of the app.
export default function MaintenanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
