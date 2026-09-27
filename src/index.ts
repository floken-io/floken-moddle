// @floken/moddle — BPMN 2.0 元模型 + Model JSON + JSON⇄XML + 校验
// 完整需求见 流程引擎包文档/01-包需求-floken-moddle.md
// 施工入口：M0（类型表 137/318）→ M2（JSON⇄XML 往返恒等）。
export const PACKAGE = '@floken/moddle' as const;

export * from './core/errors.js';
export * from './spec/index.js';
export * from './spec/coverage.js';
export * from './model/index.js';
export * from './layout/auto-layout.js';
export * from './xml/index.js';
