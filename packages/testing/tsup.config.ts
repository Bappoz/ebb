import { defineConfig } from 'tsup';
import { tsupBase } from '../../tsup.base.js';

export default defineConfig({
  ...tsupBase(['src/**/*.ts']),
  dts: { entry: { index: 'src/index.ts', vitest: 'src/vitest.ts' } },
});
