# @floken-io/moddle

[![npm](https://img.shields.io/npm/v/@floken-io/moddle)](https://www.npmjs.com/package/@floken-io/moddle)
[![license](https://img.shields.io/npm/l/@floken-io/moddle)](./LICENSE)

中国式流程引擎的 **Model JSON 数据模型**：一份定义长什么样、怎么校验、坐标怎么放、审批语义怎么配。

**JSON-only —— 不读也不写 BPMN XML。** 零 DOM、零数据库、零 UI 框架，浏览器 / Node / SSR 同构。运行时依赖只有 `zod`。

## 安装

```bash
npm i @floken-io/moddle
```

## 快速开始

```ts
import { validateDefinition, assertValidDefinition, autoLayout } from '@floken-io/moddle';

const def = {
  schemaVersion: '2.0.0',
  id: 'Process_1',
  name: '报销流程',
  nodes: [
    { id: 'Start_1', type: 'startEvent', name: '发起' },
    { id: 'Task_1', type: 'userTask', name: '部门经理审批', approval: { approvers: [{ type: 'user', value: 'u1' }] } },
    { id: 'End_1', type: 'endEvent', name: '结束' },
  ],
  flows: [
    { id: 'Flow_1', from: 'Start_1', to: 'Task_1' },
    { id: 'Flow_2', from: 'Task_1', to: 'End_1' },
  ],
};

validateDefinition(def);      // [] 表示没问题（返回诊断，不抛）
assertValidDefinition(def);    // 有 error 就抛 ModdleError
def.layout = autoLayout(def);  // 缺坐标时补一份（已有坐标一个都不动）
```

## 模型形态

坐标放在顶层 `layout`（扁平字典，不在节点上）。下面是上面那份定义跑 `autoLayout(def)` 的真实产出：

```js
layout: {
  nodes: {
    Start_1: { x: 150, y: 122, width: 36, height: 36 },
    Task_1:  { x: 266, y: 100, width: 100, height: 80 },
    End_1:   { x: 446, y: 122, width: 36, height: 36 },
  },
  edges: {
    Flow_1: [{ x: 186, y: 140 }, { x: 266, y: 140 }],
    Flow_2: [{ x: 366, y: 140 }, { x: 446, y: 140 }],
  },
}
```

`autoLayout` 是**确定性**的（同一份定义跑 10 次结果逐字相同）；`ensureLayout(def)` 则只补缺失坐标，已有的一个都不动。

## 能力

- **节点类型白名单 21 项**：从引擎源码能分派的类型算出（可执行 17 + 已知未实现 4），宿主可用 `customNodeTypes` 追加
- **一等行为字段**：`approval` / `call` / `eventDefinition` / `script` / `timeout` 都是节点的字段，不住在扩展袋里
- **扩展袋 `extension`**：任意 JSON，**无前缀要求、不限标量**；不认识的键一律保留、绝不静默丢弃
- **校验**：`validateDefinition` / `validateApproval` / `validateLayout`，返回带定位的 `Diagnostic[]`，一次把问题说全
- **自动布局**：`autoLayout(def)` 确定性产出扁平坐标；`ensureLayout(def)` 只补缺失、已有的不动
- **审批语义**：会签 / 或签 / 加签 / 驳回 / 超时 / 抄送。`normalizeApproval(input)` 把任意输入收敛成完整形态
  （默认值只在这里落一处，例如 `approverPolicy:'all'` / `mode:'all'` / `onReject:'abort'`）；
  ⚠️ 它**先校验再收敛**，输入非法会抛 `MODDLE_MODEL_VALIDATION_FAILED` —— 不是"填默认值然后放行"。

## 校验与诊断

```ts
import { validateDefinition } from '@floken-io/moddle';

validateDefinition({ schemaVersion: '1.0.0', id: 'P', nodes: [], flows: [] });
// [{ severity: 'error', code: 'MODDLE_VALIDATE_SCHEMA_VERSION',
//    message: "Unsupported schemaVersion '1.0.0'", path: 'schemaVersion' }]
```

校验分四层，逐层加严、前一层不过不进后一层：
**① 结构（zod）→ ② 类型白名单 → ③ 引用完整性（id 唯一 / `from`·`to` 存在）→ ④ 内嵌语义**（审批组合矩阵 / 扩展袋保留键 / layout 与节点 id 对得上）。

错误与诊断两条通道互不混用：**「重试也救不回来」→ 抛 `ModdleError`；「换个输入还有救」→ 诊断。**

## 中国式审批扩展

审批语义是 `userTask` 的**一等字段** `approval`，引擎原生识别：

```ts
{
  id: 'Task_1',
  type: 'userTask',
  name: '部门经理审批',
  approval: {
    approvers: [
      { type: 'user', value: 'u1' },
      { type: 'deptLeader', of: 'starter' },
    ],
    approverPolicy: 'all',                 // 取人策略
    mode: 'vote',                          // 汇聚方式
    vote: { threshold: 0.5 },
    onReject: 'abort',
    reject: { allowed: true, requireComment: true },
    timeout: { duration: 'P3D', actions: [{ type: 'remind', interval: 'PT4H' }] },
    cc: { to: [{ type: 'role', value: 'finance' }], on: ['completed'] },
  },
  extension: {
    rule: { maxAmount: 5000, tags: ['vip'] },   // 自定义数据：结构化值也照存
  },
}
```

## 版本

- **Model JSON `schemaVersion`**：`2.0.0`。校验器对 major ≠ 2 直接报 error，
  **不提供 v1 → v2 迁移** —— 「读旧格式读出一个行为不同的流程」比「当场报错」危险得多。

## 相关包

| 包 | 用途 |
|---|---|
| [`@floken-io/feel`](https://www.npmjs.com/package/@floken-io/feel) | FEEL 表达式语言 |
| [`@floken-io/engine`](https://www.npmjs.com/package/@floken-io/engine) | 流程内核与审批动作（必需 peer：本包） |
| [`@floken-io/dmn`](https://www.npmjs.com/package/@floken-io/dmn) | DMN 1.5 决策引擎 |
| `@floken-io/designer` | 流程配置器与画布（开发中） |

## 开发

```bash
npm install
npm run build
npm run verify   # 完整发布门禁
```

## 许可证

[Apache-2.0](./LICENSE)
