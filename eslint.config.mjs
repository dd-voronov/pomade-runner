// Flat-config typescript-eslint, type-aware, the Pomade family's approach: no preset wholesale,
// hand-picked rules for silent bug classes (floating/misused promises, unused bindings, duplicate
// imports), React's hook rules on the UI and Playwright's missing-await family on the e2e specs.
// Each glob is checked against exactly one tsconfig program.
import playwright from "eslint-plugin-playwright";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const tsconfigRootDir = import.meta.dirname;

const baseHygieneRules = {
  "no-var": "error",
  "prefer-const": "error",
  "prefer-rest-params": "error",
  "prefer-spread": "error",
  "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
};

const typeAwareRules = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/switch-exhaustiveness-check": "error",
  "@typescript-eslint/no-unnecessary-condition": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
  ],
  "@typescript-eslint/no-explicit-any": "error",
};

function typeAware(project) {
  return {
    languageOptions: { parser: tseslint.parser, parserOptions: { project: [project], tsconfigRootDir } },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: { ...baseHygieneRules, ...typeAwareRules },
  };
}

const ui = typeAware("tsconfig.ui.json");
const e2e = typeAware("tsconfig.e2e.json");

export default tseslint.config(
  { ignores: ["dist/**", "test-results/**", "playwright-report/**", "prototype/**", "**/*.d.ts"] },
  tseslint.configs.base,
  { name: "pomade-runner/scripts", files: ["eslint.config.mjs", "scripts/**/*.mjs"], rules: baseHygieneRules },
  {
    name: "pomade-runner/node",
    files: ["src/**/*.ts", "vite.config.ts", "vitest.config.ts", "playwright.config.ts"],
    ignores: ["src/ui/**"],
    ...typeAware("tsconfig.json"),
  },
  {
    name: "pomade-runner/ui",
    files: ["src/ui/**/*.{ts,tsx}", "e2e/harness/**/*.ts"],
    ...ui,
    plugins: { ...ui.plugins, "react-hooks": reactHooks },
    rules: { ...ui.rules, "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
  {
    name: "pomade-runner/e2e",
    files: ["e2e/**/*.ts"],
    ignores: ["e2e/harness/**"],
    ...e2e,
    plugins: { ...e2e.plugins, playwright },
    rules: { ...e2e.rules, ...playwright.configs["flat/recommended"].rules },
  },
);
