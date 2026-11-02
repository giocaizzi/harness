import { fileURLToPath } from "node:url";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export default defineConfig({
    ignores: ["**/*.mjs", "node_modules/**", "plugins/**/tests/**"],
}, {
    files: ["**/*.mts"],
    extends: [
        tseslint.configs.strictTypeChecked,
        tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
        parserOptions: {
            projectService: true,
            tsconfigRootDir: repoRoot,
        },
    },
});
