# The public-surface refresh: fabricated content, duplicated layouts, and a stylesheet that had stopped being legible

**Date:** 2026-09-06 · **Branch:** `fix/explore-landing-ui-refresh` · **Scope:** the landing page (`/`), both explore listings (`/explore/experts`, `/explore/programs`), the expert profile (`/explore/experts/[consultantId]`), and the four plan detail page types under `/explore/programs/plans/**`.

This entry records what a "modernize the public pages" ask turned into once the pages were actually read end to end: not a restyle, but the discovery that several sections were showing visitors things that were not true, that four page families had each built their own copy of the same layout, and that the stylesheet backing all of it had grown past the point where anyone could tell which rule mattered. It is written so the next person to touch these routes does not have to re-derive why a component disappeared or why a utility class no longer exists.

## The reported ask

The landing page and the explore surfaces looked dated and inconsistent with each other — animated blobs on some sections, flat cards on others, a different card shape for an expert than for a program, four separate implementations of what a plan detail page's hero should look like. The ask was to bring these five surfaces onto one coherent visual language. What that turned into, once the components were opened rather than just screenshotted, was a larger job: several of the sections being redesigned were not decorative, they were dishonest.

## What was found

### Fabricated content

Four landing sections and one shared component existed to show the visitor something that had never happened. `SUCCESS_STORIES` and the `SatisfiedTestimonial` component it rendered through were three invented reviewers with invented quotes; nothing in the data model backed any of them. `UPCOMING_EVENTS` was a hardcoded array of webinars dated December 2025, still labelled "upcoming" in a build running in September 2026 — the section had quietly become a page about the past. `TrustBadgesSection` asserted claims about the platform that had no source. None of these were rendering bugs to fix; they were content nobody had reviewed for truth since the mock data behind them was left in place after real data arrived elsewhere on the page.

### Templated filler standing in for real profile data

`AboutSection` on the expert profile filled every empty field with one of two templated sentences — "X is a seasoned … expert" or "has extensive experience across multiple industries" — regardless of what the expert had actually written. Every plan detail page printed "An experienced professional dedicated to sharing knowledge and expertise." under its instructor, host, expert or mentor unconditionally, whether or not that person had a real headline on file. Expert cards printed a literal "Headline: Not specified" row when an expert had left the field blank, rather than omitting the row. The webinar detail page defaulted to "Platform: Zoom" even though every session on the platform runs in its own video room — nobody had ever hosted a webinar on Zoom, so the fallback was pure fiction with no live code path that could make it true.

### Four independent copies of two layouts

The experts listing and the programs listing each had their own hero, their own "browse by category" tile grid (`DomainGrid.tsx` and `CategoryGrid.tsx`, which differed only in an icon and a count noun), their own section header, and their own segmented toggle control. The four plan detail page types — class, webinar, consultation, subscription — had each built an independent hero band, an independent instructor card, and mostly-duplicated content sections, even though class and webinar detail were already near-identical to each other before this work started. None of this duplication was wrong on its own, but every future change to "how a hero looks" or "how an instructor card renders" would have needed to land in four or five places to stay consistent, and evidently already had not.

### A stylesheet that had stopped being legible

`app/globals.css` carried 1466 lines, and a large fraction of them were single-purpose: `.metallic-gradient`, `.mesh-gradient-dark`, `.gradient-border`, `.noise-overlay`, `.orb-silver`, `.bg-obsidian` and dozens more, each written for one section that had since been rewritten or removed, with no remaining caller. Reading the file gave no signal about which rule was structural (a scrollbar reset, a Stream override) and which was one abandoned decorative idea. The reduced-motion media query at the bottom of the file had drifted the same way, referencing classes that content had already stopped using.

## What was done, per surface

**Landing page.** `app/page.tsx` went from sixteen sections to ten: `HeroSection`, `TrustedBySection`, `FeaturesSection` (with its capabilities list trimmed), `CategoriesSection`, `FeaturedExpertsSection`, `BenefitsSection`, `TestimonialsSection`, `HowItWorksSection`, a new `AudienceSplitSection`, and `FAQSection`. `AudienceSplitSection` (`components/home/AudienceSplitSection.tsx`) replaces the old `EnterpriseSection` and `BecomeExpertSection`: the organisation pitch and the expert pitch now sit side by side in one row instead of as two separate full-width bands. `SectionIntro` (`components/home/SectionIntro.tsx`) became the one implementation of the eyebrow/heading/lede block every section opens with, and it is where the single scroll-reveal preset and its stagger helper now live. `SuccessStoriesSection.tsx`, `UpcomingEventsSection.tsx`, `TrustBadgesSection.tsx`, `PlatformFeaturesSection.tsx`, `BecomeExpertSection.tsx`, `EnterpriseSection.tsx` and `SatisfiedTestimonial.tsx` were deleted.

**Explore listings.** `ExploreHero`, `SectionHeader`, `SegmentedControl` and `TaxonomyGrid` (all new, under `app/explore/components/`) are now shared by both `/explore/experts` and `/explore/programs`. `TaxonomyGrid` replaced the two near-duplicate tile grids, `DomainGrid.tsx` and `CategoryGrid.tsx`, both of which were deleted, along with the programs listing's own redundant `FilterChips.tsx` and `SectionHeader.tsx`.

**Expert cards and profile.** `ConsultantCard` (`app/explore/experts/components/ConsultantCard.tsx`) was rebuilt around the honesty rule: a headline renders only when the expert wrote one, and there is no longer a "Headline: Not specified" placeholder row. On the profile page, `ExpertProfileClient.tsx` keeps one dark surface — the booking panel — as the single anchored dark card on an otherwise light page, and the 4:3 portrait that used to sit above that panel was removed because it duplicated the photo already shown in `ProfileHeader`. `AboutSection.tsx` was rewritten to render only what the expert actually wrote and to return `null` entirely when there is nothing to show, replacing the two templated sentences described above.

**Plan detail pages.** Four new shared components under `app/explore/programs/plans/components/` — `PlanHero`, `PlanExpertCard`, `PlanDetailBody`, `FeatureItem` — now back all four plan types. `PlanHero` gives a class or webinar an image cover under a scrim and gives a consultation or subscription the same band on a plain dark stage, so the four read as one family. `PlanExpertCard` is where the hardcoded "An experienced professional dedicated to sharing knowledge and expertise." line was removed; it now renders the person's real headline and experience, or neither. `WebinarDetails.tsx` no longer falls back to "Platform: Zoom".

## The CSS prune

`app/globals.css` went from 1466 lines to 714. Fifty-nine dead utility classes and twelve orphaned `@keyframes` blocks were removed — the decorative families named in the design-language document (`gradient-text`, `metallic-*`, `mesh-gradient*`, `glow*`, `noise-overlay`, `orb-*`, `diagonal-stripes` and their neighbours) plus a handful of scrollbar and focus-ring helpers that had lost their last caller during earlier refactors. The `prefers-reduced-motion` block was rewritten to reference only the two animated classes that remain in use, `.animate-blob` and the two marquee directions, rather than a longer list that had drifted out of sync with the content. `animate-blob` and `grid-pattern*` themselves were kept, because `app/enterprise/_components/EnterpriseSections.tsx`, `app/use-cases/UseCaseSections.tsx`, the organisations page, the become-an-expert page and `components/Footer.tsx` still use them and none of those surfaces were in scope for this pass.

## Verification

Every one of the 71 changed files passes `npx prettier --check` and `npx eslint` with zero findings, in line with the CI gate that treats an ESLint warning as a blocking failure on this codebase. A full cold `tsc --noEmit` was run rather than relying on the warm incremental cache, and it passes. The `__tests__/explore` and `__tests__/plans` suites — including `isr-routes-never-fail-open.test.ts`, which greps the page files for the `revalidate` / `force-dynamic` / `withBuildTimeRetry` exports this refresh was required to preserve — were run and pass. No data loader, hook, or API call was touched anywhere in this diff; every change is confined to JSX layout and class names, and the ISR contracts on `app/page.tsx`, `app/explore/experts/page.tsx` and the plan detail pages are exactly what they were before this branch started.

## What was deliberately not done

`/enterprise`, `/use-cases`, `/explore/community`, `/explore/enterprise/organisations`, the become-an-expert page and `components/Footer.tsx` were left exactly as they were. Bringing them onto this design language is future work, tracked as scope for a later pass rather than folded into this one.

PR #1213 (`fix/ui-overhaul`), an open and unrelated pull request pursuing a motion-heavy direction for several of these same routes, was not rebased forward or merged with this work. It is 237 commits behind `dev`, still renders the pre-#1490 hardcoded landing statistics, and its direction — smooth-scroll, cursor-tracking effects, word-by-word reveals, tilt cards — is the opposite of the quiet-monochrome language this refresh adopted. This branch supersedes its direction rather than reconciling with it; whether to close #1213 outright is left to the owner, and the reasoning is recorded in full in the accompanying ADR.

PR #1229 (booking calendar), which is open concurrently and edits `ExpertProfileClient`'s data logic, `ConsultationPricingToggle`, and one sticky-class line in `ExpertPricing`, was accounted for rather than avoided: this refresh touched only the JSX layout of the same files, adopted #1229's exact sticky className instead of introducing a second one, and left both pricing toggle components untouched so the two branches can merge in either order without a conflict in shared logic.

Neither the enterprise/use-case/organisations/community pages nor `components/Footer.tsx` had their `animate-blob` or `grid-pattern*` usage removed from `app/globals.css`, for the reason given in the CSS prune section above: doing so would have broken pages this pass did not redesign.

## Related

- [ADR: quiet monochrome public surfaces](../decisions/2026-09-06-quiet-monochrome-public-surfaces.md) — the decision record: the design language, the honesty rule, the motion policy, and the relationship to PR #1213 and PR #1229.
- [Public surfaces design language](02-public-surfaces-design-language.md) — the rule set and the component map future work on these routes should read first.
