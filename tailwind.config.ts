import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  // `lib/` and `utils/` hold class strings too — the slot palette, appointment
  // status badges, session and org labels, document icons. Tailwind only emits
  // a utility it has SEEN in a scanned file, so every one of those was being
  // dropped from the stylesheet unless the same class happened to appear under
  // components/ or app/ as well. That is what made grid cells painted from
  // `lib/scheduling/slot-status-tokens` render with no fill and no border at
  // all — not faint, absent (#1064).
  content: [
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
    "./utils/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sora)", "system-ui", "sans-serif"],
        display: ["var(--font-sora)", "system-ui", "sans-serif"],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
        "gradient-silver":
          "linear-gradient(135deg, #ffffff, #d4d4d4, #a3a3a3, #d4d4d4, #ffffff)",
        "gradient-dark": "linear-gradient(135deg, #0a0a0a, #1f1f1f, #0a0a0a)",
        "gradient-metallic":
          "linear-gradient(145deg, #2a2a2a 0%, #1a1a1a 50%, #0f0f0f 100%)",
        "gradient-steel": "linear-gradient(180deg, #3f3f46, #27272a, #18181b)",
      },
      screens: {
        sm: "640px",
        md: "768px",
        lg: "1024px",
        xl: "1280px",
        "2xl": "1400px",
        landscape: { raw: "(orientation: landscape)" },
        portrait: { raw: "(orientation: portrait)" },
        "landscape-compact": {
          raw: "(orientation: landscape) and (max-height: 500px)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "calc(var(--radius) + 4px)",
        "2xl": "calc(var(--radius) + 8px)",
      },
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        error: {
          DEFAULT: "hsl(var(--error))",
          foreground: "hsl(var(--error-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        chart: {
          "1": "hsl(var(--chart-1))",
          "2": "hsl(var(--chart-2))",
          "3": "hsl(var(--chart-3))",
          "4": "hsl(var(--chart-4))",
          "5": "hsl(var(--chart-5))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      fontSize: {
        // Fluid type scale — additive keys (text-fluid-*); defaults untouched
        "fluid-xs": ["var(--fs-xs)", { lineHeight: "1.5" }],
        "fluid-sm": ["var(--fs-sm)", { lineHeight: "1.5" }],
        "fluid-base": ["var(--fs-base)", { lineHeight: "1.6" }],
        "fluid-lg": ["var(--fs-lg)", { lineHeight: "1.5" }],
        "fluid-xl": [
          "var(--fs-xl)",
          { lineHeight: "1.4", letterSpacing: "-0.01em" },
        ],
        "fluid-2xl": [
          "var(--fs-2xl)",
          { lineHeight: "1.3", letterSpacing: "-0.015em" },
        ],
        "fluid-3xl": [
          "var(--fs-3xl)",
          { lineHeight: "1.2", letterSpacing: "-0.02em" },
        ],
        "fluid-4xl": [
          "var(--fs-4xl)",
          { lineHeight: "1.1", letterSpacing: "-0.02em" },
        ],
        "fluid-5xl": [
          "var(--fs-5xl)",
          { lineHeight: "1.05", letterSpacing: "-0.025em" },
        ],
      },
      boxShadow: {
        // Dark-mode-aware elevation — additive keys (shadow-elevation-*)
        "elevation-1":
          "0 1px 2px -1px hsl(var(--shadow-color) / 0.08), 0 1px 3px hsl(var(--shadow-color) / 0.05)",
        "elevation-2":
          "0 2px 4px -2px hsl(var(--shadow-color) / 0.1), 0 4px 8px -2px hsl(var(--shadow-color) / 0.06)",
        "elevation-3":
          "0 8px 16px -4px hsl(var(--shadow-color) / 0.12), 0 16px 32px -8px hsl(var(--shadow-color) / 0.08)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
export default config;
