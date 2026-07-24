import esbuild from 'esbuild';
import process from 'process';

const production = process.argv[2] === 'production';

await esbuild.build({
  entryPoints: ['main.ts'],
  bundle: true,
  external: ['obsidian', 'crypto', 'child_process', 'fs', 'util'],
  format: 'cjs',
  target: 'es2021',
  sourcemap: production ? false : 'inline',
  minify: production,
  outfile: 'main.js',
  logLevel: 'info',
});
