# @floken-io/moddle

[![npm](https://img.shields.io/npm/v/@floken-io/moddle)](https://www.npmjs.com/package/@floken-io/moddle)
[![license](https://img.shields.io/npm/l/@floken-io/moddle)](./LICENSE)

BPMN 2.0 的 JSON 模型与 XML 双向转换：读进来是结构化 JSON，写出去是合规的 BPMN 2.0 XML（含 BPMNDI 坐标）。

零 DOM、零数据库、零 UI 框架，浏览器 / Node / SSR 同构。运行时依赖只有 `zod`。

## 安装

```bash
npm i @floken-io/moddle
```

## 快速开始

```ts
import { fromXmlSync, toXmlSync } from '@floken-io/moddle';

const def = fromXmlSync(xml);          // XML → JSON（坐标一并读进 layout.planes）
def.processes[0].nodes.push({ id: 'UserTask_2', type: 'userTask', name: '总经理审批' });
const out = toXmlSync(def);            // JSON → XML（BPMN 2.0 + BPMNDI）
```

## 模型形态

坐标放在顶层 `layout.planes[]`（扁平 map + `parentId`），不在节点上：

```js
{
  schemaVersion: '1.0.0',
  id: 'Definitions_1',
  processes: [{
    id: 'Process_1',
    name: '报销流程',
    executable: true,
    nodes: [{ id: 'StartEvent_1', type: 'startEvent', name: '发起' }],
    flows: [{ id: 'Flow_1', from: 'StartEvent_1', to: 'UserTask_1' }],
  }],
  layout: {
    planes: [{
      id: 'BPMNPlane_1',
      elementId: 'Process_1',
      shapes: { StartEvent_1: { x: 150, y: 100, width: 36, height: 36 } },
      edges: {},
    }],
  },
}
```

缺坐标时可用 `autoLayout(def)` 补一份（泳道和池也会生成 shape）。

## 能力

- **自有 BPMN 2.0 类型表**：登记语义类型 137 个 / 属性 318 项，JSON 模型一等覆盖 48 个元素类型（可执行元素 27 个）
- **XML ↔ JSON 双向**：自研 SAX 解析器（默认拒绝 XXE），导出顺序遵循官方 XSD sequence
- **坐标保全**：BPMNDI 一图一 plane，往返不丢
- **未落地元素原样保全**：不归模型一等的规范元素与第三方扩展（如 `camunda:*`）读进来存着、写出去还原，不会静默丢弃
- **审批语义扩展**：`floken:approval` 中国式审批配置（会签 / 或签 / 加签 / 驳回 / 超时 / 抄送）
- **校验**：`validateDefinition` / `validateApproval` / `validateLayout`，返回带定位的 `Diagnostic[]`
- **净化开关**：`toXmlSync(def, { includeExtensions: false })` 只剔审批语义，第三方扩展照留

## 校验与诊断

```ts
import { validateDefinition, MODDLE_DIAGNOSTIC_CODES } from '@floken-io/moddle';

const diagnostics = validateDefinition(def);   // [] 表示没问题
// [{ severity: 'error', code: 'MODDLE_VALIDATE_INVALID_ID', message: '…', path: '…' }]
```

错误与诊断两条通道互不混用：**「重试也救不回来」→ 抛 `ModdleError`；「换个输入还有救」→ 诊断。**

```ts
import { ModdleError, MODDLE_ERROR_CODES } from '@floken-io/moddle';

try {
  fromXmlSync(xml);
} catch (e) {
  if (e instanceof ModdleError) {
    e.code;   // 例：'MODDLE_PARSE_UNCLOSED_TAG'
    e.hint;   // 修复提示
  }
}
```

## 中国式审批扩展

审批语义住在节点的 `extension['floken:approval']` 里，引擎原生识别，XML 侧前缀为 `floken`（命名空间 `http://floken.dev/schema/approval/1.0`）。

```ts
{
  id: 'UserTask_1',
  type: 'userTask',
  name: '部门经理审批',
  extension: {
    'floken:approval': {
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
    'camunda:assignee': 'demo',              // 第三方扩展照留
  },
}
```

`normalizeApproval(input)` 把任意输入收敛成完整形态（默认值只在这里落一处）；`validateApproval` 校验语义合法性。

## 验证

本包的正确性由多道自动化门禁把关，其中外部对照包括：

- **官方 OMG BPMN20.xsd + JDK JAXP** 校验：52 份文件零违规
- **Camunda 7 Java `camunda-bpmn-model`** 交叉导入：真引用 / 真属性比对
- **MIWG 语料 22 份**：导入 + 往返守恒 + 幂等
- **bpmn-visualization（mxGraph 真实画布）** 渲染：图元类型正确、泳道与池可见

## 相关包

| 包 | 用途 |
|---|---|
| [`@floken-io/feel`](https://www.npmjs.com/package/@floken-io/feel) | FEEL 表达式语言 |
| [`@floken-io/moddle`](https://www.npmjs.com/package/@floken-io/moddle) | BPMN 2.0 模型与 XML 转换（本包） |
| [`@floken-io/dmn`](https://www.npmjs.com/package/@floken-io/dmn) | DMN 1.5 决策引擎 |
| `@floken-io/engine` | 流程内核与审批动作（开发中） |
| `@floken-io/designer` | 流程画布与审批配置面板（开发中） |

## 开发

```bash
npm install
npm run build
npm run verify   # 完整发布门禁
```

## 许可证

[Apache-2.0](./LICENSE)
