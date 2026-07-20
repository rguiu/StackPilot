export default {
  "*.{ts,js,mjs,cjs}": ["eslint --fix", "prettier --write"],
  // Note: no `toml` here — prettier has no TOML parser and errors when handed
  // an explicit .toml path (it silently skips them only in whole-dir runs).
  "*.{json,md}": ["prettier --write"],
};
