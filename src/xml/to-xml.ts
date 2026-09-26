/**
 * `toXml()` —— Model JSON → 标准 BPMN 2.0 XML（S2）
 *
 * 四条纪律：
 * 1. **用构造器组装、不拼字符串**（§6.5.2）—— 拼错不报错、只静默产出非法文件，是最坏的一类 bug。
 * 2. **属性顺序与缩进固定** —— 输出的确定性是 AC-S2 / AC-S3 的前提。
 * 3. **`false` 必须写出来**（§6.5 坑 3）—— `isExecutable="false"` 与"没配"是两回事。
 * 4. **认不出的东西一律保全**（纪律一）：第三方元素原样快照、第三方属性原样写回。
 *
 * 元素名映射的唯一事实源是 `spec/coverage.ts`（27 类可执行 + 21 类不可执行）；
 * 不在覆盖表内的元素**默认抛错**（FR-S8 / AC-S6），可显式降级为告警。
 */

import {
  MODDLE_DIAGNOSTIC_CODES,
  MODDLE_ERROR_CODES,
  ModdleError,
  diagnostic,
  unknownOptionError,
  type Diagnostic,
} from '../core/errors.js';
import { ensureLayout } from '../layout/auto-layout.js';
import {
  FEEL_EXPRESSION_LANGUAGE,
  MODEL_SCHEMA_VERSION,
  type Collaboration,
  type EventDefinition,
  type ExtensionBag,
  type Flow,
  type FlowNode,
  type FormalExpression,
  type Lane,
  type LaneSet,
  type MessageFlow,
  type Participant,
  type Process,
  type ProcessDefinition,
} from '../model/definition.js';
import type { Layout, ShapeLayout } from '../model/layout.js';
import { findCoverage } from '../spec/coverage.js';
import { effectiveProperties } from '../spec/index.js';
import {
  BUILTIN_PREFIX_NS,
  DEFAULT_PREFIXES,
  FLOKEN_NS,
  FLOKEN_PREFIX,
  KNOWN_EXT_NS,
  TARGET_NS,
  splitQName,
} from './namespaces.js';
import { jsonToXml } from './value.js';
import { RawXml, el, serializeXml, type AttrValue, type XmlBuilder, type XmlChild } from './writer.js';

const P = 'bpmn';
const DI = 'bpmndi';
const DC = 'dc';
const DDI = 'di';
/** 内置前缀（永远生效、不需要声明）—— 见 `namespaces.ts` 的 {@link XML_NS} */
const XML_PREFIX = 'xml';

/**
 * 事件定义里的 **ISO 8601 字面量**元素（不是表达式）。
 * `tFormalExpression` 的 `language` 不该套在它们头上 —— 见 {@link eventDefinitionToXml}。
 */
const TIMER_ELEMENTS: ReadonlySet<string> = new Set(['timeDuration', 'timeDate', 'timeCycle']);

export interface ToXmlOptions {
  /** 缩进（默认两空格） */
  indent?: string;
  /** 是否输出 `<?xml …?>`（默认 true） */
  declaration?: boolean;
  /** 是否输出 `floken:*` 自有扩展（默认 true；`false` = 纯净化导出，FR-S12） */
  includeExtensions?: boolean;
  /** `layout` 缺失时是否自动补（默认 true —— 没有 DI 的标准工具会显示 "no diagram to display"） */
  autoLayout?: boolean;
  /** 覆盖表外的元素怎么处置：默认 `'throw'`（FR-S8 / AC-S6） */
  onUnsupported?: 'throw' | 'warn';
  /** 降级告警的出口（与 `onUnsupported:'warn'` 配套；不给则丢弃告警） */
  onDiagnostic?: (d: Diagnostic) => void;
}

export const TO_XML_OPTION_KEYS: readonly string[] = Object.freeze([
  'indent',
  'declaration',
  'includeExtensions',
  'autoLayout',
  'onUnsupported',
  'onDiagnostic',
]);

/** `meta` 里的保留键：文件级信息（模型里没有专门字段，但不能丢） */
export const META_NAMESPACES_KEY = '@namespaces';
export const META_DEFINITIONS_KEY = '@definitions';

interface Ctx {
  includeExt: boolean;
  warn: (d: Diagnostic) => void;
  onUnsupported: 'throw' | 'warn';
}

// ─────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────

/** 同步版（内部与测试用） */
export function toXmlSync(def: ProcessDefinition, opts: ToXmlOptions = {}): string {
  for (const k of Object.keys(opts)) {
    if (!TO_XML_OPTION_KEYS.includes(k)) throw unknownOptionError(k, TO_XML_OPTION_KEYS);
  }
  if (!def || typeof def !== 'object' || !Array.isArray(def.processes)) {
    throw new ModdleError('definition must be a ProcessDefinition', {
      code: MODDLE_ERROR_CODES.ARG_INVALID_INPUT,
      details: { what: 'definition', expected: 'ProcessDefinition' },
    });
  }
  const includeExt = opts.includeExtensions !== false;
  const ctx: Ctx = {
    includeExt,
    warn: (d) => opts.onDiagnostic?.(d),
    onUnsupported: opts.onUnsupported ?? 'throw',
  };

  // ── definitions ──
  const nsAttrs: Record<string, AttrValue> = {};
  for (const [prefix, uri] of DEFAULT_PREFIXES) {
    /*
     * ⚠️ `floken` 前缀**不再随净化剔除**：`floken:schemaVersion` 是格式身份、恒写
     * （见下方定义属性处），前缀不声明就会产出"用了未声明前缀"的非法 XML。
     * 净化剔的是**属性**（approval / formKey …），不是命名空间本身。
     */
    nsAttrs[`xmlns:${prefix}`] = uri;
  }
  void includeExt;
  const knownUris = new Set(DEFAULT_PREFIXES.map(([, u]) => u));
  for (const [prefix, uri] of Object.entries(readNamespaces(def)).sort()) {
    if (knownUris.has(uri)) continue;
    nsAttrs[`xmlns:${prefix}`] = uri;
  }
  /*
   * ★ 第三方属性（`camunda:assignee` 这类）用到的前缀**必须先声明**，否则产出的是非法 XML。
   * 解析顺序：文件里记的 `meta['@namespaces']` → 内置 `KNOWN_EXT_NS`；
   * 两处都没有就**抛** —— 凭空编一个 URI 会让文件静默变成另一个语义。
   */
  for (const prefix of collectExtPrefixes(def)) {
    // ★ 三顺位必须与下面的 `completeNamespaceDecls` **完全一致**：
    // 少了 `BUILTIN_PREFIX_NS` 这一档，`xsi:type="bpmn:userTask"` 这种合法属性
    // 会被当成"没登记的第三方前缀"直接抛错（互操作实证抓到）。
    const uri =
      readNamespaces(def)[prefix] ?? BUILTIN_PREFIX_NS[prefix] ?? KNOWN_EXT_NS[prefix];
    if (!uri) {
      throw new ModdleError('第三方扩展前缀没有对应的命名空间 URI', {
        code: MODDLE_ERROR_CODES.XML_UNSUPPORTED_VALUE,
        hint: `在 meta['@namespaces'] 里登记 { ${prefix}: '<URI>' }，或改用已知前缀：${Object.keys(KNOWN_EXT_NS).join(', ')}`,
        details: { prefix },
      });
    }
    if (knownUris.has(uri)) continue;
    knownUris.add(uri);
    nsAttrs[`xmlns:${prefix}`] = uri;
  }
  const defAttrs: Record<string, AttrValue> = {
    ...nsAttrs,
    id: def.id,
    targetNamespace: TARGET_NS,
    ...(def.name !== undefined ? { name: def.name } : {}),
    ...readDefinitionAttrs(def),
  };
  /*
   * `schemaVersion` / `version` 在 BPMN 里没有对应属性 → 走自有前缀（§6.6：绝不动规范属性）。
   * 它们**必须**落盘：AC-S2 要求 `fromXml(toXml(m))` 与 `m` 全等，丢了这两个字段就等不了。
   *
   * ★ 且**不受 `includeExtensions` 门控**：净化（§6.4）剔的是**审批语义**扩展
   * （`floken:approval` / `floken:formKey` …），而这两个是 **Model JSON 自身的格式身份**。
   * 曾经跟着一起剔 → 净化导出再读回，`schemaVersion` 从 `2.3.4` 悄悄变回 `1.0.0`、
   * `version` 直接消失 —— 一份文件被静默换了个身份，这比"文件里多两个属性"严重得多。
   */
  defAttrs[`${FLOKEN_PREFIX}:schemaVersion`] = def.schemaVersion ?? MODEL_SCHEMA_VERSION;
  if (def.version !== undefined) defAttrs[`${FLOKEN_PREFIX}:version`] = def.version;

  const kids: XmlChild[] = [];
  const defExt = definitionsExtensionToXml(def, includeExt);
  if (defExt) kids.push(defExt);
  if (def.description !== undefined) kids.push(el(`${P}:documentation`, {}, [def.description]));
  for (const d of def.extraDocumentations ?? []) kids.push(el(`${P}:documentation`, {}, [d]));

  /*
   * ★ `collaboration` 与 `process` 都是 `rootElement`（XSD 里是同一层的 choice），
   * 顺序自由；惯例（也是 Camunda Modeler 的写法）是 **collaboration 在前**。
   *
   * `extraElements` 是那些**不落地**但必须保全的东西（编排族 / 会话族 /
   * `<bpmn:message>` / `<bpmn:signal>` / `<bpmn:error>` …）—— 它们同样占 rootElement 位，
   * 故放在 process 之后、DI 之前。
   */
  // `collaboration` 是 0..n（XSD maxOccurs=unbounded），全部写出
  for (const collab of def.collaborations ?? []) kids.push(collaborationToXml(collab, ctx));
  for (const proc of def.processes) kids.push(processToXml(proc, ctx));
  if (Array.isArray(def.extraElements)) {
    for (const s of def.extraElements) if (typeof s === 'string' && s) kids.push(new RawXml(s));
  }
  const layout = opts.autoLayout === false ? def.layout : ensureLayout(def);
  if (layout) kids.push(diagramToXml(def, layout, ctx));

  const root = el(`${P}:definitions`, defAttrs, kids);
  /*
   * ★ 最后一道兜底：**扫最终生成的树**，凡用到却没声明的前缀一律补上 `xmlns:`。
   *
   * 为什么需要它：`collectExtPrefixes()` 扫的是 **Model JSON**，而有一路属性
   * 根本不经过模型字段 —— `meta['@definitions']`（`definitions` 上的第三方属性，
   * 例如 Camunda 的 `camunda:diagramRelationId`）。漏了它就会写出
   * 「用了未声明前缀」的**非法**文件，MIWG 的 C.9.0 / C.9.2 正是这么炸的
   * （我们导出的文件，我们自己的解析器都读不回来）。
   *
   * URI 来源：`meta['@namespaces']` → `KNOWN_EXT_NS`；都没有就抛（不凭空编 URI）。
   */
  completeNamespaceDecls(root, def);

  return serializeXml(root, {
    ...(opts.indent !== undefined ? { indent: opts.indent } : {}),
    ...(opts.declaration !== undefined ? { declaration: opts.declaration } : {}),
  });
}

/** 文档口径的异步入口（§9 API 清单） */
export async function toXml(def: ProcessDefinition, opts: ToXmlOptions = {}): Promise<string> {
  return toXmlSync(def, opts);
}

/**
 * 扫整棵树，给「用到但没声明」的前缀补 `xmlns:`。
 *
 * 确定性：待补前缀**排序后追加**，输出字节永远一致（AC-S3 依赖它）。
 * `RawXml` 片段**跳过** —— 那是别人的 XML，快照时已自带它用到的声明。
 */
function completeNamespaceDecls(root: XmlBuilder, def: ProcessDefinition): void {
  const used = new Set<string>();
  const walk = (node: XmlBuilder): void => {
    // ★ `xml` 是内置前缀（W3C Namespaces §3）：**不需要**声明，也不该给它编 URI
    const p = splitQName(node.name).prefix;
    if (p && p !== XML_PREFIX) used.add(p);
    for (const [k] of node.attrs) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
      const ap = splitQName(k).prefix;
      if (ap && ap !== XML_PREFIX) used.add(ap);
    }
    for (const c of node.children) {
      if (typeof c !== 'string' && !(c instanceof RawXml)) walk(c);
    }
  };
  walk(root);

  const declared = new Set<string>();
  for (const [k, v] of root.attrs) {
    if (k.startsWith('xmlns:')) declared.add(k.slice(6));
    else if (k !== 'xmlns') continue;
    void v;
  }

  const fromMeta = readNamespaces(def);
  for (const prefix of [...used].sort()) {
    if (declared.has(prefix)) continue;
    // 兜底三顺位：用户登记（meta['@namespaces']）→ **内置前缀** → 已知第三方。
    // 内置必须在中间：floken/bpmn/xsi 任何时候写出去都得有声明，否则是非法 XML。
    const uri = fromMeta[prefix] ?? BUILTIN_PREFIX_NS[prefix] ?? KNOWN_EXT_NS[prefix];
    if (!uri) {
      throw new ModdleError('第三方扩展前缀没有对应的命名空间 URI', {
        code: MODDLE_ERROR_CODES.XML_UNSUPPORTED_VALUE,
        hint: `在 meta['@namespaces'] 里登记 { ${prefix}: '<URI>' }，或改用已知前缀：${Object.keys(KNOWN_EXT_NS).join(', ')}`,
        details: { prefix },
      });
    }
    root.attrs.push([`xmlns:${prefix}`, uri]);
    declared.add(prefix);
  }
}

// ─────────────────────────────────────────────────────────────────
// process / 节点 / 连线
// ─────────────────────────────────────────────────────────────────

function processToXml(proc: Process, ctx: Ctx): XmlBuilder {
  const kids: XmlChild[] = [];
  const ext = extensionToXml(proc.extension, 'Process', ctx);
  if (ext) kids.push(ext);
  if (proc.description !== undefined) kids.push(el(`${P}:documentation`, {}, [proc.description]));
  for (const d of proc.extraDocumentations ?? []) kids.push(el(`${P}:documentation`, {}, [d]));

  /*
   * ★ 顺序**不是**排版偏好，是 XSD 的 `xsd:sequence`：
   * `extensionElements` → `laneSet*` → `flowElement*` → `artifact*`。
   * 泳道写在节点之后、或批注夹在节点之间，产出的是**非法** BPMN
   * （bpmn-moddle 报 unparsable，严格 XSD 校验器直接拒收）。
   */
  for (const ls of proc.laneSets ?? []) kids.push(laneSetToXml(ls, ctx));

  const flowEls: XmlChild[] = [];
  const artifacts: XmlChild[] = [];
  for (const n of proc.nodes) {
    const target = findCoverage(n.type)?.family === 'artifact' ? artifacts : flowEls;
    target.push(nodeToXml(n, ctx));
  }
  kids.push(...flowEls);
  for (const f of proc.flows) kids.push(flowToXml(f, ctx));
  kids.push(...artifacts);

  return el(
    `${P}:process`,
    {
      id: proc.id,
      ...(proc.name !== undefined ? { name: proc.name } : {}),
      // ★ `false` 与"没配"不同，必须写出来（§6.5 坑 3）
      ...(proc.executable !== undefined ? { isExecutable: proc.executable } : {}),
      ...extensionAttrs(proc.extension, 'Process', ctx),
    },
    kids,
  );
}

function nodeToXml(node: FlowNode, ctx: Ctx): XmlBuilder {
  const covered = findCoverage(node.type);
  if (!covered) {
    const msg = `元素类型 '${node.type}' 不在覆盖表内`;
    const at = { id: node.id, path: 'processes[].nodes[].type' };
    if (ctx.onUnsupported === 'throw') {
      throw new ModdleError(msg, {
        code: MODDLE_ERROR_CODES.XML_UNSUPPORTED_ELEMENT,
        node: at,
        hint: '见 COVERED_ELEMENT_NAMES；确需导出请传 onUnsupported:"warn"',
        details: { type: node.type, id: node.id },
      });
    }
    ctx.warn({
      severity: 'warn',
      code: 'MODDLE_VALIDATE_ELEMENT_UNSUPPORTED',
      message: msg,
      node: at,
    });
  }

  const typeName = node.type.charAt(0).toUpperCase() + node.type.slice(1);
  const attrs: Record<string, AttrValue> = { id: node.id };
  if (node.name !== undefined) attrs['name'] = node.name;
  if (node.type === 'boundaryEvent' && node.attachedTo) attrs['attachedToRef'] = node.attachedTo;
  /*
   * ★ `formKey` 不是 BPMN 规范属性 → 走自有前缀，绝不动规范属性（§6.6）。
   *
   * 受 `includeExtensions` 门控：§6.4 定义纯净化导出 = 「去掉 `floken:*` 后仍是合法 BPMN」，
   * `floken:formKey` 属自有语义，净化时一并去掉是**符合文档口径**的。
   */
  if (node.formKey !== undefined && ctx.includeExt) attrs[`${FLOKEN_PREFIX}:formKey`] = node.formKey;

  /*
   * ★ **先写 extension、再写一等字段** —— 顺序本身就是"谁说了算"。
   *
   * 反过来写（先一等字段后 extension）时，`Object.assign` 会让袋子里的**字符串**覆盖
   * 一等字段：用户把 `triggeredByEvent` 改成 `false`，导出仍是 `true`（实证）。
   * 一等字段是单一事实源，保全是兜底，不能反客为主。
   */
  Object.assign(attrs, extensionAttrs(node.extension, typeName, ctx));

  /*
   * ★ 组 A：BPMN 规范属性（§6.6）—— **一等字段，不是 extension**。
   * 顺序固定（输出确定），且**不受 `includeExtensions` 门控**：
   * 净化剔除的是 `floken:*` 自有语义与第三方扩展，规范属性是 BPMN 本体，剔了就不是 BPMN 了。
   */
  if (node.defaultFlow !== undefined) attrs['default'] = node.defaultFlow;
  if (node.implementation !== undefined) attrs['implementation'] = node.implementation;
  if (node.operationRef !== undefined) attrs['operationRef'] = node.operationRef;
  if (node.messageRef !== undefined) attrs['messageRef'] = node.messageRef;
  if (node.scriptFormat !== undefined) attrs['scriptFormat'] = node.scriptFormat;
  if (node.gatewayDirection !== undefined) attrs['gatewayDirection'] = node.gatewayDirection;
  if (node.triggeredByEvent !== undefined) attrs['triggeredByEvent'] = node.triggeredByEvent;
  if (node.calledElement !== undefined) attrs['calledElement'] = node.calledElement;
  if (node.dataObjectRef !== undefined) attrs['dataObjectRef'] = node.dataObjectRef;
  if (node.dataStoreRef !== undefined) attrs['dataStoreRef'] = node.dataStoreRef;
  // 组 A 第二批（执行语义关键）
  if (node.isForCompensation !== undefined) attrs['isForCompensation'] = node.isForCompensation;
  if (node.startQuantity !== undefined) attrs['startQuantity'] = node.startQuantity;
  if (node.completionQuantity !== undefined) attrs['completionQuantity'] = node.completionQuantity;
  if (node.cancelActivity !== undefined) attrs['cancelActivity'] = node.cancelActivity;
  if (node.isInterrupting !== undefined) attrs['isInterrupting'] = node.isInterrupting;
  if (node.eventGatewayType !== undefined) attrs['eventGatewayType'] = node.eventGatewayType;
  if (node.instantiate !== undefined) attrs['instantiate'] = node.instantiate;
  if (node.parallelMultiple !== undefined) attrs['parallelMultiple'] = node.parallelMultiple;
  if (node.itemSubjectRef !== undefined) attrs['itemSubjectRef'] = node.itemSubjectRef;
  if (node.isCollection !== undefined) attrs['isCollection'] = node.isCollection;

  const kids: XmlChild[] = [];
  if (node.description !== undefined) kids.push(el(`${P}:documentation`, {}, [node.description]));
  for (const d of node.extraDocumentations ?? []) kids.push(el(`${P}:documentation`, {}, [d]));
  // ★ `<bpmn:text>` 是 textAnnotation 的规范子元素（不是扩展），只能挂在它身上
  if (node.text !== undefined && node.type === 'textAnnotation') {
    kids.push(el(`${P}:text`, {}, [node.text]));
  }
  const ext = extensionToXml(node.extension, typeName, ctx);
  if (ext) kids.push(ext);
  if (node.eventDefinition) kids.push(eventDefinitionToXml(node.eventDefinition));
  // 规范**子元素**（不是属性）：`<bpmn:script>` / `<bpmn:activationCondition>`
  if (node.script !== undefined) kids.push(el(`${P}:script`, {}, [node.script]));
  if (node.activationCondition !== undefined) {
    kids.push(formalExpressionEl('activationCondition', node.activationCondition, false));
  }
  // 容器：内嵌元素直接写在元素里（BPMN 的 subProcess 本就如此，没有单独的容器元素）
  if (node.nodes?.length) for (const n of node.nodes) kids.push(nodeToXml(n, ctx));
  if (node.flows?.length) for (const f of node.flows) kids.push(flowToXml(f, ctx));

  return el(`${P}:${node.type}`, attrs, kids);
}

/**
 * `tFormalExpression` 的构造（`conditionExpression` / `activationCondition` 共用）。
 *
 * @param xsiType 是否写 `xsi:type="bpmn:tFormalExpression"`：
 *   XSD 里 `<conditionExpression>` 的声明类型是 `tExpression`（抽象父类型），**必须**写；
 *   `<activationCondition>` 的声明类型**就是** `tFormalExpression`，写了是多余的。
 */
function formalExpressionEl(
  localName: string,
  expr: string | FormalExpression,
  xsiType: boolean,
): XmlBuilder {
  const fe: FormalExpression =
    typeof expr === 'string' ? { body: expr, language: FEEL_EXPRESSION_LANGUAGE } : expr;
  /*
   * ★ `language` 必须写出来：`<definitions expressionLanguage>` 的 XSD 默认值是 XPath，
   * 不写就等于声明这是 XPath，`amount > 5000` 会被当成节点集比较（§4.3 / FR-9.11）。
   */
  return el(
    `${P}:${localName}`,
    {
      ...(xsiType ? { 'xsi:type': 'bpmn:tFormalExpression' } : {}),
      language: fe.language ?? FEEL_EXPRESSION_LANGUAGE,
      ...(fe.evaluatesToTypeRef ? { evaluatesToTypeRef: fe.evaluatesToTypeRef } : {}),
    },
    [fe.body],
  );
}

// ─────────────────────────────────────────────────────────────────
// 泳道 / 协作图
// ─────────────────────────────────────────────────────────────────

function laneSetToXml(ls: LaneSet, ctx: Ctx): XmlBuilder {
  const kids: XmlChild[] = [];
  for (const lane of ls.lanes) kids.push(laneToXml(lane, ctx));
  return el(
    `${P}:laneSet`,
    {
      // `laneSet@id` 是 optional：没有就不写（写了空串 = 非法 `xsd:ID`）
      ...(ls.id !== undefined ? { id: ls.id } : {}),
      ...(ls.name !== undefined ? { name: ls.name } : {}),
      ...extensionAttrs(ls.extension, 'LaneSet', ctx),
    },
    kids,
  );
}

function laneToXml(lane: Lane, ctx: Ctx): XmlBuilder {
  const kids: XmlChild[] = [];
  const ext = extensionToXml(lane.extension, 'Lane', ctx);
  if (ext) kids.push(ext);
  // ★ 泳道真正的数据：`<bpmn:flowNodeRef>`（丢失 = 导出后泳道变空壳）
  for (const id of lane.nodeIds ?? []) kids.push(el(`${P}:flowNodeRef`, {}, [id]));
  for (const child of lane.lanes ?? []) kids.push(laneToXml(child, ctx));
  return el(
    `${P}:lane`,
    {
      id: lane.id,
      ...(lane.name !== undefined ? { name: lane.name } : {}),
      ...(lane.partitionElementRef !== undefined ? { partitionElementRef: lane.partitionElementRef } : {}),
      ...extensionAttrs(lane.extension, 'Lane', ctx),
    },
    kids,
  );
}

function collaborationToXml(c: Collaboration, ctx: Ctx): XmlBuilder {
  const kids: XmlChild[] = [];
  for (const p of c.participants) kids.push(participantToXml(p, ctx));
  for (const mf of c.messageFlows) kids.push(messageFlowToXml(mf, ctx));
  const snapshots = c.extraElements;
  if (Array.isArray(snapshots)) for (const s of snapshots) if (typeof s === 'string' && s) kids.push(new RawXml(s));
  return el(
    `${P}:collaboration`,
    {
      id: c.id,
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...extensionAttrs(c.extension, 'Collaboration', ctx),
    },
    kids,
  );
}

function participantToXml(p: Participant, ctx: Ctx): XmlBuilder {
  const ext = extensionToXml(p.extension, 'Participant', ctx);
  return el(
    `${P}:participant`,
    {
      id: p.id,
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.processRef !== undefined ? { processRef: p.processRef } : {}),
      ...extensionAttrs(p.extension, 'Participant', ctx),
    },
    ext ? [ext] : [],
  );
}

function messageFlowToXml(mf: MessageFlow, ctx: Ctx): XmlBuilder {
  const ext = extensionToXml(mf.extension, 'MessageFlow', ctx);
  return el(
    `${P}:messageFlow`,
    {
      id: mf.id,
      ...(mf.name !== undefined ? { name: mf.name } : {}),
      sourceRef: mf.from,
      targetRef: mf.to,
      ...extensionAttrs(mf.extension, 'MessageFlow', ctx),
    },
    ext ? [ext] : [],
  );
}

function flowToXml(flow: Flow, ctx: Ctx): XmlBuilder {
  const kids: XmlChild[] = [];
  // `documentation` 必须写在 `conditionExpression` 之前（XSD：基类 sequence 在前）
  if (flow.description !== undefined) kids.push(el(`${P}:documentation`, {}, [flow.description]));
  for (const d of flow.extraDocumentations ?? []) kids.push(el(`${P}:documentation`, {}, [d]));
  if (flow.condition !== undefined) {
    kids.push(formalExpressionEl('conditionExpression', flow.condition, true));
  }
  const ext = extensionToXml(flow.extension, 'SequenceFlow', ctx);
  if (ext) kids.push(ext);

  return el(
    `${P}:sequenceFlow`,
    {
      id: flow.id,
      sourceRef: flow.from,
      targetRef: flow.to,
      ...(flow.name !== undefined ? { name: flow.name } : {}),
      ...(flow.isImmediate !== undefined ? { isImmediate: flow.isImmediate } : {}),
      ...extensionAttrs(flow.extension, 'SequenceFlow', ctx),
    },
    kids,
  );
}

function eventDefinitionToXml(ed: EventDefinition): XmlBuilder {
  const type = String(ed['type'] ?? '');
  const typeName = `${type.charAt(0).toUpperCase()}${type.slice(1)}EventDefinition`;
  const props = effectiveProperties(typeName);
  const attrs: Record<string, AttrValue> = {};
  const kids: XmlChild[] = [];

  for (const [k, v] of Object.entries(ed)) {
    if (k === 'type' || v === undefined) continue;
    if (typeof v === 'object' && v !== null) {
      const fe = v as FormalExpression;
      /*
       * ★ timer 三件套（`timeDuration` / `timeDate` / `timeCycle`）的内容是 **ISO 8601 字面量**
       * （`PT1H` / `R3/PT10H`），**不是 FEEL** —— 硬塞 `language=…FEEL` 是把语义改错了。
       * 所以这里只在**原文件本来就写了** language 时才回写。
       */
      const isTimerLiteral = TIMER_ELEMENTS.has(k);
      kids.push(
        el(
          `${P}:${k}`,
          {
            'xsi:type': 'bpmn:tFormalExpression',
            ...(isTimerLiteral
              ? fe.language !== undefined
                ? { language: fe.language }
                : {}
              : { language: fe.language ?? FEEL_EXPRESSION_LANGUAGE }),
            ...(fe.evaluatesToTypeRef ? { evaluatesToTypeRef: fe.evaluatesToTypeRef } : {}),
          },
          [fe.body],
        ),
      );
      continue;
    }
    // 规范里声明为 attribute 的（messageRef / signalRef / operationRef …）写回属性，其余写子元素
    if (props.get(k)?.isAttr) attrs[k] = String(v);
    else kids.push(el(`${P}:${k}`, {}, [String(v)]));
  }
  return el(`${P}:${type}EventDefinition`, attrs, kids);
}

// ─────────────────────────────────────────────────────────────────
// extension 保全（纪律一）
// ─────────────────────────────────────────────────────────────────

const RESERVED_EXT_KEYS: readonly string[] = Object.freeze(['floken:approval', '_extensionElements']);

/**
 * `extension` 里**能写成 XML 属性**的部分（与 {@link extensionToXml} 互补，两处判据必须一致）。
 *
 * 判据：
 * - 键带前缀（`camunda:assignee`）→ 第三方属性，原样写回（FR-S13）；
 * - 键不带前缀 → 只有它是该元素在规范里声明的 `isAttr` 属性时才写成属性，
 *   否则走 {@link extensionToXml} 落成 `floken:` 元素 —— 拼错的字段名不该变成非法 XML 属性。
 */
function extensionAttrs(ext: ExtensionBag | undefined, typeName: string, ctx: Ctx): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  if (!ext) return out;
  const props = effectiveProperties(typeName);
  for (const [k, v] of Object.entries(ext)) {
    if (RESERVED_EXT_KEYS.includes(k)) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    const { prefix } = splitQName(k);
    // ★ `floken:` 不是第三方：它是我们自己的扩展，走与「无前缀」同一条路（元素 + `t` 标记）
    /*
     * ⚠️ 这里**不**做 `includeExt` 门控：§6.4 的净化口径是「去掉 `floken:*`」，
     * 而 `camunda:assignee` 这类是**用户原文件里保回来的第三方数据**（FR-S13 承诺还原成原生属性）。
     * 净化是「脱敏自有语义」，不是「清洗用户文件」—— 把它也剔掉会破坏往返不丢的纪律。
     */
    if (prefix && prefix !== FLOKEN_PREFIX) {
      out[k] = v;
      continue;
    }
    if (prefix === FLOKEN_PREFIX && !ctx.includeExt) continue;
    // 无前缀的键：只有规范里声明为 attribute 的才写回属性（拼错的字段名不该变成非法 XML 属性）。
    if (props.get(k)?.isAttr === true) out[k] = v;
  }
  return out;
}

/** `<extensionElements>` —— 审批语义 + 第三方元素原样快照 + 兜底的自有扩展值 */
function extensionToXml(ext: ExtensionBag | undefined, typeName: string, ctx: Ctx): XmlBuilder | undefined {
  if (!ext) return undefined;
  const props = effectiveProperties(typeName);
  const kids: XmlChild[] = [];

  const approval = ext['floken:approval'];
  if (approval !== undefined && ctx.includeExt) {
    const built = jsonToXml('approval', approval, FLOKEN_PREFIX);
    if (built) kids.push(built);
  }

  /*
   * 第三方元素：导入时存的是**规范化后的原样 XML 字符串**，这里原样嵌回。
   * 与属性同理（见 {@link extensionAttrs}）：净化只脱 `floken:*`，第三方数据照留。
   */
  const snapshots = ext['_extensionElements'];
  if (Array.isArray(snapshots)) {
    for (const s of snapshots) {
      if (typeof s === 'string' && s) kids.push(new RawXml(s));
    }
  }

  // 其余键：写不成属性的在这里兜底 —— 不认识的值也不能丢（纪律一：绝不静默丢弃）
  for (const [k, v] of Object.entries(ext)) {
    if (RESERVED_EXT_KEYS.includes(k) || v === undefined) continue;
    const { prefix, local } = splitQName(k);
    const isScalar = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    if (prefix && prefix !== FLOKEN_PREFIX) {
      // 带前缀的标量已在属性分支写回；带前缀的**结构**没有无损的表达方式
      // （第三方元素在导入侧是原样快照，靠 `t` 标记反解会与快照形态打架）
      if (isScalar) continue;
      throw new ModdleError('第三方扩展的结构化内容无法写成属性', {
        code: MODDLE_ERROR_CODES.XML_UNSUPPORTED_VALUE,
        details: { key: k },
        hint: '第三方结构化内容请放进 extension._extensionElements（原样 XML 快照）',
      });
    }
    if (isScalar && props.get(k)?.isAttr === true) continue; // 属性分支已写
    if (!ctx.includeExt) continue;
    const built = jsonToXml(local, v, FLOKEN_PREFIX);
    if (built) kids.push(built);
  }

  return kids.length ? el(`${P}:extensionElements`, {}, kids) : undefined;
}

// ─────────────────────────────────────────────────────────────────
// DI（bpmndi）
// ─────────────────────────────────────────────────────────────────

function diagramToXml(def: ProcessDefinition, layout: Layout, ctx: Ctx): XmlBuilder {
  /*
   * ★ 两个都是**互操作实证**抓出来的真 bug（原实现只靠结构断言，看不出来）：
   *
   * 1. **DI 的 id 会撞车** —— 凭空造 `${元素id}_di`，而 `id` 在 XML 里是 `xsd:ID`
   *    **全文档唯一**：原文件里只要有个元素就叫 `xxx_di`，我们就会产出 duplicate ID，
   *    bpmn-moddle 报 `unparsable content <bpmndi:BPMNEdge>`，bpmn-js 直接丢图形。
   *    → 先收集**已占用的全部 id**，再生成一个不撞的（优先沿用原 `diId`）。
   * 2. **悬空 DI 引用** —— 语义元素没被模型收下（pool/lane/未承诺元素），
   *    它的 shape 却留在 layout 里 → 导出成引用不存在元素的 DI。
   *    → 导出时跳过（导入侧仍保全，不丢用户数据）。
   */
  const known = new Set<string>(); // 语义元素 id（判断 DI 指向是否还存在）
  const used = new Set<string>([def.id]); // 全部已占用 id（保证唯一）
  const walk = (nodes: readonly FlowNode[], flows: readonly Flow[]): void => {
    for (const n of nodes) {
      known.add(n.id);
      used.add(n.id);
      if (n.nodes?.length || n.flows?.length) walk(n.nodes ?? [], n.flows ?? []);
    }
    for (const f of flows) {
      known.add(f.id);
      used.add(f.id);
    }
  };
  /*
   * ★ 泳道与池也是**图面元素**：它们的 `BPMNShape` 是合法的，
   * 不加进 `known` 就会被当成"悬空 DI"过滤掉 —— 导入泳道图再导出，泳道的图形全没了。
   */
  const walkLanes = (lanes: readonly Lane[]): void => {
    for (const l of lanes) {
      known.add(l.id);
      used.add(l.id);
      if (l.lanes?.length) walkLanes(l.lanes);
    }
  };
  for (const collab of def.collaborations ?? []) {
    known.add(collab.id);
    used.add(collab.id);
    for (const p of collab.participants) {
      known.add(p.id);
      used.add(p.id);
    }
    for (const mf of collab.messageFlows) {
      known.add(mf.id);
      used.add(mf.id);
    }
  }
  for (const proc of def.processes) {
    used.add(proc.id);
    for (const ls of proc.laneSets ?? []) walkLanes(ls.lanes);
    walk(proc.nodes, proc.flows);
  }
  // ⚠️ plane 的 id **不预加**进 `used`：它要参与 `allocId()` 的竞争，
  // 与语义元素撞车时由它让位（语义 id 被引用绑死，改不得）。
  // 预加了就会无条件被判成"已占用"，每次导出都被改成 `_2`。

  /** 取一个没被占用的 DI id：先试原 id / 默认形态，撞了就加序号 */
  const allocId = (preferred: string): string => {
    if (!used.has(preferred)) {
      used.add(preferred);
      return preferred;
    }
    for (let i = 2; ; i++) {
      const cand = `${preferred}_${i}`;
      if (!used.has(cand)) {
        used.add(cand);
        return cand;
      }
    }
  };

  const planes: XmlChild[] = [];
  for (const plane of layout.planes) {
    /*
     * ★ 指向模型里没有的元素时（悬浮坐标）必须**说出来**，不能静默丢掉 ——
     * 坐标层是用户唯一的排版资产，悄无声息少几个框，用户只会以为"工具坏了"。
     */
    const droppedShapes = Object.keys(plane.shapes).filter((id) => !known.has(id));
    const droppedEdges = Object.keys(plane.edges).filter((id) => !known.has(id));
    if (droppedShapes.length || droppedEdges.length) {
      ctx.warn(
        diagnostic(
          'warn',
          MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF,
          `plane '${plane.id}' 有 ${droppedShapes.length} 个 shape / ${droppedEdges.length} 条 edge 指向模型里不存在的元素，导出时已跳过（${[...droppedShapes, ...droppedEdges].slice(0, 5).join(', ')}）`,
          { node: { path: `layout.planes[${plane.id}]` } },
        ),
      );
    }
    const shapes = Object.entries(plane.shapes)
      .filter(([id]) => known.has(id))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));

    /*
     * ★ BPMNShape 在 DI 里**一律扁平**，是 `bpmndi:BPMNPlane` 的直接子级 ——
     * 哪怕是子流程内的元素。XSD 里 `BPMNShape` 的 content model 只准一个 `BPMNLabel`
     * （`di:Shape` → `di:DiagramElement` 没有装子元素的地方）。
     *
     * 这一条是 AC-S1 实证抓出来的：早先把内嵌 shape 按 `parentId` 套进容器 shape 里，
     * bpmn-moddle 直接报 `unparsable content <bpmndi:BPMNShape>`，bpmn-js 会画不出子流程内容。
     * `parentId` 是**派生信息**（元素属于哪个容器），导出不落盘、导入按语义归属重建。
     */
    const shapeEls: XmlChild[] = [];
    for (const [id, s] of shapes) {
      shapeEls.push(
        el(
          `${DI}:BPMNShape`,
          {
            // 原文件带来的 id 优先（幂等），否则用默认形态；撞车就换一个
            id: s.diId && !used.has(s.diId) ? allocId(s.diId) : allocId(`${id}_di`),
            bpmnElement: id,
            ...(s.isExpanded !== undefined ? { isExpanded: s.isExpanded } : {}),
            ...(s.isHorizontal !== undefined ? { isHorizontal: s.isHorizontal } : {}),
          },
          [el(`${DC}:Bounds`, { x: s.x, y: s.y, width: s.width, height: s.height })],
        ),
      );
    }

    const edges: XmlChild[] = [];
    const edgeList = Object.entries(plane.edges)
      .filter(([id]) => known.has(id))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [id, e] of edgeList) {
      const kids: XmlChild[] = e.waypoints.map((p) => el(`${DDI}:waypoint`, { x: p.x, y: p.y }));
      if (e.label) {
        kids.push(
          el(`${DI}:BPMNLabel`, {}, [
            el(`${DC}:Bounds`, { x: e.label.x, y: e.label.y, width: e.label.width, height: e.label.height }),
          ]),
        );
      }
      edges.push(
        el(
          `${DI}:BPMNEdge`,
          { id: e.diId && !used.has(e.diId) ? allocId(e.diId) : allocId(`${id}_di`), bpmnElement: id },
          kids,
        ),
      );
    }

    planes.push(
      el(`${DI}:BPMNPlane`, { id: allocId(plane.id), bpmnElement: plane.elementId }, [
        ...shapeEls,
        ...edges,
      ]),
    );
  }
  return el(`${DI}:BPMNDiagram`, { id: allocId(`${def.id}_diagram`) }, planes);
}

/**
 * `<definitions>` 的 `<extensionElements>`：只放**用户 meta**（保留键除外）。
 * meta 在 BPMN 里没有落点，不落盘的话 `fromXml(toXml(m))` 会静默丢掉用户数据。
 */
function definitionsExtensionToXml(def: ProcessDefinition, includeExt: boolean): XmlBuilder | undefined {
  if (!includeExt || !def.meta) return undefined;
  const user: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def.meta)) {
    if (k === META_NAMESPACES_KEY || k === META_DEFINITIONS_KEY) continue;
    if (v === undefined) continue;
    user[k] = v;
  }
  if (!Object.keys(user).length) return undefined;
  const built = jsonToXml('meta', user, FLOKEN_PREFIX);
  return built ? el(`${P}:extensionElements`, {}, [built]) : undefined;
}

// ─────────────────────────────────────────────────────────────────
// meta 保留键
// ─────────────────────────────────────────────────────────────────

/** 遍历整份模型，收集 `extension` 里用到的第三方前缀（排序后返回，保证输出确定） */
function collectExtPrefixes(def: ProcessDefinition): string[] {
  const out = new Set<string>();
  const scan = (ext: ExtensionBag | undefined): void => {
    if (!ext) return;
    for (const k of Object.keys(ext)) {
      if (RESERVED_EXT_KEYS.includes(k)) continue;
      const { prefix } = splitQName(k);
      if (prefix && prefix !== FLOKEN_PREFIX) out.add(prefix);
    }
  };
  const walk = (nodes: readonly FlowNode[]): void => {
    for (const n of nodes) {
      scan(n.extension);
      walk(n.nodes ?? []);
      for (const f of n.flows ?? []) scan(f.extension);
    }
  };
  for (const proc of def.processes) {
    scan(proc.extension);
    walk(proc.nodes);
    for (const f of proc.flows) scan(f.extension);
  }
  return [...out].sort();
}

function readNamespaces(def: ProcessDefinition): Record<string, string> {
  const v = def.meta?.[META_NAMESPACES_KEY];
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, uri] of Object.entries(v as Record<string, unknown>)) {
    if (typeof uri === 'string') out[k] = uri;
  }
  return out;
}

function readDefinitionAttrs(def: ProcessDefinition): Record<string, AttrValue> {
  const v = def.meta?.[META_DEFINITIONS_KEY];
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, AttrValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out[k] = val;
  }
  return out;
}
