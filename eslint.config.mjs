// ESLint flat config. Intentionally narrow: it enforces the project's hard rules
// on type-safety shortcuts rather than a broad style ruleset. These are the casts
// that risk surfacing runtime errors later (CLAUDE.md / project policy):
//   - no `any` (ever)
//   - no non-null assertions (`x!`)
//   - no `as unknown` / `as never` (and thus no `as unknown as T` double-cast)
//   - no `as any`
// When a cast is genuinely unavoidable, narrow to the specific type with a
// one-line `// eslint-disable-next-line ... -- <justification>`.

import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/protocols-gen/**"], // generated
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSUnknownKeyword",
          message: "`as unknown` is banned (it defeats type-checking; `as unknown as T` too). Type it properly, or eslint-disable with a justification.",
        },
        {
          selector: "TSAsExpression > TSNeverKeyword",
          message: "`as never` is banned (it bypasses argument type-checking). Type it properly, or eslint-disable with a justification.",
        },
        {
          selector: "TSAsExpression > TSAnyKeyword",
          message: "`as any` is banned. Type it properly, or eslint-disable with a justification.",
        },
      ],
    },
  },
];
