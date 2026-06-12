import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import commonjs from '@rollup/plugin-commonjs';

// Production builds ship without a source map: it inlines the entire dependency
// source tree (~660 KB) into the marketplace package for no end-user benefit.
// Set NODE_ENV=development (or any non-'production' value) to opt back in for
// local debugging.
const isProd = process.env.NODE_ENV === 'production';

export default {
  input: 'src/plugin.ts',
  output: {
    file: 'com.corrugator.streamclaude.sdPlugin/bin/plugin.js',
    format: 'esm',
    sourcemap: !isProd,
  },
  external: [
    'child_process',
    'events',
    'fs',
    'net',
    'os',
    'path',
    'stream',
    'tls',
    'url',
    'util',
    'http',
    'https',
    'crypto',
    'buffer',
  ],
  plugins: [
    resolve({
      preferBuiltins: true,
    }),
    // ws 8.18+ ships an ESM wrapper that re-exports defaults from CJS files;
    // without commonjs() Rollup can't see those defaults. Must run before
    // typescript() so JS deps are converted to ESM first.
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      sourceMap: !isProd,
    }),
  ],
};
