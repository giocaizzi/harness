import tseslint from "typescript-eslint";
export default tseslint.config({
    ignores: ["**/*.mjs", "node_modules/**", "plugins/**/tests/**"],
}, {
    files: ["src/**/*.mts"],
    extends: [
        tseslint.configs.strictTypeChecked,
        tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
        parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
        },
    },
});
