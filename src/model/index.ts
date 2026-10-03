/**
 * `@floken-io/moddle` · Model JSON 层
 *
 * 四份文件各管一件事：
 * - `approval.ts` —— ★ 中国式审批语义（类型 + zod + 组合矩阵 + 归一化），护城河所在；
 * - `node-types.ts` —— ★ 节点类型白名单（v2 起取代已被删除的 BPMN 类型表）；
 * - `layout.ts` —— 图形坐标层（引擎零读取，只为设计器能画图）；
 * - `definition.ts` —— 顶层结构（ProcessDefinition / FlowNode / Flow）+ 整模型校验。
 *
 * 分层：`core/errors.ts` 是各层的公共底座（错误与诊断契约，AGENTS.md §5）。
 */

export * from './approval.js';
export * from './layout.js';
export * from './node-types.js';
export * from './definition.js';
