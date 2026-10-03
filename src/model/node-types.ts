/**
 * ★ 节点类型白名单（§3）
 *
 * 这是 JSON-only 重做后**唯一**取代 BPMN 类型表的东西：v1 靠 `spec/bpmn.generated.ts`
 * 的 137 类型 / 318 属性来判定「这个 `type` 合不合法」，那份数据**只为 XML 互操作服务**，
 * 随 XML 一起删除。这里留下的，是**引擎真正能分派**的那一份。
 *
 * ## 三条定调
 * 1. **名字沿用 BPMN 元素名**（`userTask` / `exclusiveGateway`），理由见 §3.1 ——
 *    不是"兼容 BPMN"，而是**引擎的分派表就按这些名字写的**；
 * 2. **数字不手列**：`NODE_TYPES.length` 就是类型数，`EXECUTABLE_NODE_TYPES.length` 就是可执行数，
 *    文档与测试都从这里取，不另写第二份数字（NFR-M4）；
 * 3. **白名单不是封闭枚举**：宿主可用 `customNodeTypes` 追加（§3.3），但默认是关的 ——
 *    拼错 `userTaks` 若被静默接受，引擎只在**令牌到达时**才报，排查成本高一个量级。
 *
 * ## ★ 未实现的 4 类为什么还要留在名单里
 * `sendTask` / `complexGateway` / `intermediateThrowEvent` / `implicitThrowEvent` 是
 * **已知未实现**，不是"不在名单里"。区别是决定性的：
 * - 不在名单 → 建模期报错（拼错类型的处置）
 * - 在名单但未实现 → 建模期放行、**引擎令牌到达时抛错并指名归属 FR**
 *
 * 「流程走过去了但那条消息从未发生」是最难查的一类假象，所以这 4 类必须走第二条路，
 * **绝不静默直通**（AC-M2）。
 */

/* ───────────────────────────── 四族 ───────────────────────────── */

/**
 * 任务族 8 类 —— **从引擎 `src/nodes/tasks.ts` 的 `TASK_TYPES` 抄，不是我列的**。
 * 那边 `taskBehaviorOf()` 对 8 类逐一给行为；不在表里的任务类型引擎不认识。
 */
export const TASK_NODE_TYPES: readonly string[] = Object.freeze([
  'userTask',
  'serviceTask',
  'scriptTask',
  'sendTask',
  'receiveTask',
  'manualTask',
  'businessRuleTask',
  'task',
]);

/** 网关族 5 类（引擎 `src/nodes/gateways.ts` 的 `GATEWAY_TYPES`） */
export const GATEWAY_NODE_TYPES: readonly string[] = Object.freeze([
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'complexGateway',
  'eventBasedGateway',
]);

/** 事件族 6 类（引擎 `src/nodes/events.ts` 的 `EVENT_TYPES`） */
export const EVENT_NODE_TYPES: readonly string[] = Object.freeze([
  'startEvent',
  'endEvent',
  'intermediateThrowEvent',
  'intermediateCatchEvent',
  'boundaryEvent',
  'implicitThrowEvent',
]);

/** 结构族 2 类（引擎 `src/nodes/activities.ts`） */
export const STRUCTURE_NODE_TYPES: readonly string[] = Object.freeze(['subProcess', 'callActivity']);

/** 按族分组 —— 设计器左侧元素面板（Q47）直接拿这份数据渲染分组 */
export const NODE_TYPE_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  task: TASK_NODE_TYPES,
  gateway: GATEWAY_NODE_TYPES,
  event: EVENT_NODE_TYPES,
  structure: STRUCTURE_NODE_TYPES,
});

/* ───────────────────────────── 汇总 ───────────────────────────── */

/**
 * 全部节点类型（**21**）。
 *
 * ⚠️ 数字由 `.length` 得出，改这份数组时测试会立刻变红 —— 这是刻意的，
 * 避免"文档写 21、代码其实 20"这类静默漂移（AC-M1）。
 */
export const NODE_TYPES: readonly string[] = Object.freeze([
  ...TASK_NODE_TYPES,
  ...GATEWAY_NODE_TYPES,
  ...EVENT_NODE_TYPES,
  ...STRUCTURE_NODE_TYPES,
]);

/**
 * 已知未实现（**4**）—— 建模期放行，引擎令牌到达时抛错，绝不直通。
 *
 * | 类型 | 归属 |
 * |---|---|
 * | `sendTask` | D-56（引擎无对外消息出口） |
 * | `complexGateway` | FR-E17 |
 * | `intermediateThrowEvent` | FR-E14 / D-56 |
 * | `implicitThrowEvent` | FR-E24 |
 */
export const UNIMPLEMENTED_NODE_TYPES: readonly string[] = Object.freeze([
  'sendTask',
  'complexGateway',
  'intermediateThrowEvent',
  'implicitThrowEvent',
]);

/** 可执行类型（**17**）= {@link NODE_TYPES} 减去 {@link UNIMPLEMENTED_NODE_TYPES} */
export const EXECUTABLE_NODE_TYPES: readonly string[] = Object.freeze(
  NODE_TYPES.filter((t) => !UNIMPLEMENTED_NODE_TYPES.includes(t)),
);

const NODE_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);
const UNIMPLEMENTED_SET: ReadonlySet<string> = new Set(UNIMPLEMENTED_NODE_TYPES);

/* ───────────────────────────── 查询 ───────────────────────────── */

/** 是不是白名单内的节点类型 */
export function isNodeType(type: string): boolean {
  return NODE_TYPE_SET.has(type);
}

/** 是不是"在名单里但引擎还没实现"的类型（建模期可放行，运行期会抛错） */
export function isUnimplementedNodeType(type: string): boolean {
  return UNIMPLEMENTED_SET.has(type);
}

/*
 * ───────────────────────────── 事件定义 ─────────────────────────────
 *
 * v1 由 `spec/bpmn.generated.ts` 推导（`EventDefinition` 的非抽象后代剥后缀）。
 * 类型表删了，这里改为显式常量 —— 但**不是我拍的**：引擎 `nodes/catch.ts` 只对
 * `message` / `signal` 两类给出可投递绑定，其余种类在令牌到达时抛错并指名归属 FR。
 *
 * ⚠️ 因此这份清单的含义是「**可建模**的种类」，不是「引擎现在都能跑」的种类。
 */
export const EVENT_DEFINITION_TYPES: readonly string[] = Object.freeze([
  'timer',
  'message',
  'signal',
  'error',
  'escalation',
  'cancel',
  'compensate',
  'conditional',
  'terminate',
]);

/** 引擎当前可投递等待的事件种类（`nodes/catch.ts` 实测口径） */
export const DELIVERABLE_EVENT_DEFINITION_TYPES: readonly string[] = Object.freeze([
  'message',
  'signal',
]);
