const globals = require('globals');

const correctness = {
  'no-undef': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-class-members': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-async-promise-executor': 'error',
  'no-constant-binary-expression': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      '.cache/**',
      'dist*/**',
      'assets/**',
      'claude-code-ref/**',
      '.cibyp-test-fixtures-*/**',
      'src/renderer/js/app.js',
      'src/preload/generated/**',
      'src/shared/generated/**',
      'src/main/vm/generated/**',
      'src/renderer/js/app-parts/**',
      'tests/pw-browser-test/**',
    ],
  },
  {
    files: ['src/preload/**/*.js', 'src/main/browser-service.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        Notification: 'readonly',
      },
    },
  },
  {
    files: [
      'src/main/**/*.js',
      'src/preload/**/*.js',
      'src/data/**/*.js',
      'scripts/**/*.{js,cjs}',
      'bin/*.js',
      'build/cli/*.cjs',
      'packages/npm/**/*.cjs',
      'tests/**/*.{js,cjs}',
      'integrations/codeoss/**/*.{js,cjs}',
      '*.cjs',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.es2025 },
    },
    rules: correctness,
  },
  {
    files: ['integrations/codeoss/extension/media/*.js'],
    languageOptions: { globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } },
  },
  {
    files: ['src/renderer/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.node, ...globals.es2025 },
    },
    rules: { ...correctness, 'no-undef': 'off' },
  },
  {
    files: [
      'src/main/core/**/*.js',
      'src/preload/channel-subscriptions.js',
      'tests/unit/**/*.cjs',
      'scripts/build-app-bundle.js',
    ],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
