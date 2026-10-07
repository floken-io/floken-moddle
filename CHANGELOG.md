# Changelog

本包遵循 [Semantic Versioning](https://semver.org/)，格式参考 [Keep a Changelog](https://keepachangelog.com/)。
0.x 阶段跨包依赖写 `>=x.y.z <1.0.0`（不用 `^`）。

## 未发布

### 注释订正 · `script.language` 与 `condition.language` 的真实口径

只改注释与文档，行为未变：

- `ScriptSpec.language` 写 `javascript` **不代表引擎会执行 JS** —— 引擎无动态执行能力，
  非 FEEL 一律改查宿主的 `handlers` 表，**且 `body` 根本不传给 handler**（源码是死内容）。
- `FormalExpression.language` 写了非 FEEL 的语言，引擎**建图即抛**（`@floken-io/engine` 侧），
  不静默当 FEEL 求值。不写 = FEEL。

### 新增 · `timeout` 的 `duration` / `date` / `cycle` 校验**格式**（不只是"非空字符串"）

新增诊断码 `MODDLE_VALIDATE_TIMEOUT_FORMAT`。此前这三个字段只过 `z.string().min(1)`，
于是 `'3d'` / `'三天'` / `'2026-02-30'` 一律零诊断、**原样**送到调度方 ——
错要在运行时才暴露（或更糟：静默不生效）。定义层能挡就挡，成本差一个量级。

| 字段 | 接受 | 拒绝（例） |
|---|---|---|
| `duration` | `P3D` `PT4H` `P1W` `P1Y2M3DT4H30M` `PT0.5S` | `3d` `三天` `P` `PT` `D3P` |
| `date` | `2026-10-10` `2026-10-10T18:00:00` `…+08:00` `…Z` | `2026-02-30` `2026-13-01` `2026/10/10` `明天下午` |
| `cycle` | `R3/PT4H` `R/PT1H`（无限）`R3/2026-10-01T00:00/PT1H` | `PT4H`（缺 R 段）`R3` `R3/瞎写` |

⚠️ 实现要点：纯正则 + `Date.UTC` 回读比对，**不引时态库**（Q36 主包每层 deps ≤ 1）。
`Date.parse()` 不能拿来兜底 —— 实测 V8 对纯日期形式很宽松，
`Date.parse('2026-02-30')` 返回 2026-03-02 的时间戳而**不是** `NaN`。

### 破坏性变更 · `extension` 键名完全自由（不再有任何校验）

删除「保留键不进袋」这条规则 —— 包括它降级成 warn 的版本。同时删除：

- `NODE_RESERVED_KEYS` 常量（曾作为引擎侧 ADR-009 排除判据的数据源，该判据已一并删除）
- `MODDLE_VALIDATE_RESERVED_KEY` 诊断码（不再产生 = 直接删，不留死码，AGENTS.md §0.1）

理由：一等字段在 `node.approval`，**不在** `node.extension` 里，两者路径不同、不是一回事。
`extension.approval` 是**宿主自己的业务数据**（比如"客户的审批意见"），
模型层不该替宿主判断"你是不是写错了"—— 那既不是 error 该管的事，也不是 warn 该管的事。

现在 `extension` 里**什么键都能写**，零诊断。

### 口径订正 · 工作日历：法定节假日不内置

`DEFAULT_WORK_CALENDAR_SPEC.holidays` 一直是个空数组，而注释写着「缺省用内置法定节假日」——
**文档承诺没兑现**。现按实际行为定口径：

- 模型层只提供**默认工作时段**（`default` = 周一至周五 9:00–18:00）；
- **`holidays` 一律由宿主给**，不内置任何节假日表（每家公司的安排不同，内置一份必然过期）；
- `workCalendar` 的两种形态（字符串 id / 内联对象）**都会原样交给调度方**，
  引擎侧已修好「内联对象被静默丢弃」的问题（见 engine CHANGELOG）。

行为未变，只是把说法改回实话 —— 不影响已发布版本的兼容性。

### 破坏性变更 · 默认日历 id：`cn-default` → `default`

`DEFAULT_WORK_CALENDAR` 由 `'cn-default'` 改为 **`'default'`**（`DEFAULT_WORK_CALENDAR_SPEC.id` 同步）。

理由：这份默认日历**只含工作时段**（周一至周五 9:00–18:00），**不含任何中国法定节假日** ——
名字里带 `cn` 等于承诺了一份并不存在的表。**不保留别名**（AGENTS.md §0.1：0.x 阶段不留兼容层）。

影响面：写了 `workCalendar: 'cn-default'` 的定义仍能通过校验（它只是一个字符串 id），
但调度方若不认这个名字，会落到它自己的默认上 —— 把 `'cn-default'` 换成 `'default'`，
或直接内联一份日历对象。

## 0.1.0 — 2026-10-03（★ 破坏性变更：JSON-only 重写）

**本包不再读写 BPMN XML。** 这是 Q48 拍板的结果：v1 的形状（137 类型 / 318 属性 + 自研 SAX）
是为「XML 互操作」服务的，而中式审批流程不需要与 Camunda/bpmn-js 交换 `.bpmn` 文件。
删掉它换来的是**没有前缀机制、没有标量限制、没有 `processes[]` 影子层**的干净模型。

⚠️ **不提供 v1 → v2 迁移**：`schemaVersion` 的 major 不为 2 时校验器直接报 error，不做静默兼容。

### 破坏性变更

- **删除 XML 全部能力**：`toXml` / `toXmlSync` / `fromXml` / `fromXmlSync` 及 `src/xml/`（3127 行）
  整体删除；配套删除 `src/spec/`（BPMN 137 类型 / 318 属性覆盖表，1719 行）。
- **删除抛出码域** `MODDLE_XML_*` / `MODDLE_PARSE_*`（共 20 个）；`MODDLE_VALIDATION_FAILED`
  更名为 `MODDLE_MODEL_VALIDATION_FAILED`。
- **`processes[]` 整层删除**：节点与连线上提为顶层 `nodes` / `flows`。原 `def.processes[0].nodes`
  → `def.nodes`。（多 process 是 BPMN `collaboration` 的概念，中式审批一个定义就是一个流程。）
- **行为字段提升为一等字段**（原住在 `extension['floken:*']` 里）：
  `extension['floken:approval']` → **`approval`**；`extension['floken:call']` → **`call`**
  （`{ processId, version }`）；新增 `eventDefinition` / `script`（`{ body, language }`）/ `timeout`。
- **`extension` 取消全部限制**：键**不再需要** `prefix:` 前缀，值**不再限于**标量
  （结构化值原样保存、原样取出）。
- **`layout` 扁平化**：`layout.planes[].shapes/edges` → `layout.nodes` / `layout.edges` 两个字典。
- **删除泳道 / 协作图**：`laneSets` / `participants` / `collaboration` / `messageFlow` /
  `extraElements` / `isImmediate` 一并删除。
- **顶层 `.strict()` 放开**：改用 `z.looseObject()`，未知键**保留但不解读**（v1 是判 error 且
  转换层静默丢弃 —— 两边口径打架，且都违反「绝不静默丢弃」）。
- **`XML_ID_PATTERN` / `isValidXmlId`** → `ID_PATTERN` / `isValidId`。
- **删除依赖/工具**：`gen:spec` / `check:spec` / `ac-s1` / `miwg` / `interop` 脚本与
  12 道 XML 专属 verify 门禁（XSD / Java 互操作 / MIWG 语料 / 画布 / 跨解析器等价）全部删除，
  换成一道 `check:json-only`（扫 dist 无 XML 迹象 + 运行时断言 `schemaVersion 2.0.0` 与白名单 21/17/4）。

### 新增

- **节点类型白名单** `NODE_TYPES`（21 项 = 可执行 17 + 已知未实现 4），
  从引擎源码能分派的类型算出，**不手列**；导出 `EXECUTABLE_NODE_TYPES` /
  `UNIMPLEMENTED_NODE_TYPES` / `isNodeType()` / `isUnimplementedNodeType()` /
  `NODE_TYPE_GROUPS`（设计器左侧元素面板的数据源，Q47）。
  - 已知未实现 4 项：`sendTask` / `complexGateway` / `intermediateThrowEvent` / `implicitThrowEvent`
    —— 建模期报 **warn**（放行），引擎令牌到达时**抛错并指名归属 FR**，绝不静默直通。
  - 白名单**不是封闭枚举**：宿主用 `validateDefinition(def, { customNodeTypes: [...] })` 追加。
- **`NODE_RESERVED_KEYS`**（22 个一等字段键）：① `extension` 里出现这些键 → 报
  `MODDLE_VALIDATE_RESERVED_KEY` error；② 作为**引擎侧 ADR-009 排除判据的唯一数据源**
  （v1 排除的是 `floken:*` 前缀，前缀机制随 XML 一起消失）。
- 诊断码：`VALIDATE_NODE_TYPE` / `VALIDATE_NODE_UNIMPLEMENTED` / `VALIDATE_RESERVED_KEY` /
  `VALIDATE_SCHEMA_VERSION` / `VALIDATE_UNKNOWN_OPTION`（拼错选项名不再静默忽略）。

## 0.0.4 — 2026-10-01

### 修正

- **`shouldTerminate()` 规则序缺陷（引擎侧编号 D-21 / D-31）**：旧实现把「全员表态后按多数定
  （`pending === 0`）」放在最前面且**不看 `mode`**，于是会签「2 通过 1 驳回」被判成 **approved** ——
  与会签「**全部通过**才推进」的定义直接冲突。
- 根因：这条"多数决"压根不是 §4.4.1 的规则三。规则三写的是「**待办只剩 1 人**时不再算比例」，
  是**票签**的兜底（防除不尽 / 永远卡住）；旧实现把它误写成 `pending === 0` 且提到模式判定之前，
  等于把"多数决"叠加到了会签的"全票决"上。
- 修法：**先按 `mode` 判各自语义**，`pending === 0` 的兜底只对票签生效。会签分支同时明确
  `onReject` 的边界：它只决定**要不要提前终止**（`abort` 立即驳回 / `wait` 等全员表态完），
  **不决定最后按什么定** —— 会签下只要 `rejected >= 1`，结果就必须是 `rejected`。
- 另补：`any` 模式全员已表态且无人通过 → `rejected`（旧实现靠 `pending === 0` 那条兜住，
  规则序调整后必须显式补回，否则或签会永远停在等待态）。

## 0.0.3 — 2026-09-27

### 修正

- `files` 白名单补 `CHANGELOG.md`（0.0.2 漏了，导致本文件没进 tarball）。

## 0.0.2 — 2026-09-27

### 文档

- README 补成对外文档：安装、最小可用示例（解析 / 校验 / 导出 / 坐标 DI）、
  BPMN 覆盖度口径、导入导出行为约定、`includeExtensions` 与扩展保留说明。
- 去掉包内已不实的表述（本包不是占位骨架）。

## 0.0.1 — 2026-09-27

首个发布版本。

### 完成

- **BPMN 2.0 元模型**：137 个类型 / 318 个属性；可执行元素覆盖按 48 类登记
  （35 类一等字段兑现 + 13 类按原始 XML 保全，往返不丢）。
- **XML ↔ JSON 双向转换**：读写全自研（不依赖第三方 XML 库），默认拒绝 XXE；
  导出顺序按官方 XSD `sequence`，不是排版偏好。
- **DI / 坐标**：一图一 plane，导入遍历全部 `BPMNDiagram`，缺失时 `autoLayout()` 补。
- **校验**：结构、引用、id（NCName）、布局四类诊断，按错误契约返回诊断而非抛错。
- **实测门禁**：52 份文件过官方 OMG XSD（JDK JAXP，零第三方）零违规；
  MIWG 语料 22/22 导入且往返守恒幂等；与 Camunda 7 Java 模型互操作；
  bpmn-visualization 真实画布渲染。
- 运行时依赖只有 `zod`。
