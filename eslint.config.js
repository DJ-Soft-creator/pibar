// Lint rules for the TypeScript UI (src/). Rust is checked by `cargo clippy`.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "src-tauri/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: globals.browser },
    rules: {
      // Pi events are dynamic JSON; `any` is deliberately allowed there
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["dev/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
);
