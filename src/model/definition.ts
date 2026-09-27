/**
 * Model JSON 的顶层类型（§4.2 / §4.3 / §4.5）+ 整模型校验。
 *
 * 三条定调：
 * 1. **连线用 `from` / `to`，不用 `sourceRef` / `targetRef`** ——
 *    `sourceRef` 是 XML 引用语义（指向 id），JSON 里 `from/to` 更直白，
 *    且避开"引用是字符串还是对象"这个经典坑。映射由转换层负责，模型层不背 XML 的包袱。
 * 2. **`extension` 是保全袋**：不认识的属性一律进它，导出时原样还原，**绝不静默丢弃**（§4.5 纪律一）。
 * 3. 校验走**诊断通道**，一次把问题说全；`assertValidDefinition()` 才是严格抛错入口。
 */

import { z } from 'zod';

import {
  MODDLE_DIAGNOSTIC_CODES,
  diagnostic,
  joinPath,
  validationFailedError,
  type Diagnostic,
} from '../core/errors.js';
import { ALL_COVERED_ELEMENTS, findCoverage } from '../spec/coverage.js';
import {
  BPMN_AssociationDirection,
  BPMN_EventBasedGatewayType,
  BPMN_GatewayDirection,
} from '../spec/enums.generated.js';
import { BPMN_TYPES, isSubtypeOf, xmlNameOf } from '../spec/index.js';
import { validateApproval, type Approval } from './approval.js';
import { validateLayout, LayoutSchema, type Layout } from './layout.js';

/**
 * FEEL 表达式语言的 URI（D18/Q35）。
 *
 * **URI 取自官方，不自造**：这是 DMN **1.5** XSD 里 `expressionLanguage` 的官方默认值，
 * 与锁定的权威版本一致。它是 `anyURI` —— 用 OMG 官方值，第三方工具才读得懂。
 * ⚠️ 该值随权威元模型版本走（1.3=`…/20191111/FEEL/`、1.4=`…/20211108/FEEL/`、
 * **1.5=`…/20230324/FEEL/`（本项目权威值）**、1.6=`…/20240513/FEEL/`），**导出恒写 1.5**。
 */
export const FEEL_EXPRESSION_LANGUAGE = 'https://www.omg.org/spec/DMN/20230324/FEEL/';

/** Model JSON 自身的格式版本（与包版本无关） */
export const MODEL_SCHEMA_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────

/** 未识别的外部 extensionElements / 第三方挂入内容，原样快照 */
export interface ExtensionBag {
  /** ★ 我们的审批语义，引擎原生识别并执行（键名即标识） */
  'floken:approval'?: Approval;
  _extensionElements?: unknown[];
  [key: string]: unknown;
}

/**
 * `tFormalExpression` 的 Model JSON 形态（★ D18 / D19）。
 * 规范依据：BPMN20.xsd 的 tFormalExpression 有 `language`(anyURI) 与 `evaluatesToTypeRef`(QName) 两个自有属性。
 */
/*
 * ⚠️ 全模型的可选字段统一写 `?: T | undefined`：本仓开了 `exactOptionalPropertyTypes`，
 * 而 zod 的 `.optional()` 产出就是 `T | undefined`（同 `model/approval.ts` 的说明）。
 * 两边写法必须一致，否则 `XxxSchema satisfies z.ZodType<Xxx>` 那道编译期锁会失效。
 */
export interface FormalExpression {
  /** ★ FEEL 源码，**不带 `=` 前缀**（D19） */
  body: string;
  /** 默认 {@link FEEL_EXPRESSION_LANGUAGE} */
  language?: string | undefined;
  /** BPMN 规范属性；本项目暂不用，但字段保留 */
  evaluatesToTypeRef?: string | undefined;
}

/**
 * 事件定义的类型 —— **由类型表推导，不手列**。
 * 取自 `EventDefinition` 的非抽象后代，剥掉 `EventDefinition` 后缀
 * （`timerEventDefinition` → `timer`）。
 */
export const EVENT_DEFINITION_TYPES: readonly string[] = Object.freeze(
  BPMN_TYPES.filter(
    (t) => !t.isAbstract && t.name !== 'EventDefinition' && isSubtypeOf(t.name, 'EventDefinition'),
  )
    .map((t) => xmlNameOf(t.name).replace(/EventDefinition$/, ''))
    .sort(),
);

export interface EventDefinition {
  /** 见 {@link EVENT_DEFINITION_TYPES} */
  type: string;
  /** 各变体自有字段（timer 的 duration/date/cycle、message 的 messageRef …） */
  [key: string]: unknown;
}

export interface BaseNode {
  id: string;
  /** ★ BPMN 规范元素名，小驼峰（如 `userTask`） */
  type: string;
  name?: string | undefined;
  /** → `bpmn:documentation`（第 1 条） */
  description?: string | undefined;
  /**
   * → `<bpmn:text>`：**textAnnotation 的正文**（XSD 里是它的规范子元素，不是扩展）。
   * 不能塞进 `extensionElements` 快照 —— 位置错了，还会凭空带一份 xmlns。
   */
  text?: string | undefined;
  /**
   * → 第 2 条及以后的 `<bpmn:documentation>`（XSD 是 `maxOccurs="unbounded"`，
   * 多语言文档常按 `xml:lang` 写多条）。
   *
   * ★ 只取第一条、其余丢弃的话 → MIWG `C.9.0` 实测往返丢 3 条。
   * 单值的 `description` 装不下多份文档，但"装不下"不等于"可以丢"（纪律一）。
   */
  extraDocumentations?: string[] | undefined;
  extension?: ExtensionBag | undefined;
}

/*
 * ★ §6.6「JSON⇄XML 元素映射表」承诺的关键属性，按 **BPMN XSD 裁定**分两组：
 *
 * **组 A（本接口这些字段）= 规范属性**：类型表 `effectiveProperties()` 里 `isAttr === true`
 * （或规范声明的子元素）。它们是 BPMN 原生执行语义，engine 必须能**按名字读**，
 * 不能去 extension 袋里掏字符串 → 补为一等字段，双向落地。
 *
 * **组 B（`assignee` / `candidateUsers` / `candidateGroups` / `decisionRef`）= 第三方扩展**：
 * 类型表里**查不到** —— Camunda 7 写作 `camunda:assignee`、Flowable 写作 `flowable:assignee`，
 * 谁都不敢写成不带前缀的属性（那是非法 XML）。故它们**不进本接口**，导入时进
 * `extension['camunda:assignee']` 原样保全、导出时还原成带前缀的属性（FR-S13）。
 * 我们的审批取人由 `floken:approval` 的 `approverPolicy` 管，本就不需要 `assignee`。
 *
 * 判定可复算（不许手列）：
 *   node --input-type=module -e "…effectiveProperties('UserTask')…"
 */
export interface FlowNode extends BaseNode {
  /** `userTask` */
  formKey?: string | undefined;
  /** `boundaryEvent`：挂到哪个节点 */
  attachedTo?: string | undefined;
  /** `boundaryEvent` / 各类 event：`<xEventDefinition>` 的 JSON 形态 */
  eventDefinition?: EventDefinition | undefined;
  /** `subProcess` 等容器节点的内嵌元素（M2 展开） */
  nodes?: FlowNode[] | undefined;
  flows?: Flow[] | undefined;

  // ── 组 A：BPMN 规范属性（§6.6） ──

  /** → `default`（`Gateway` / `Activity`：无条件下的**默认分支**，指向一条 `sequenceFlow` 的 id） */
  defaultFlow?: string | undefined;
  /** → `implementation`（`##unspecified` / `##WebService` 或自定义 URI） */
  implementation?: string | undefined;
  /** → `operationRef`（`sendTask` / `receiveTask` / `serviceTask`） */
  operationRef?: string | undefined;
  /** → `messageRef`（`sendTask` / `receiveTask`） */
  messageRef?: string | undefined;
  /** → `<bpmn:script>` **子元素**（`scriptTask`） */
  script?: string | undefined;
  /** → `scriptFormat`（`scriptTask`） */
  scriptFormat?: string | undefined;
  /** → `gatewayDirection`，取值见 `BPMN_GatewayDirection` */
  gatewayDirection?: GatewayDirection | undefined;
  /** → `triggeredByEvent`（`subProcess` / `adHocSubProcess` / `transaction`） */
  triggeredByEvent?: boolean | undefined;
  /** → `calledElement`（`callActivity`：被调用流程的 key） */
  calledElement?: string | undefined;
  /** → `dataObjectRef`（`dataObjectReference`） */
  dataObjectRef?: string | undefined;
  /** → `dataStoreRef`（`dataStoreReference`） */
  dataStoreRef?: string | undefined;
  /** → `<bpmn:activationCondition>` 子元素（`complexGateway`；L2 可存，L3 不承诺） */
  activationCondition?: string | FormalExpression | undefined;
  /*
   * ── 组 A 第三批：`association` 的端点 ──
   * XSD 里 `tAssociation` 的 `sourceRef` / `targetRef` 是 **required**，
   * 缺了就是非法 BPMN（官方 XSD 实测：`cvc-complex-type.4: 元素 'bpmn:association' 中必须包含属性 'sourceRef'`）。
   * 没有这两个字段，`association` 就只能"保全不能建模" —— 而它偏偏是图面常用元素。
   */
  /** → `sourceRef`（`association`：起点元素 id） */
  sourceRef?: string | undefined;
  /** → `targetRef`（`association`：终点元素 id） */
  targetRef?: string | undefined;
  /** → `associationDirection`（`association`：`None` / `One` / `Both`） */
  associationDirection?: AssociationDirection | undefined;

  // ── 组 A 第二批：同样是 `isAttr` 规范属性，且**执行语义关键** ──
  // 判据与第一批完全相同（类型表 `effectiveProperties().isAttr`），
  // 不补的理由只有"L3 不承诺"（`ordering` / `cancelRemainingInstances` / `protocol` / `method`
  // 属于这一类，留在 extension 里，文档 §6.6 已写明）。

  /** → `isForCompensation`（`Activity`：是不是补偿活动；FR-E13 补偿变体的判据） */
  isForCompensation?: boolean | undefined;
  /** → `startQuantity`（`Activity`：启动所需令牌数，XSD 是 `xsd:integer`） */
  startQuantity?: number | undefined;
  /** → `completionQuantity`（`Activity`：完成所需令牌数） */
  completionQuantity?: number | undefined;
  /** → `cancelActivity`（`boundaryEvent`：触发后**是否取消宿主活动**） */
  cancelActivity?: boolean | undefined;
  /** → `isInterrupting`（`startEvent`：事件子流程是否中断宿主） */
  isInterrupting?: boolean | undefined;
  /** → `eventGatewayType`（`eventBasedGateway`） */
  eventGatewayType?: EventGatewayType | undefined;
  /** → `instantiate`（`receiveTask` / `eventBasedGateway`：能否直接拉起流程实例） */
  instantiate?: boolean | undefined;
  /** → `parallelMultiple`（`startEvent` / 捕获事件：是否允许多个事件并行触发） */
  parallelMultiple?: boolean | undefined;
  /** → `itemSubjectRef`（`dataObject` / `dataObjectReference` / `dataStoreReference`） */
  itemSubjectRef?: string | undefined;
  /** → `isCollection`（`dataObject`） */
  isCollection?: boolean | undefined;
}

/** `gatewayDirection` 的合法取值 —— **由枚举表推导，不手列** */
export type GatewayDirection = (typeof BPMN_GatewayDirection)[number];

/** `eventGatewayType` 的合法取值 —— **由枚举表推导，不手列** */
export type EventGatewayType = (typeof BPMN_EventBasedGatewayType)[number];

/** `associationDirection` 的合法取值 —— **由枚举表推导，不手列** */
export type AssociationDirection = (typeof BPMN_AssociationDirection)[number];

/**
 * `id` 的合法性（XSD `xsd:ID` = **NCName**）。
 *
 * ★ 为什么必须在模型层拦：XML 里 `id` 是 `xsd:ID`，**全文档唯一且必须是 NCName**。
 * 我们的自研 SAX 宽容（不校验），所以 `id="1s"` / `id="a b"` 能写出去、我们自己也能读回来，
 * 但 **bpmn-moddle 直接判 `illegal ID`、bpmn-js 丢图形**（互操作实测）。
 * 产出一个别人读不了的文件，比报错严重得多。
 *
 * 宽松处：允许非 ASCII 字母（中文工具里 `id="节点1"` 很常见，NCName 本身也允许 Unicode 字母）。
 */
export const XML_ID_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

/** 是否可作为 XML `id`（空串、数字开头、含空白/冒号一律不行） */
export function isValidXmlId(id: string): boolean {
  if (!id) return false;
  // 非 ASCII 开头（如中文）按 NCName 放行，只查后续字符不含 XML 禁用的空白与冒号
  if (!XML_ID_PATTERN.test(id)) {
    if (!/^[^\s:]+$/.test(id)) return false;
    if (/^[\d.\-]/.test(id)) return false;
    if (/[\s:]/.test(id)) return false;
  }
  return true;
}

export interface Flow {
  id: string;
  from: string;
  to: string;
  name?: string | undefined;
  /**
   * → `<bpmn:documentation>`（第 1 条）。
   *
   * ★ 连线同样继承自 `tBaseElement`，一样能挂文档 —— MIWG `C.9.0` 有 3 条文档就挂在
   * `sequenceFlow` 上；`Flow` 缺这个字段 → 导入即丢。
   */
  description?: string | undefined;
  /** → 第 2 条及以后的 `<bpmn:documentation>` */
  extraDocumentations?: string[] | undefined;
  /**
   * 两种写法都接受：
   * - 简写 `condition: 'amount > 5000'` → 视为 body，language 取 {@link FEEL_EXPRESSION_LANGUAGE}
   * - 全写 `condition: { body: '…', language: '…' }`
   *
   * **导出时一律展开成全写形态并写入 `language` 属性**（FR-9.11）。
   * 为什么必须带 `language`：不写时按 XSD 默认语义是 **XPath**，
   * `amount > 5000` 在 XPath 里是节点集比较，与 FEEL 的布尔比较不是一回事（§4.3）。
   */
  condition?: string | FormalExpression | undefined;
  /** → `isImmediate`（`sequenceFlow` 的规范属性，XSD 默认 `true`） */
  isImmediate?: boolean | undefined;
  extension?: ExtensionBag | undefined;
}

// ─────────────────────────────────────────────────────────────────
// 泳道 / 协作图（★ 泳道族 5 类真落地）
//
// 为什么必须单独有落点，而不能塞进 `process.nodes`：
// 1. `<bpmn:laneSet>` 在 XSD 里是 **process 的直接子元素且排在 flowElement 之前**，
//    它既不是节点也不能连线 —— 塞进 nodes 会污染引擎的遍历，autoLayout 还会给它画个假框；
// 2. `<bpmn:participant>` / `<bpmn:messageFlow>` 在 **process 之外**（`collaboration` 下），
//    nodes 根本装不下，只能整个丢掉（互操作实测：导入泳道图 → 导出后泳道全没）。
// ─────────────────────────────────────────────────────────────────

/** `<bpmn:lane>` —— 泳道（道）。`nodeIds` 是它真正的数据：哪些节点归这条道 */
export interface Lane {
  id: string;
  name?: string | undefined;
  /** → `<bpmn:flowNodeRef>`（0..n）：本道内的节点 id */
  nodeIds?: string[] | undefined;
  /** → `<bpmn:partitionElementRef>`（0..1）：分区元素（通常是 participant 的 id） */
  partitionElementRef?: string | undefined;
  /** → `<bpmn:childLaneSet>`：嵌套子泳道 */
  lanes?: Lane[] | undefined;
  extension?: ExtensionBag | undefined;
}

/** `<bpmn:laneSet>` */
export interface LaneSet {
  /**
   * ★ XSD 里 `laneSet@id` 是 **optional**（`xsd:ID`，非必填）—— 真实文件里大量 `laneSet` 不带 id
   * （MIWG `C.10.0` 实测）；若做成必填，导入合法文件后校验器会报 error。
   * 缺省时导出不写该属性（XML 仍然合法）。
   */
  id?: string | undefined;
  name?: string | undefined;
  lanes: Lane[];
  extension?: ExtensionBag | undefined;
}

/** `<bpmn:participant>` —— 池（Pool）。`processRef` 指向它承载的流程 */
export interface Participant {
  id: string;
  name?: string | undefined;
  /** → `processRef`：这个池对应哪个 process */
  processRef?: string | undefined;
  extension?: ExtensionBag | undefined;
}

/**
 * `<bpmn:messageFlow>` —— 跨池消息流。
 * 同样用 `from` / `to`（与 `Flow` 一致），不再引入 `sourceRef` / `targetRef` 的第二套说法。
 */
export interface MessageFlow {
  id: string;
  name?: string | undefined;
  from: string;
  to: string;
  extension?: ExtensionBag | undefined;
}

/** `<bpmn:collaboration>` —— 协作图根（泳道图的容器） */
export interface Collaboration {
  id: string;
  name?: string | undefined;
  participants: Participant[];
  messageFlows: MessageFlow[];
  /**
   * 会话族等**不落地**的内容，原样 XML 快照（纪律一：认不出的一律保全，绝不静默丢弃）。
   * 它们不是我们的模型对象，但也不能因为"我们不建模"就把用户的文件吃掉。
   */
  extraElements?: string[] | undefined;
  extension?: ExtensionBag | undefined;
}

export interface Process {
  id: string;
  name?: string | undefined;
  executable?: boolean | undefined;
  /**
   * → `<bpmn:laneSet>`（0..n），**写在所有 flowElement 之前**（XSD 是 sequence，颠倒是非法 XML）。
   * 泳道数据（哪几个节点归哪条道）就在这里，不在 `nodes` 里。
   */
  laneSets?: LaneSet[] | undefined;
  nodes: FlowNode[];
  flows: Flow[];
  /** → `<bpmn:documentation>`（process 级，第 1 条） */
  description?: string | undefined;
  /** → 第 2 条及以后的 `<bpmn:documentation>`（同 {@link FlowNode.extraDocumentations}） */
  extraDocumentations?: string[] | undefined;
  extension?: ExtensionBag | undefined;
}

export interface ProcessDefinition {
  /** 本 JSON 格式的版本（semver），见 {@link MODEL_SCHEMA_VERSION} */
  schemaVersion: string;
  id: string;
  name?: string | undefined;
  /** 业务版本号 —— 实例绑定它，改版不影响在途 */
  version?: number | undefined;
  processes: Process[];
  /**
   * `<bpmn:collaboration>` —— 泳道图 / 协作图根（participant 池 + messageFlow），**0..n**。
   *
   * ★ 为什么是数组：XSD 里 `definitions` 下的 `collaboration` 是 `maxOccurs="unbounded"`，
   * 真实文件确有**多个**（MIWG `C.4.0` 有 4 个，每个各带 1 个池）。只存一个的话 →
   * 导入后 3 个池凭空消失、相关 `messageFlow` 变成悬空引用。
   *
   * 缺省 = 单流程（无池），这是最常见的形态。
   */
  collaborations?: Collaboration[] | undefined;
  /**
   * definitions 级**不落地**元素的原样 XML 快照（编排族 / 会话族 / `<bpmn:message>` /
   * `<bpmn:signal>` / `<bpmn:error>` / `<bpmn:itemDefinition>` …）。
   *
   * ★ 为什么要有它：这些元素在 BPMN 里真实存在、且常被 `messageRef` 之类的引用指向。
   * 若静默丢弃 → 导出后 `messageRef="Msg_1"` 变成**悬空引用**。
   * 我们不建模，但必须保住（纪律一）。
   */
  extraElements?: string[] | undefined;
  /** → `<bpmn:documentation>`（definitions 级，第 1 条） */
  description?: string | undefined;
  /** → 第 2 条及以后的 `<bpmn:documentation>`（同 {@link FlowNode.extraDocumentations}） */
  extraDocumentations?: string[] | undefined;
  /** 缺失时必须能自动补出（D8） */
  layout?: Layout | undefined;
  meta?: Record<string, unknown> | undefined;
}

/** 覆盖表里的全部元素名（27 可执行 + 21 不可执行），供设计器与校验共用 */
export const COVERED_ELEMENT_NAMES: readonly string[] = Object.freeze(
  ALL_COVERED_ELEMENTS.map((e) => e.xmlName),
);

// ─────────────────────────────────────────────────────────────────
// schema（结构层）
// ─────────────────────────────────────────────────────────────────

/*
 * `extension` 与 `meta` 是**任意键**的保全袋，所以这两处**不用** `.strict()`
 * （strict 会把第三方属性判成未识别键，直接违反 §4.5「绝不静默丢弃」）。
 * 其余对象一律 strict —— 拼错的模型字段名必须被发现。
 */
const ExtensionBagSchema: z.ZodType<ExtensionBag> = z.record(z.string(), z.unknown());

const FormalExpressionSchema = z
  .object({
    body: z.string(),
    language: z.string().optional(),
    evaluatesToTypeRef: z.string().optional(),
  })
  .strict();

const EventDefinitionSchema = z
  .object({ type: z.string().min(1) })
  .catchall(z.unknown());

const FlowSchema: z.ZodType<Flow> = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    extraDocumentations: z.array(z.string()).optional(),
    condition: z.union([z.string(), FormalExpressionSchema]).optional(),
    isImmediate: z.boolean().optional(),
    extension: ExtensionBagSchema.optional(),
  })
  .strict();

// ── 泳道 / 协作图 schema ──

/** `Lane` 可嵌套（`childLaneSet`）→ 递归，用 `z.lazy` */
const LaneSchema: z.ZodType<Lane> = z.lazy(
  (): z.ZodType<Lane> =>
    z
      .object({
        id: z.string().min(1),
        name: z.string().optional(),
        nodeIds: z.array(z.string().min(1)).optional(),
        partitionElementRef: z.string().min(1).optional(),
        lanes: z.array(LaneSchema).optional(),
        extension: ExtensionBagSchema.optional(),
      })
      .strict(),
);

const LaneSetSchema: z.ZodType<LaneSet> = z
  .object({
    // 同 {@link LaneSet.id}：XSD optional，不能做成必填
    id: z.string().min(1).optional(),
    name: z.string().optional(),
    lanes: z.array(LaneSchema),
    extension: ExtensionBagSchema.optional(),
  })
  .strict();

const ParticipantSchema: z.ZodType<Participant> = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    processRef: z.string().min(1).optional(),
    extension: ExtensionBagSchema.optional(),
  })
  .strict();

const MessageFlowSchema: z.ZodType<MessageFlow> = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    from: z.string().min(1),
    to: z.string().min(1),
    extension: ExtensionBagSchema.optional(),
  })
  .strict();

const CollaborationSchema: z.ZodType<Collaboration> = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    participants: z.array(ParticipantSchema),
    messageFlows: z.array(MessageFlowSchema),
    extraElements: z.array(z.string()).optional(),
    extension: ExtensionBagSchema.optional(),
  })
  .strict();

/**
 * 节点是**递归**的（子流程里还有 nodes/flows），故用 `z.lazy`。
 * 手写显式类型注解是必须的：递归 schema 无法靠推断。
 */
const FlowNodeSchema: z.ZodType<FlowNode> = z.lazy(
  (): z.ZodType<FlowNode> =>
    z
      .object({
        id: z.string().min(1),
        type: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
        extraDocumentations: z.array(z.string()).optional(),
        text: z.string().optional(),
        formKey: z.string().optional(),
        attachedTo: z.string().min(1).optional(),
        eventDefinition: EventDefinitionSchema.optional(),
        nodes: z.array(FlowNodeSchema).optional(),
        flows: z.array(FlowSchema).optional(),
        // 组 A：BPMN 规范属性（§6.6）。`gatewayDirection` 的枚举合法性由规则层查，
        // 这样报错能带上 `expected` 全表，而不是一句 "Invalid input"。
        defaultFlow: z.string().min(1).optional(),
        implementation: z.string().optional(),
        operationRef: z.string().optional(),
        messageRef: z.string().optional(),
        script: z.string().optional(),
        scriptFormat: z.string().optional(),
        gatewayDirection: z.string().optional(),
        triggeredByEvent: z.boolean().optional(),
        calledElement: z.string().optional(),
        dataObjectRef: z.string().optional(),
        dataStoreRef: z.string().optional(),
        activationCondition: z.union([z.string(), FormalExpressionSchema]).optional(),
        // 组 A 第三批：`association` 的端点（XSD 里是 required，缺了就是非法 BPMN）
        sourceRef: z.string().min(1).optional(),
        targetRef: z.string().min(1).optional(),
        associationDirection: z.string().optional(),
        // 组 A 第二批（执行语义关键，类型按 XSD：布尔 / integer / string）
        isForCompensation: z.boolean().optional(),
        startQuantity: z.number().int().nonnegative().optional(),
        completionQuantity: z.number().int().nonnegative().optional(),
        cancelActivity: z.boolean().optional(),
        isInterrupting: z.boolean().optional(),
        // 枚举合法性由规则层查（报错能带 `expected` 全表）
        eventGatewayType: z.string().optional(),
        instantiate: z.boolean().optional(),
        parallelMultiple: z.boolean().optional(),
        itemSubjectRef: z.string().optional(),
        isCollection: z.boolean().optional(),
        extension: ExtensionBagSchema.optional(),
      })
      .strict(),
);

const ProcessSchema: z.ZodType<Process> = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    executable: z.boolean().optional(),
    laneSets: z.array(LaneSetSchema).optional(),
    nodes: z.array(FlowNodeSchema),
    flows: z.array(FlowSchema),
    description: z.string().optional(),
    extraDocumentations: z.array(z.string()).optional(),
    extension: ExtensionBagSchema.optional(),
  })
  .strict();

export const ProcessDefinitionSchema = z
  .object({
    schemaVersion: z.string().min(1),
    id: z.string().min(1),
    name: z.string().optional(),
    version: z.number().int().nonnegative().optional(),
    processes: z.array(ProcessSchema).min(1),
    collaborations: z.array(CollaborationSchema).optional(),
    extraElements: z.array(z.string()).optional(),
    description: z.string().optional(),
    extraDocumentations: z.array(z.string()).optional(),
    layout: LayoutSchema.optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict() satisfies z.ZodType<ProcessDefinition>;

// ─────────────────────────────────────────────────────────────────
// 校验（规则层）
// ─────────────────────────────────────────────────────────────────

export interface ValidateDefinitionOptions {
  /** 把 warn 也当成不合格（严格模式） */
  strict?: boolean;
}

/**
 * 校验整份 Model JSON。
 *
 * 覆盖四层：结构（zod）→ 元素类型是否在覆盖表 → 引用完整性（id 唯一 / from-to 存在）→
 * 内嵌语义（`extension['floken:approval']` / `layout`）。
 *
 * ⚠️ 元素类型不在覆盖表给 **warn**：导入别人的图遇到没承诺的元素要**保全**（§4.5），
 * 拦在解析层等于静默丢弃。
 */
/**
 * **只保全、不建模**那些元素的 id —— 从 XML 快照字符串里抽 `id="..."`。
 *
 * 为什么必须抽：它们（`dataInput` / `dataOutput` / `data*Association` / `group` …）
 * 没有进 `nodes`，但在**别人的文件里是有坐标的**，对应 `BPMNShape` 完全合法。
 *
 * ★ **单一事实源**：`validateLayout` 的 `knownIds` 与 `toXml` 的悬空 DI 判定
 * 必须共用这一份口径 —— 两边各有一处手写版本的话，
 *   · 校验器那边会漏掉 `_bpmnChildren`，
 *   · 导出那边压根没有 → **元素保住了、坐标却被当成悬空 DI 删掉**。
 * 后者是真正的数据丢失：跨解析器比对（第二十道门禁）在 MIWG 上实测抓到
 * 8 份语料丢坐标（C.5.0 丢 25 个 shape），元素还在、框没了。
 *
 * 用途限定：只用于判断「这个 id 在导出的 XML 里到底存不存在」，不参与任何语义。
 */
export function snapshotElementIds(def: ProcessDefinition): Set<string> {
  const ids = new Set<string>();
  const ID_ATTR_RE = /\sid="([^"]+)"/g;
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(ID_ATTR_RE)) ids.add(m[1] as string);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    }
  };
  /** `_bpmnChildren`（BPMN 命名空间，原地写回）与 `_extensionElements`（第三方）都要抽 */
  const addExt = (ext: Record<string, unknown> | undefined): void => {
    if (!ext) return;
    walk(ext['_bpmnChildren']);
    walk(ext['_extensionElements']);
  };
  const walkNodes = (nodes: readonly FlowNode[], flows: readonly Flow[]): void => {
    for (const n of nodes) {
      addExt(n.extension);
      if (n.nodes?.length || n.flows?.length) walkNodes(n.nodes ?? [], n.flows ?? []);
    }
    for (const f of flows) addExt(f.extension);
  };

  walk(def.extraElements);
  for (const collab of def.collaborations ?? []) {
    walk(collab.extraElements);
    for (const p of collab.participants ?? []) addExt(p.extension);
  }
  for (const proc of def.processes) {
    addExt(proc.extension);
    walkNodes(proc.nodes, proc.flows);
  }
  return ids;
}

export function validateDefinition(
  input: unknown,
  opts: ValidateDefinitionOptions = {},
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const parsed = ProcessDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const p = issue.path.map((s) => String(s)).join('.');
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE, issue.message, {
          node: { path: p || '$' },
        }),
      );
    }
    return out; // 结构都不对，规则层无从下手
  }
  const def = parsed.data;

  /**
   * `id` 必须是合法的 `xsd:ID`（= NCName）。
   *
   * ★ 为什么这条是 **error**：我们的 SAX 不校验 id（宽容），所以非法 id 能写出去、
   * 我们自己也能读回来 —— 问题只在**别人的解析器**上才暴露（bpmn-moddle 报
   * `illegal ID <1s>` + `unresolved reference`，bpmn-js 丢图形）。
   * 产出一份别人读不了的文件，比报错严重得多，故在导出前必须拦住。
   */
  const checkId = (id: string, path: string): void => {
    if (isValidXmlId(id)) return;
    out.push(
      diagnostic(
        'error',
        MODDLE_DIAGNOSTIC_CODES.VALIDATE_INVALID_ID,
        `id '${id}' 不是合法的 XML id：xsd:ID 必须是 NCName（不能以数字/点/横杠开头，不能含空白与冒号）`,
        { node: { path }, suggestions: ['改成字母或下划线开头，如 Activity_0abc'] },
      ),
    );
  };

  checkId(def.id, 'id');

  const nodeIds = new Set<string>();
  const flowIds = new Set<string>();
  /** 重复检测专用（`nodeIds` / `flowIds` 是引用目标全集，不能拿来判重复） */
  const seenNodeIds = new Set<string>();
  const seenFlowIds = new Set<string>();
  const processIds = new Set<string>();

  /*
   * ★ 收集必须**递归进子流程**：子流程里的节点/连线同样是合法引用目标
   * （泳道 `flowNodeRef`、`sequenceFlow` 端点、`messageFlow` 端点、DI 的 `bpmnElement`）。
   * 只扫顶层的话 → 嵌套元素被判"不存在"，真实语料上一路误报几十条。
   */
  const collectIds = (nodes: readonly FlowNode[], flows: readonly Flow[]): void => {
    for (const n of nodes) {
      nodeIds.add(n.id);
      if (n.nodes?.length || n.flows?.length) collectIds(n.nodes ?? [], n.flows ?? []);
    }
    for (const f of flows) flowIds.add(f.id);
  };
  for (const proc of def.processes) collectIds(proc.nodes, proc.flows);

  for (const [pi, proc] of def.processes.entries()) {
    const pBase = joinPath('processes', pi);
    if (processIds.has(proc.id)) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DUPLICATE_ID, `process id 重复：${proc.id}`, {
          node: { id: proc.id, path: joinPath(pBase, 'id') },
        }),
      );
    }
    processIds.add(proc.id);
    checkId(proc.id, joinPath(pBase, 'id'));

    // 泳道：id 唯一 + 合法；`nodeIds` 悬空检查要等节点 id 收齐，放在最后统一做
    for (const [li, ls] of (proc.laneSets ?? []).entries()) {
      const lsBase = joinPath(pBase, 'laneSets', li);
      if (ls.id !== undefined) checkId(ls.id, joinPath(lsBase, 'id'));
      const lanesOf = (lanes: readonly Lane[], base: string): void => {
        for (const [ki, lane] of lanes.entries()) {
          const lBase = joinPath(base, 'lanes', ki);
          checkId(lane.id, joinPath(lBase, 'id'));
          if (lane.lanes?.length) lanesOf(lane.lanes, lBase);
        }
      };
      lanesOf(ls.lanes, lsBase);
    }

    for (const [ni, node] of proc.nodes.entries()) {
      const nBase = joinPath(pBase, 'nodes', ni);
      checkId(node.id, joinPath(nBase, 'id'));
      // ⚠️ 重复检测必须用**独立的 seen 集合**：`nodeIds` 已被预填充为"引用目标全集"，
      // 拿它判重复会把每个节点都判成重复。
      if (seenNodeIds.has(node.id)) {
        out.push(
          diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DUPLICATE_ID, `节点 id 重复：${node.id}`, {
            node: { id: node.id, path: joinPath(nBase, 'id') },
          }),
        );
      }
      seenNodeIds.add(node.id);

      // 元素类型是否在覆盖表内（warn）
      if (!findCoverage(node.type)) {
        out.push(
          diagnostic('warn', MODDLE_DIAGNOSTIC_CODES.VALIDATE_ELEMENT_UNSUPPORTED,
            `元素类型 '${node.type}' 不在覆盖表内（只会保全，不承诺 L1/L2/L3）`,
            {
              node: { id: node.id, path: joinPath(nBase, 'type') },
              suggestions: ['见 COVERED_ELEMENT_NAMES'],
            }),
        );
      }

      // 事件定义的 type 是否在 EventDefinition 后代里（warn）
      const ed = node.eventDefinition;
      if (ed && !EVENT_DEFINITION_TYPES.includes(ed['type'] as string)) {
        out.push(
          diagnostic('warn', MODDLE_DIAGNOSTIC_CODES.VALIDATE_ELEMENT_UNSUPPORTED,
            `eventDefinition.type '${String(ed['type'])}' 不在 BPMN EventDefinition 后代内`,
            {
              node: { id: node.id, path: joinPath(nBase, 'eventDefinition.type') },
              expected: [...EVENT_DEFINITION_TYPES],
            }),
        );
      }

      // `gatewayDirection` 必须是规范枚举值（写别的 = 非法 XML，XSD 会拒）
      const dir = node.gatewayDirection;
      if (dir !== undefined && !BPMN_GatewayDirection.includes(dir)) {
        out.push(
          diagnostic(
            'error',
            MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE,
            `gatewayDirection '${dir}' 不是 BPMN 规范取值`,
            {
              node: { id: node.id, path: joinPath(nBase, 'gatewayDirection') },
              expected: [...BPMN_GatewayDirection],
            },
          ),
        );
      }

      // `eventGatewayType` 必须是规范枚举值（写别的 = 非法 XML）
      const egt = node.eventGatewayType;
      if (egt !== undefined && !BPMN_EventBasedGatewayType.includes(egt)) {
        out.push(
          diagnostic(
            'error',
            MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE,
            `eventGatewayType '${egt}' 不是 BPMN 规范取值`,
            {
              node: { id: node.id, path: joinPath(nBase, 'eventGatewayType') },
              expected: [...BPMN_EventBasedGatewayType],
            },
          ),
        );
      }

      /*
       * `association` 的端点在 XSD 里是 **required**：
       * 缺了导出就是非法 XML（官方 XSD 实测 `cvc-complex-type.4: 元素 'bpmn:association' 中必须包含属性 'sourceRef'`），
       * 而调用方**看不出来** —— 我们自己的解析器宽容读得回来。故在导出前拦住。
       */
      if (node.type === 'association') {
        if (node.sourceRef === undefined || node.targetRef === undefined) {
          out.push(
            diagnostic(
              'error',
              MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF,
              `association '${node.id}' 缺 sourceRef / targetRef（XSD 里这两个是必填）`,
              { node: { id: node.id, path: joinPath(nBase, 'sourceRef') } },
            ),
          );
        }
        const ad = node.associationDirection;
        if (ad !== undefined && !BPMN_AssociationDirection.includes(ad)) {
          out.push(
            diagnostic(
              'error',
              MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE,
              `associationDirection '${ad}' 不是 BPMN 规范取值`,
              {
                node: { id: node.id, path: joinPath(nBase, 'associationDirection') },
                expected: [...BPMN_AssociationDirection],
              },
            ),
          );
        }
      }

      // 审批语义
      const approval = node.extension?.['floken:approval'];
      if (approval !== undefined) {
        out.push(
          ...validateApproval(approval, {
            nodeId: node.id,
            path: joinPath(nBase, "extension['floken:approval']"),
          }),
        );
      }
    }

    for (const [fi, flow] of proc.flows.entries()) {
      const fBase = joinPath(pBase, 'flows', fi);
      checkId(flow.id, joinPath(fBase, 'id'));
      if (seenFlowIds.has(flow.id)) {
        out.push(
          diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DUPLICATE_ID, `连线 id 重复：${flow.id}`, {
            node: { id: flow.id, path: joinPath(fBase, 'id') },
          }),
        );
      }
      seenFlowIds.add(flow.id);
      if (!nodeIds.has(flow.from)) {
        out.push(
          diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF, `from 指向不存在的节点：${flow.from}`, {
            node: { id: flow.id, path: joinPath(fBase, 'from') },
          }),
        );
      }
      if (!nodeIds.has(flow.to)) {
        out.push(
          diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF, `to 指向不存在的节点：${flow.to}`, {
            node: { id: flow.id, path: joinPath(fBase, 'to') },
          }),
        );
      }
    }
  }

  /*
   * `defaultFlow` 悬空检查必须放在**连线收集完之后**：
   * 它是「指向某条 sequenceFlow 的引用」，遍历节点时那批 id 还没齐。
   */
  for (const [pi, proc] of def.processes.entries()) {
    for (const [ni, node] of proc.nodes.entries()) {
      if (node.defaultFlow === undefined) continue;
      if (!flowIds.has(node.defaultFlow)) {
        out.push(
          diagnostic(
            'error',
            MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF,
            `defaultFlow 指向不存在的连线：${node.defaultFlow}`,
            { node: { id: node.id, path: joinPath('processes', pi, 'nodes', ni, 'defaultFlow') } },
          ),
        );
      }
    }
  }

  /*
   * 泳道的 `nodeIds`（`<bpmn:flowNodeRef>`）指向节点，同样要等节点 id 收齐才能查悬空。
   * ⚠️ 只给 **warn**：泳道归属错了是**渲染问题**（节点还是那些节点、流程照样跑），
   * 不该把整份模型判废。
   */
  for (const [pi, proc] of def.processes.entries()) {
    for (const [li, ls] of (proc.laneSets ?? []).entries()) {
      const walk = (lanes: readonly Lane[], base: string): void => {
        for (const [ki, lane] of lanes.entries()) {
          const lBase = joinPath('processes', pi, 'laneSets', li, 'lanes', ki);
          for (const [ri, ref] of (lane.nodeIds ?? []).entries()) {
            if (!nodeIds.has(ref)) {
              out.push(
                diagnostic(
                  'warn',
                  MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF,
                  `泳道 '${lane.id}' 的 flowNodeRef 指向不存在的节点：${ref}`,
                  { node: { id: lane.id, path: joinPath(lBase, 'nodeIds', ri) } },
                ),
              );
            }
          }
          if (lane.lanes?.length) walk(lane.lanes, lBase);
        }
      };
      walk(ls.lanes, joinPath('processes', pi, 'laneSets', li));
    }
  }

  // ── collaboration（泳道图 / 协作图，0..n） ──
  const participantIds = new Set<string>();
  for (const [ci, collab] of (def.collaborations ?? []).entries()) {
    const cBase = joinPath('collaborations', ci);
    checkId(collab.id, joinPath(cBase, 'id'));
    for (const [pi, p] of collab.participants.entries()) {
      const pp = joinPath(cBase, 'participants', pi);
      checkId(p.id, joinPath(pp, 'id'));
      if (participantIds.has(p.id)) {
        out.push(
          diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DUPLICATE_ID,
            `participant id 重复：${p.id}`, { node: { id: p.id, path: joinPath(pp, 'id') } }),
        );
      }
      participantIds.add(p.id);
    }
  }

  /*
   * `messageFlow` 的两端**不只是 participant**：BPMN 允许它连 `FlowNode`
   * （池内某个活动/事件发消息给另一个池的节点），MIWG `A.4.0` 实测就是这样。
   * 只认 participant 的话 → 26 条 error 误报，把合法文件判成废。
   * 合法端点 = participant ∪ 所有 process 的 flowNode（含子流程内）。
   */
  const messageEndpoints = new Set<string>([...participantIds, ...nodeIds]);
  for (const [ci, collab] of (def.collaborations ?? []).entries()) {
    const cBase = joinPath('collaborations', ci);
    for (const [mi, mf] of collab.messageFlows.entries()) {
      const mp = joinPath(cBase, 'messageFlows', mi);
      checkId(mf.id, joinPath(mp, 'id'));
      if (!messageEndpoints.has(mf.from)) {
        out.push(
          diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF,
            `messageFlow 的 from 指向不存在的元素（participant / 节点）：${mf.from}`,
            { node: { id: mf.id, path: joinPath(mp, 'from') } }),
        );
      }
      if (!messageEndpoints.has(mf.to)) {
        out.push(
          diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF,
            `messageFlow 的 to 指向不存在的元素（participant / 节点）：${mf.to}`,
            { node: { id: mf.id, path: joinPath(mp, 'to') } }),
        );
      }
    }
  }

  if (def.layout !== undefined) {
    /*
     * ★ `knownIds` 必须是**全部图面元素**的 id，不只是节点：
     * 连线（sequenceFlow）自己也有 `BPMNEdge`，漏了它就会把每条边的坐标都判成"悬空引用"
     * —— 真实语料上这一条就产生了 400+ 条噪音 warn。
     * 泳道 / 池 / messageFlow 同理。
     */
    const knownIds = new Set<string>([...nodeIds, ...flowIds]);
    for (const collab of def.collaborations ?? []) {
      knownIds.add(collab.id);
      for (const p of collab.participants) knownIds.add(p.id);
      for (const mf of collab.messageFlows) knownIds.add(mf.id);
    }
    for (const proc of def.processes) {
      const walkLanes = (lanes: readonly Lane[]): void => {
        for (const l of lanes) {
          knownIds.add(l.id);
          if (l.lanes?.length) walkLanes(l.lanes);
        }
      };
      for (const ls of proc.laneSets ?? []) {
        if (ls.id !== undefined) knownIds.add(ls.id);
        walkLanes(ls.lanes);
      }
    }
    /*
     * ★ 还有一类：**只保全、不建模**的元素（`dataInputAssociation` / `dataOutput` /
     * `group` …）。它们虽然没进 `nodes`，但在**原文件里是有坐标的**，
     * 对应 shape 一样合法 —— 不把它们的 id 算进来，真实语料会平白多出几十条
     * "shape 指向不存在的元素" 的噪音（MIWG 实测 76 条）。
     */
    for (const id of snapshotElementIds(def)) knownIds.add(id);
    out.push(...validateLayout(def.layout, { knownIds, path: 'layout' }));
  }

  return out;
}

/** 严格模式：有 error（或 `strict` 下的 warn）就抛 */
export function assertValidDefinition(
  input: unknown,
  opts: ValidateDefinitionOptions = {},
): ProcessDefinition {
  const ds = validateDefinition(input, opts);
  const bad = ds.filter((d) => d.severity === 'error' || (opts.strict && d.severity === 'warn'));
  if (bad.length) throw validationFailedError(bad.length, bad);
  return input as ProcessDefinition;
}
