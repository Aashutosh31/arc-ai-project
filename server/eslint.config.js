module.exports = {
  ignores: ['node_modules/', 'dist/', 'tests/**', '*.test.js', '*.test.mjs', '.whatsapp-sessions/**'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
    globals: {
      console: 'readonly',
      process: 'readonly',
      Buffer: 'readonly',
      __dirname: 'readonly',
      __filename: 'readonly',
      module: 'readonly',
      require: 'readonly',
      exports: 'readonly',
      global: 'readonly',
      setTimeout: 'readonly',
      clearTimeout: 'readonly',
      setInterval: 'readonly',
      clearInterval: 'readonly',
    },
  },
  rules: {
    // Style rules are warnings: the pre-existing codebase carries ~700
    // brace-style/`==` findings that predate this linter. Surfacing them
    // without failing CI keeps the gate usable; new code should still
    // follow the strict forms.
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-console': 'warn',
    'prefer-const': 'warn',
    'no-var': 'error',
    'eqeqeq': ['warn', 'always'],
    'curly': ['warn', 'all'],
  },
};