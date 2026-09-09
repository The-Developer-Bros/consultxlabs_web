import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginNext from "@next/eslint-plugin-next";
import pluginJest from "eslint-plugin-jest";
import pluginUnusedImports from "eslint-plugin-unused-imports";

/** @type {import('eslint').Linter.Config[]} */
export default [
  // Ignore patterns
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "out/**",
      "coverage/**",
      "public/static/**",
      "update-postman-collection.ts",
    ],
  },

  // Jest test files configuration
  {
    files: ["**/*.{test,spec}.{js,ts,jsx,tsx}", "jest.setup.ts"],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    plugins: {
      jest: pluginJest,
    },
    rules: {
      ...pluginJest.configs.recommended.rules,
    },
  },

  // Base config for all JavaScript/TypeScript files. `mts`/`cts` included so
  // netlify/functions/*.mts (#1356 — the scheduled ticker) is linted rather
  // than silently skipped; it was previously the only extension this repo
  // ships that fell through every `files` glob below.
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "unused-imports": pluginUnusedImports,
    },
  },

  // Core JavaScript rules
  pluginJs.configs.recommended,

  // TypeScript rules
  ...tseslint.configs.recommended,

  // React specific configuration
  {
    ...pluginReact.configs.flat.recommended,
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      ...pluginReact.configs.flat.recommended.plugins,
      "react-hooks": pluginReactHooks,
      "@next/next": pluginNext,
    },
    rules: {
      // Warns when let is used where const could be used instead
      "prefer-const": "warn",

      // Warns when var is used instead of let or const
      "no-var": "warn",

      // Warn about lexical declarations in case blocks without braces
      "no-case-declarations": "warn",

      // Enforce === and !== over == and !=
      eqeqeq: "warn",

      // React hooks rules
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // Disabled — TypeScript handles prop validation
      "react/prop-types": "off",

      // Disabled — React 17+ JSX transform doesn't require importing React
      "react/jsx-uses-react": "off",
      "react/react-in-jsx-scope": "off",

      // Next.js specific rules
      ...pluginNext.configs.recommended.rules,

      // Warn when empty object types are used (e.g. 'type Foo = {}')
      "@typescript-eslint/no-empty-object-type": "warn",

      // Warn when the 'any' type is used explicitly
      "@typescript-eslint/no-explicit-any": "warn",

      // Warn when using require() instead of ES6 imports
      "@typescript-eslint/no-require-imports": "warn",

      // Disable the built-in no-unused-vars rule as unused-imports will handle it
      "@typescript-eslint/no-unused-vars": "off",

      // Configure unused-imports plugin for auto-fixing
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_", // Ignore variables starting with _
          argsIgnorePattern: "^_", // Ignore parameters starting with _
          caughtErrorsIgnorePattern: "^_", // Ignore catch clause errors starting with _
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Seed files: allow control character regex (intentional sanitization for PostgreSQL)
  {
    files: ["prisma/seedFiles/**/*.ts"],
    rules: {
      "no-control-regex": "off",
    },
  },

  // k6 load scripts. These never run under Node or in a browser — the k6
  // runtime injects `__ENV`, `__VU` and `__ITER` as globals and resolves the
  // `k6/*` module specifiers itself. Without this block every script reports
  // `no-undef` on those three names, which is how `load-tests/smoke.js` came
  // to carry four standing ESLint errors.
  {
    files: ["load-tests/**/*.js"],
    languageOptions: {
      globals: {
        __ENV: "readonly",
        __VU: "readonly",
        __ITER: "readonly",
      },
    },
  },

  // Layering: `app/` is the routing layer. It may depend on lib, components,
  // hooks, types and schemas — never the reverse.
  //
  // This regressed silently more than once before it was enforced. A shared
  // component ended up importing a calendar and a slot-allocation hook from
  // `app/dashboard/consultant/[consultantId]/(features)/shared/`, through a
  // dynamic route segment; `lib/dashboard-queries.ts` pulled types out of two
  // route folders; and `lib/data/explore-programs.ts` imported live functions
  // from `app/explore`. Each was reasonable in isolation and each made the
  // importing layer impossible to reuse or extract without dragging routing
  // along with it.
  //
  // If a route folder holds something genuinely shared, the answer is to move
  // it out — that is where `components/scheduling`, `hooks/scheduling`,
  // `lib/scheduling` and `lib/explore` came from. For an API response shape,
  // put it in `schemas/` and let both sides derive from one Zod definition.
  {
    files: [
      "lib/**/*.{ts,tsx}",
      "components/**/*.{ts,tsx}",
      "hooks/**/*.{ts,tsx}",
      "types/**/*.{ts,tsx}",
      "schemas/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Both spellings. The alias form is what anyone would normally
              // write, but `../../app/...` resolves to exactly the same module
              // and would have walked straight past an alias-only rule.
              group: [
                "@/app/*",
                "@/app/**",
                "**/app/dashboard/**",
                "**/app/api/**",
                "**/app/explore/**",
              ],
              message:
                "Do not import from app/ here — app/ is the routing layer and must depend on these layers, not the reverse. Move the shared code into lib/, components/, hooks/ or types/, or put the response shape in schemas/ and derive both sides from it.",
            },
          ],
        },
      ],
    },
  },
];
