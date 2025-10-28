module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: false,
    tsconfigRootDir: __dirname,
  },
  plugins: ["@typescript-eslint", "import"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "plugin:import/recommended", "plugin:import/typescript", "prettier"],
  env: {
    es2022: true,
    node: true
  },
  rules: {
    "import/order": [
      "warn",
      {
        "alphabetize": { "order": "asc", "caseInsensitive": true },
        "newlines-between": "always"
      }
    ]
  },
  ignorePatterns: ["dist", "var"]
};
