// @floken-io/moddle — Model JSON v2（数据模型 + 白名单 + 校验 + 自动布局）
// 完整需求见 流程引擎包文档/01-包需求-floken-moddle.md
//
// ★ 本包是 **JSON-only**：不读也不写 BPMN XML（Q48，2026-10-03 拍板）。
//   因此没有 `toXml` / `fromXml`，也没有 BPMN 规范类型表 —— 那些只为互操作服务。
//   节点类型白名单（21 项）是引擎真正能分派的那一套，见 `model/node-types.ts`。
export const PACKAGE = '@floken-io/moddle' as const;

export * from './core/errors.js';
export * from './model/index.js';
export * from './layout/auto-layout.js';
