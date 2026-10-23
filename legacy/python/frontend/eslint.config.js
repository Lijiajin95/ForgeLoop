/**
 * ForgeLoop 前端 ESLint（flat config）：把 Python 侧的 lint 与结构规则按
 * TypeScript 适配后接在同一强度上。
 *
 * 对应关系（Python → TypeScript）：
 * - Ruff `E7`/`F`/`B` 等 → `@eslint/js` recommended + `typescript-eslint`
 *   `recommendedTypeChecked`（含类型信息的规则；等价于 Pyright 与 Ruff 的交集）
 * - Ruff `S` 子集（禁 eval/不安全反序列化）→ 本文件的 `no-restricted-syntax`
 *   （禁 `eval`、`new Function`、`innerHTML`/`outerHTML`/`insertAdjacentHTML` 注入；
 *   页面只允许 `textContent`，记录文本不得当 HTML 解析）
 * - Ruff `I`（isort）→ ESLint 的导入顺序由 Prettier 与 `no-duplicate-imports` 约束，
 *   模块边界另由 dependency-cruiser 强制（见 .dependency-cruiser.cjs）
 * - Ruff format + line-length 100 → Prettier（printWidth 100）
 * - 结构数值（函数 50、文件 500、复杂度 10、嵌套 4、参数 5、语句 50）→ 本文件底部，
 *   数值取自 quality-thresholds.json（与 config/quality-policy.toml 的 [frontend] 同值）。
 *
 * 结构数值与 Python 结构报告同为**审阅提示**（`warn`）：`make check` 不传
 * `--max-warnings=0`，因此它们可见但不阻断；正确性、类型、格式、边界与死代码仍为
 * `error` 硬门禁。
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

import thresholds from "./quality-thresholds.json" with { type: "json" };

const structure = thresholds.structure;

/** 浏览器侧安全子集：禁动态求值与把记录文本当 HTML 注入。 */
const BROWSER_SAFETY_SELECTORS = [
  {
    selector: "CallExpression[callee.name='eval']",
    message: "禁止 eval：记录文本与接口数据都不得当代码执行。",
  },
  {
    selector: "NewExpression[callee.name='Function']",
    message: "禁止 new Function：等价于动态求值。",
  },
  {
    selector: "CallExpression[callee.name='setTimeout'][arguments.0.type='Literal']",
    message: "setTimeout 不接受字符串代码（等价于 eval）。",
  },
  {
    selector: "AssignmentExpression[left.property.name='innerHTML']",
    message: "禁止写 innerHTML：记录文本必须用 textContent，避免注入。",
  },
  {
    selector: "AssignmentExpression[left.property.name='outerHTML']",
    message: "禁止写 outerHTML：记录文本必须用 textContent，避免注入。",
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: "禁止 insertAdjacentHTML：记录文本必须用 textContent，避免注入。",
  },
];

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      ".stryker-tmp/**",
      "reports/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // 只用 TS 文件启用「需要类型信息」的规则：eslint.config.js 等 JS 配置不在
    // tsconfig 工程内，交给下面的 disableTypeChecked 块（同 EvidHist 的处理）。
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // 配置脚本是 Node 侧代码，不做类型信息规则（同 EvidHist 的处理）。
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...BROWSER_SAFETY_SELECTORS],
      // 页面代码运行在浏览器里：不得引用 Node 内置模块。
      "no-restricted-imports": [
        "error",
        { patterns: ["node:*", "fs", "path", "child_process", "os", "url"] },
      ],
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // 结构数值：审阅提示（warn），只作用于手写前端源码。
    files: ["src/**/*.ts"],
    rules: {
      "max-lines-per-function": [
        "warn",
        {
          max: structure.functionLinesMax,
          skipBlankLines: structure.functionLinesSkipBlankLines,
          skipComments: structure.functionLinesSkipComments,
          IIFEs: true,
        },
      ],
      "max-lines": ["warn", { max: structure.fileLinesMax }],
      complexity: ["warn", structure.complexityMax],
      "max-depth": ["warn", structure.depthMax],
      "max-params": ["warn", structure.paramsMax],
      "max-statements": ["warn", structure.statementsMax],
    },
  },
  {
    files: ["tests/**/*.ts", "*.config.ts", "*.config.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
);
