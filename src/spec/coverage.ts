/**
 * 元素覆盖与「三层承诺」表。
 *
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §5
 *
 * ## 为什么这份表存在
 *
 * 「我们支持多少种 BPMN 元素」这个问题若靠**手列**回答，答案会不稳定（实测三次得 25 / 26 / 26），
 * 根因都一样：手判哪个类型是抽象的（`Task` 被误列过一次、`SubProcess` 被误列过一次）。
 *
 * 所以这里的规矩是：**集合由类型表自动推导，手工只声明层级**，
 * 再靠测试把「推导集合」与「手工表」双向钉死 —— 任何一边漂移都会 fail。
 *
 * ## 三层承诺
 *
 * - **L1 可画**：画布能拖出来 / 能渲染 / 能连线 → `designer`
 * - **L2 可存**：能进 Model JSON、能导出**合法** XML、往返不丢 → **本包**
 * - **L3 可执行**：引擎能正确推进 → `engine`
 *
 * ⚠️ `l3` 记的是**目标承诺**，不是当前已实现的现状。它是各包共同的单一事实源：
 * `engine` 只能在自己包里证明「已达到」，不能声称「超出」。
 */
import { BPMN_TYPES, isSubtypeOf, specOf, typeNameOf, xmlNameOf } from './index.js';

/* ───────────────────────────── 类型 ───────────────────────────── */

/** 元素族。字典序不重要，用途是让覆盖率报告能按族汇总。 */
export type ElementFamily =
  | 'event'
  | 'task'
  | 'gateway'
  | 'activity'
  | 'flow'
  | 'data'
  | 'choreography'
  | 'conversation'
  | 'collaboration'
  | 'artifact';

export interface ElementCoverage {
  /** XML 元素名 / Model JSON 的 `type`（`userTask`） */
  xmlName: string;
  /** BPMN 类型名（`UserTask`） */
  typeName: string;
  family: ElementFamily;
  /** L1 可画。`designer` v1.1+ 的目标；本包不实现，只代为登记 */
  l1: boolean;
  /** L2 可存。**本包的承诺，恒为 `true`** —— 语义层 137 个类型全部 L2 */
  l2: true;
  /** L3 可执行。`engine` 的目标承诺 */
  l3: boolean;
  /** 为什么在这个层级上 —— 尤其是「为什么不是 L3」 */
  note?: string;
}

/* ─────────────────── 可执行集合：一律从类型表推导 ─────────────────── */

/**
 * 可执行的 = FlowElement 的**非抽象**后代，再挖掉编排族。
 *
 * - 必须是 FlowElement 后代：只有它们能出现在 `process` 的流程图面上。
 * - 必须非抽象：抽象类型只是继承树的节点，XML 里不会出现 `<flowNode>`。
 * - 挖掉编排族：BPMN 规范自己就把编排（`choreographyTask` 等）定义为**非可执行**，
 *   它描述的是跨参与方的消息编舞，不是单一流程引擎的执行对象。
 */
export function deriveExecutableTypeNames(): readonly string[] {
  return BPMN_TYPES.filter(
    (t) =>
      !t.isAbstract &&
      isSubtypeOf(t.name, 'FlowElement') &&
      !isSubtypeOf(t.name, 'ChoreographyActivity'),
  ).map((t) => t.name);
}

/** 按继承树归类族。**祖先判定的先后顺序有意义**：`Task` 也是 `Activity` 的后代。 */
export function familyOf(typeName: string): ElementFamily {
  if (isSubtypeOf(typeName, 'Gateway')) return 'gateway';
  if (isSubtypeOf(typeName, 'Task')) return 'task';
  if (isSubtypeOf(typeName, 'Event')) return 'event';
  if (isSubtypeOf(typeName, 'Activity')) return 'activity';
  if (typeName === 'SequenceFlow') return 'flow';
  if (
    typeName === 'DataObject' ||
    typeName === 'DataObjectReference' ||
    typeName === 'DataStoreReference'
  ) {
    return 'data';
  }
  if (isSubtypeOf(typeName, 'ChoreographyActivity') || isSubtypeOf(typeName, 'Choreography')) {
    return 'choreography';
  }
  if (isSubtypeOf(typeName, 'ConversationNode') || isSubtypeOf(typeName, 'GlobalConversation')) {
    return 'conversation';
  }
  if (isSubtypeOf(typeName, 'Artifact')) return 'artifact';
  return 'collaboration';
}

/* ─────────────────── 不可执行族：显式登记，逐个校验 ─────────────────── */

/**
 * 规范自己定义为非可执行（或压根不是流程元素）的部分。
 *
 * ⚠️ **这份清单是显式枚举而非推导** —— 它们的共同点只有一个「不是可执行元素」，
 * 没法写出一条干净的推导规则（`lane` 与 `conversationLink` 都是 `BaseElement` 的直系后代，
 * 但跟写一篇注释的元素毫无关系）。所以走**登记制**：列出来，再由测试逐个断言它们确实存在、非抽象。
 */
export const NON_EXECUTABLE_ELEMENTS: readonly ElementCoverage[] = Object.freeze([
  // —— 编排族（5）：规范定义为跨参与方编舞，非可执行 ——
  { xmlName: 'choreography', typeName: 'Choreography', family: 'choreography', l1: false, l2: true, l3: false, note: '编舞图根，非可执行' },
  { xmlName: 'globalChoreographyTask', typeName: 'GlobalChoreographyTask', family: 'choreography', l1: false, l2: true, l3: false, note: '可复用的编舞任务定义' },
  { xmlName: 'choreographyTask', typeName: 'ChoreographyTask', family: 'choreography', l1: false, l2: true, l3: false, note: 'ChoreographyActivity 后代，非可执行' },
  { xmlName: 'callChoreography', typeName: 'CallChoreography', family: 'choreography', l1: false, l2: true, l3: false, note: '同上' },
  { xmlName: 'subChoreography', typeName: 'SubChoreography', family: 'choreography', l1: false, l2: true, l3: false, note: '同上' },
  // —— 会话族（5）：会话图是 BPMN 的"协作概览"视图，不参与执行 ——
  { xmlName: 'conversation', typeName: 'Conversation', family: 'conversation', l1: false, l2: true, l3: false, note: '会话节点' },
  { xmlName: 'callConversation', typeName: 'CallConversation', family: 'conversation', l1: false, l2: true, l3: false, note: '会话节点' },
  { xmlName: 'subConversation', typeName: 'SubConversation', family: 'conversation', l1: false, l2: true, l3: false, note: '会话节点' },
  { xmlName: 'globalConversation', typeName: 'GlobalConversation', family: 'conversation', l1: false, l2: true, l3: false, note: '可复用的会话定义' },
  { xmlName: 'conversationLink', typeName: 'ConversationLink', family: 'conversation', l1: false, l2: true, l3: false, note: '会话连线' },
  // —— 协作 / 泳道 / 消息流（5）——
  { xmlName: 'collaboration', typeName: 'Collaboration', family: 'collaboration', l1: false, l2: true, l3: false, note: '协作图根；泳道图的容器' },
  { xmlName: 'participant', typeName: 'Participant', family: 'collaboration', l1: true, l2: true, l3: false, note: '池道。**中国式审批流程图的高频需求**，L1 必开' },
  { xmlName: 'laneSet', typeName: 'LaneSet', family: 'collaboration', l1: true, l2: true, l3: false, note: '泳道容器；同上' },
  { xmlName: 'lane', typeName: 'Lane', family: 'collaboration', l1: true, l2: true, l3: false, note: '泳道；同上' },
  { xmlName: 'messageFlow', typeName: 'MessageFlow', family: 'collaboration', l1: true, l2: true, l3: false, note: '跨池消息流，不在 process 内' },
  // —— 工件族（3）：纯标注，引擎从不读 ——
  { xmlName: 'textAnnotation', typeName: 'TextAnnotation', family: 'artifact', l1: true, l2: true, l3: false, note: '批注' },
  { xmlName: 'group', typeName: 'Group', family: 'artifact', l1: true, l2: true, l3: false, note: '视觉分组' },
  { xmlName: 'association', typeName: 'Association', family: 'artifact', l1: true, l2: true, l3: false, note: '关联连线（如批注指向节点）' },
  // —— 关联族（3）： *_Association 不是 Artifact 后代，而是 BaseElement 直系 ——
  { xmlName: 'participantAssociation', typeName: 'ParticipantAssociation', family: 'collaboration', l1: false, l2: true, l3: false, note: '会话到参与者的绑定' },
  { xmlName: 'messageFlowAssociation', typeName: 'MessageFlowAssociation', family: 'collaboration', l1: false, l2: true, l3: false, note: '会话到消息流的绑定' },
  { xmlName: 'conversationAssociation', typeName: 'ConversationAssociation', family: 'conversation', l1: false, l2: true, l3: false, note: '会话之间的绑定' },
]);

/* ─────────────────── 可执行族的 L1/L3 手工声明 ─────────────────── */

/**
 * 27 类可执行元素的层级目标。
 *
 * ⚠️ 这里是**唯一允许手工的地方**，且只填 `l1` / `l3` / `note` —— `l2` 恒 true、
 * `xmlName` / `typeName` / `family` 一律由 {@link EXECUTABLE_ELEMENTS} 从类型表算出。
 * 键用 xmlName 是为了让这份声明读起来就是 XML 里的元素名。
 *
 * ⚠️ **L3 的唯一裁定方是 `03-engine` §6 / FR-E11**，本表不替 engine 做决定，
 * 只做转录 + 把它的口径含混处写精确。改动前先读那边，不要在这里自行增删。
 */
const LEVELS: Readonly<Record<string, { l1: boolean; l3: boolean; note?: string }>> = Object.freeze({
  /* 事件 6 */
  startEvent: { l1: true, l3: true },
  endEvent: { l1: true, l3: true },
  intermediateCatchEvent: { l1: true, l3: true },
  intermediateThrowEvent: { l1: true, l3: true },
  boundaryEvent: {
    l1: true, l3: true,
    // FR-E11 旧措辞是「BoundaryEvent（补偿变体）排除」，把**元素级**与**变体级**混在了一行。
    // 这里的口径：元素是可执行的（timer/message 变体都算），**补偿变体**才是待补项（FR-E13，S 级）。
    note: '元素可执行；**补偿变体除外**（FR-E13，S 级）',
  },
  implicitThrowEvent: { l1: false, l3: false, note: 'FR-E11 排除；随取消/补偿附带出现' },
  /* 任务 8 —— ★ 比旧表多一个裸 `task` */
  userTask: { l1: true, l3: true, note: '承载 `floken:approval`，★ 护城河元素' },
  serviceTask: { l1: true, l3: true },
  scriptTask: { l1: true, l3: true, note: '受限执行，**禁止 `eval` / `new Function`**（03 §6）' },
  sendTask: { l1: true, l3: true, note: '经 `EventSink` 或 handler 发消息' },
  receiveTask: { l1: true, l3: true, note: '须能等待并被外部消息唤醒' },
  manualTask: { l1: true, l3: true, note: '**不产生待办**，引擎只记事件' },
  businessRuleTask: { l1: true, l3: true, note: '经 `decisionHandler` SPI；不接 DMN 也能用' },
  task: { l1: true, l3: true, note: '★ 非抽象：规范里它就是「未指定类型的任务」，引擎按直通处理' },
  /* 网关 5 */
  exclusiveGateway: { l1: true, l3: true },
  inclusiveGateway: { l1: true, l3: true },
  parallelGateway: { l1: true, l3: true },
  eventBasedGateway: { l1: true, l3: false, note: 'FR-E11 排除；需事件订阅与竞态处理（FR-E14，S 级）' },
  complexGateway: { l1: true, l3: false, note: 'FR-E11 排除；行为由实现自定义，做浅了会**静默产出重复令牌**（03 §6）' },
  /* 活动/子流程 4 */
  subProcess: { l1: true, l3: true },
  adHocSubProcess: { l1: true, l3: false, note: 'FR-E11 排除；无固定顺序，与中国式审批的结构化诉求相悖' },
  transaction: { l1: true, l3: false, note: 'FR-E11 排除；需事务补偿协议（FR-E13，S 级）' },
  callActivity: { l1: true, l3: true, note: '须绑定**被调用定义的版本**（FR-E6）' },
  /* 连线 1 */
  sequenceFlow: { l1: true, l3: true },
  /* 数据/工件 3 —— 03 §6 定义为「引擎只读不写」，这本身就是一个已定义的执行行为 */
  dataObject: { l1: true, l3: true, note: '引擎**只读不写**，数据状态由业务方管理' },
  dataObjectReference: { l1: true, l3: true, note: '同上' },
  dataStoreReference: { l1: true, l3: true, note: '同上' },
});

/* ───────────────────────────── 产出 ───────────────────────────── */

/**
 * 27 类可执行元素。
 *
 * 注意这里读的是 {@link LEVELS}，键的集合必须与 {@link deriveExecutableTypeNames} 完全一致 ——
 * 不一致意味着「规范升级了」或「有人手改了其一」，测试会直接点名差异。
 */
export const EXECUTABLE_ELEMENTS: readonly ElementCoverage[] = Object.freeze(
  deriveExecutableTypeNames().map((typeName) => {
    const xmlName = xmlNameOf(typeName);
    const declared = LEVELS[xmlName];
    return {
      xmlName,
      typeName,
      family: familyOf(typeName),
      l1: declared?.l1 ?? false,
      l2: true,
      l3: declared?.l3 ?? false,
      ...(declared?.note === undefined ? {} : { note: declared.note }),
    } satisfies ElementCoverage;
  }),
);

/** 可执行 + 不可执行 = 全部登记的图面元素 */
export const ALL_COVERED_ELEMENTS: readonly ElementCoverage[] = Object.freeze([
  ...EXECUTABLE_ELEMENTS,
  ...NON_EXECUTABLE_ELEMENTS,
]);

const COVERAGE_INDEX: ReadonlyMap<string, ElementCoverage> = new Map(
  ALL_COVERED_ELEMENTS.map((e) => [e.xmlName, e]),
);

/**
 * 按 XML 元素名查覆盖率条目。
 *
 * 返回 `undefined` 表示**规范里没这个元素**，而不是「我们不支持」——
 * 这两件事必须分开：前者是调用方传错了名字，后者是本表的结论。
 * 白名单校验要用后者，请先看 {@link typeNameOf} 是不是有解。
 */
export function findCoverage(xmlName: string): ElementCoverage | undefined {
  return COVERAGE_INDEX.get(xmlName);
}

/** 找不到就抛。内部调用点用这个，省得每行都判空。 */
export function coverageOf(xmlName: string): ElementCoverage {
  const c = findCoverage(xmlName);
  if (!c) throw new Error(`未知的 BPMN 元素名：${xmlName}`);
  return c;
}

/**
 * 覆盖率报告（§9 API 清单 / AC-S5 引用）。
 *
 * **每个数字都从 {@link ALL_COVERED_ELEMENTS} 现算** —— 不另存一份统计、也不手列，
 * 手列正是「25 / 26 / 27 三个答案」那场事故的病根。
 */
export interface CoverageReport {
  /** 登记元素总数（= {@link COVERAGE_STATS}.coveredTotal） */
  total: number;
  /** 各层承诺数量；`L2 === total`（本包对登记元素全承诺） */
  byLevel: { L1: number; L2: number; L3: number };
  /** 按族汇总 */
  byFamily: Record<string, { total: number; l1: number; l2: number; l3: number }>;
  /** 可执行元素总数 / 不可执行登记数 */
  executable: number;
  nonExecutable: number;
  /**
   * **L3 缺口**：可执行但**不承诺**执行的元素（FR-E11 明确排除的那几类）。
   * 这是回答「还有多少种跑不了」的唯一合法出处 —— 别在别处另列一份。
   */
  l3Gaps: readonly string[];
  /** 规范类型表总数（137），用于说明「登记数 vs 规范总数」的差 */
  specTotal: number;
}

export function coverageReport(): CoverageReport {
  const byFamily: Record<string, { total: number; l1: number; l2: number; l3: number }> = {};
  for (const e of ALL_COVERED_ELEMENTS) {
    const row = (byFamily[e.family] ??= { total: 0, l1: 0, l2: 0, l3: 0 });
    row.total += 1;
    if (e.l1) row.l1 += 1;
    if (e.l2) row.l2 += 1;
    if (e.l3) row.l3 += 1;
  }
  return {
    total: ALL_COVERED_ELEMENTS.length,
    byLevel: {
      L1: ALL_COVERED_ELEMENTS.filter((e) => e.l1).length,
      L2: ALL_COVERED_ELEMENTS.filter((e) => e.l2).length,
      L3: ALL_COVERED_ELEMENTS.filter((e) => e.l3).length,
    },
    byFamily,
    executable: EXECUTABLE_ELEMENTS.length,
    nonExecutable: NON_EXECUTABLE_ELEMENTS.length,
    l3Gaps: EXECUTABLE_ELEMENTS.filter((e) => !e.l3).map((e) => e.xmlName),
    specTotal: BPMN_TYPES.length,
  };
}

/**
 * 覆盖率统计。**全部从数据算**，且必须满足 `executable + nonExecutable === coveredTotal`。
 */
export const COVERAGE_STATS: Readonly<Record<string, number>> = Object.freeze({
  executable: EXECUTABLE_ELEMENTS.length,
  nonExecutable: NON_EXECUTABLE_ELEMENTS.length,
  coveredTotal: ALL_COVERED_ELEMENTS.length,
  /** L2 是本包的承诺，必须等于登记总数，一个都不能少 */
  l2Count: ALL_COVERED_ELEMENTS.filter((e) => e.l2).length,
  /** L3 目标数 —— 这是对外说「能跑多少种」的唯一合法出处 */
  l3Target: ALL_COVERED_ELEMENTS.filter((e) => e.l3).length,
  l1Target: ALL_COVERED_ELEMENTS.filter((e) => e.l1).length,
});

/* ─────────────────── 自检：手改任何一个都会在这里炸 ─────────────────── */

/**
 * 交叉校验，返回差异描述；空数组表示两边一致。
 *
 * 三条必查：① 推导集合与手工表是否同源；② 每条登记项在语义层是否真有对应类型且非抽象；
 * ③ 两份清单不能有交集。
 * 它是 "登记制" 能站住的全部理由 —— 没有它，这份表就退回手列时代了。
 */
export function auditCoverage(): readonly string[] {
  const problems: string[] = [];

  const derived = new Set(deriveExecutableTypeNames().map(xmlNameOf));
  const declared = new Set(Object.keys(LEVELS));
  for (const name of declared) {
    if (!derived.has(name)) problems.push(`LEVELS 里的 ${name} 已不在类型表的可执行集合中`);
  }
  for (const name of derived) {
    if (!declared.has(name)) problems.push(`类型表算出的可执行元素 ${name} 没有在 LEVELS 里声明层级`);
  }

  for (const e of EXECUTABLE_ELEMENTS) {
    const t = typeNameOf(e.xmlName);
    if (!t) problems.push(`${e.xmlName} 在语义层没有对应的类型`);
    else if (specOf(t).isAbstract) problems.push(`${e.xmlName} 是抽象类型，不该进可执行集合`);
  }

  for (const e of NON_EXECUTABLE_ELEMENTS) {
    const t = typeNameOf(e.xmlName);
    if (!t) problems.push(`不可执行清单里的 ${e.xmlName} 在语义层没有对应的类型`);
    else if (specOf(t).isAbstract) problems.push(`${e.xmlName} 是抽象类型，登记它没意义`);
  }

  const overlap = EXECUTABLE_ELEMENTS.map((e) => e.xmlName).filter((n) =>
    NON_EXECUTABLE_ELEMENTS.some((x) => x.xmlName === n),
  );
  if (overlap.length) problems.push(`可执行与不可执行清单有交集：${overlap.join(', ')}`);

  return problems;
}
