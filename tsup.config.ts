import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
  clean: true,
  /*
   * `external` 与「是不是 dependency」无关（AGENTS.md §5.8 ⑤）：
   * - `zod` 是 **dependency**，必须 external，否则会被打进 bundle（Q36：dependencies 只允许它一项）；
   * - `temporal-polyfill` 在本包压根不存在，保留只为与五包脚手架的骨架保持一致。
   */
  external: ['zod', 'temporal-polyfill'],
});
