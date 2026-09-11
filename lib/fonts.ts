import { Sora } from "next/font/google";

/**
 * The app's single font instance.
 *
 * `next/font` generates a separately-hashed family per call site, so calling
 * `Sora()` in more than one module yields two different families (and two
 * fallback-metric faces) that render subtly differently. Every surface that
 * owns an `<html>/<body>` pair — the root layout and `global-error` — imports
 * this one instance instead of declaring its own.
 */
export const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap",
});
