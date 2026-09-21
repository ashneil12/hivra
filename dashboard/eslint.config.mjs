import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import reactPlugin from "eslint-plugin-react";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next.nosync/**",
    "out/**",
    "build/**",
    "coverage/**",
    ".jest-cache/**",
    ".vercel/**",
    "next-env.d.ts",
    "**/*.bak",
    "**/eslint-errors.txt",
    "**/eslint_output.txt",
    "**/eslint_report.json",
    "**/lint-results.json",
    "**/lint_output.txt",
    "**/test_failures.txt",
    "**/check_*.ts",
    "**/decrypt.py",
    "**/fix_*.js",
    "**/fix_*.py",
    "**/fix_*.ts",
    "**/replace-text.js",
    "**/get_key.py",
    "**/scratch.js",
    "**/scratch.py",
    "**/test-db.js",
    "**/test-db.ts",
    "**/test-sidecar.js",
    "**/test_db.ts",
    "**/test_decrypt.ts",
    "**/test_script.ts",
    "**/deploy_key",
    "**/temp_key",
  ]),
  {
    plugins: {
      react: reactPlugin,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "warn",
      "react/no-unescaped-entities": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      // Direct console.* calls go through Vercel Logs unstructured. Use the
      // `log` from "@/lib/logger" (server) or `clientLog` from
      // "@/lib/client/logger" (client) so every entry has source/route/userId
      // and 5xx errors are mirrored to ops_events. Default is "warn" so a
      // historical call in a UI component doesn't block lint; the override
      // below upgrades server code (API routes + lib) to "error" since
      // those have been fully migrated.
      "no-console": "warn",
    }
  },
  {
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "no-console": "off",
    },
  },
  {
    // Server code has been fully migrated to the structured logger — any new
    // console.* call in API routes or non-client lib code should fail lint.
    files: [
      "**/src/app/api/**/*.ts",
      "**/src/app/api/**/*.tsx",
      "**/src/lib/**/*.ts",
      "**/src/lib/**/*.tsx",
    ],
    ignores: [
      "**/src/lib/client/**",
      "**/src/lib/logger.ts",
      "**/src/lib/services/sidecar-script.ts",
      "**/__tests__/**",
      "**/__mocks__/**",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-console": "error",
    },
  },
  {
    // The logger modules are the canonical place where console.* lives.
    // Tests need to spy on console.error/warn, and ops scripts (the *.ts
    // files under scripts/) intentionally write to stdout. sidecar-script.ts
    // is not a Node module — it's a string template that ships to and runs
    // on remote agent hosts where the dashboard's logger is not available.
    files: [
      "**/src/lib/logger.ts",
      "**/src/lib/client/logger.ts",
      "**/src/lib/services/sidecar-script.ts",
      "**/__tests__/**",
      "**/__mocks__/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/scripts/**",
    ],
    rules: {
      "no-console": "off",
    },
  }
]);

export default eslintConfig;
