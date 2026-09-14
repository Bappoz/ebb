import { defineConfig } from 'tsup';
import { tsupBase } from '../../tsup.base.js';

export default defineConfig({ ...tsupBase(['src/**/*.ts']), dts: { entry: 'src/index.ts' } });
