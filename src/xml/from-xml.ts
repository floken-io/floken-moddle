/**
 * `fromXml()` —— 标准 BPMN 2.0 XML → Model JSON（S3）
 *
 * 三条纪律：
 * 1. **按 URI 识别、不认前缀**（§6.2）—— 历史文件用旧前缀绑同一个 URI 照样认得。
 * 2. **认不出的东西一律保全**（纪律一）：第三方元素原样快照、未知属性进 `extension`。
 *    拦在解析层等于静默丢弃，比多一个字段危险得多。
 * 3. **导入宽容、导出严格**：Camunda 8 风格的 `= expr` 前导等号**剥离并告警**，不报错（FR-9.12）。
 *
 * 已知取舍（写在这里，防止将来被当成 bug）：
 * - **注释不进模型**，往返后会丢失。注释不是模型数据，为它单独开字段会让 `extension` 语义变浑。
 * - BPMN 原生属性一律读作**字符串**（XSD 里它们本就是 `string`/`anyURI`/`QName` 系列，
 *   猜数字/布尔会让 `version="1"` 与 `version=1` 分叉）；只有 `tFormalExpression`
 *   展开成 `{ body, language }`。
 */

import {
  MODDLE_DIAGNOSTIC_CODES,
  MODDLE_ERROR_CODES,
  ModdleError,
  diagnostic,
  unknownOptionError,
  type Diagnostic,
} from '../core/errors.js';
import {
  MODEL_SCHEMA_VERSION,
  type Collaboration,
  type EventDefinition,
  type ExtensionBag,
  type Flow,
  type FlowNode,
  type Lane,
  type LaneSet,
  type MessageFlow,
  type Participant,
  type ProcessDefinition,
  type Process,
} from '../model/definition.js';
import type { EdgeLayout, PlaneLayout, ShapeLayout } from '../model/layout.js';
import { findCoverage } from '../spec/coverage.js';
import { typeNameOf } from '../spec/index.js';
import {
  BPMNDI_NS,
  BPMN_NS,
  DC_NS,
  DI_NS,
  FLOKEN_NS,
  TARGET_NS,
  XSI_NS,
  XML_NS,
  FLOKEN_PREFIX,
  KNOWN_EXT_NS,
  splitQName,
} from './namespaces.js';
import {
  attrOf,
  childByNs,
  childElements,
  childrenByNs,
  parseXml,
  textContent,
  type XmlElement,
  type XmlNode,
} from './sax.js';
import { META_DEFINITIONS_KEY, META_NAMESPACES_KEY } from './to-xml.js';
import { xmlToJson } from './value.js';
import { el as mkEl, serializeXml, type AttrValue, type XmlBuilder, type XmlChild } from './writer.js';

export interface FromXmlOptions {
  /**
   * 覆盖表外的 **BPMN 命名空间**元素怎么处置，默认 **`'preserve'`**：
   * - `'preserve'`（默认）：原样快照进 `extension._extensionElements`，**不发诊断** —— 往返不丢且安静
   * - `'warn'`：同上，但每条发一条 `MODDLE_VALIDATE_ELEMENT_PRESERVED` 诊断
   * - `'throw'`：抛 `XML_UNSUPPORTED_ELEMENT`
   *
   * ★ 为什么默认不是 throw：实证——默认 throw 时 **22 份 MIWG 真实语料 0 份能导入**
   * （`incoming` / `outgoing` / `flowNodeRef` / `ioSpecification` 全在 bpmn 命名空间内、
   * 只是不在我们的 48 类覆盖表里）。**拒收真实文件**比多一个保全字段严重得多（§4.5 纪律一）。
   */
  onUnsupported?: 'throw' | 'warn' | 'preserve';
  /** 诊断出口（`= expr` 剥离、元素不支持降级告警等） */
  onDiagnostic?: (d: Diagnostic) => void;
  /** 是否允许 DTD（默认 **false**，XXE 防线；允许也不展开外部实体） */
  allowDoctype?: boolean;
}

export const FROM_XML_OPTION_KEYS: readonly string[] = Object.freeze([
  'onUnsupported',
  'onDiagnostic',
  'allowDoctype',
]);

interface Ctx {
  onUnsupported: 'throw' | 'warn' | 'preserve';
  warn: (d: Diagnostic) => void;
}

/**
 * §6.6 组 A 里**字符串型**规范属性（不含 `default`→`defaultFlow` 的改名项）。
 * JSON 字段名与 XML 属性名**同形**，故可直接按键搬运。
 */
const SPEC_ATTR_KEYS: readonly string[] = Object.freeze([
  'implementation',
  'operationRef',
  'messageRef',
  'scriptFormat',
  'gatewayDirection',
  'calledElement',
  'dataObjectRef',
  'dataStoreRef',
  // 第二批（执行语义关键，见 definition.ts 的说明）
  'eventGatewayType',
  'itemSubjectRef',
  // 第三批：`association` 的端点（XSD 里是 required，不读回来就只是"保全不能建模"）
  'sourceRef',
  'targetRef',
  'associationDirection',
]);

/** 组 A 里的**布尔型**规范属性（XSD `xsd:boolean`） */
const SPEC_BOOL_ATTR_KEYS: readonly string[] = Object.freeze([
  'triggeredByEvent',
  'isForCompensation',
  'cancelActivity',
  'isInterrupting',
  'instantiate',
  'parallelMultiple',
  'isCollection',
]);

/** 组 A 里的**整数型**规范属性（XSD `xsd:integer`） */
const SPEC_INT_ATTR_KEYS: readonly string[] = Object.freeze(['startQuantity', 'completionQuantity']);

/**
 * ★ 冗余引用元素：`<bpmn:incoming>` / `<bpmn:outgoing>`。
 *
 * 它们是 `sequenceFlow` 的**替代组**（substitution group），内容与 `sourceRef` / `targetRef`
 * 完全等价 —— 规范允许显式写出"某节点有哪些入边/出边"。
 *
 * 为什么不保全：MIWG 22 份语料里出现 **690 条**，而信息量与 `flows[]` 一字不差；
 * 保全会让每份文件的 `extension` 凭空多出几百条字符串，且导出时还得去重。
 * → **静默吸收**（既不生成节点，也不发诊断）。这是"冗余"而非"丢弃"。
 */
const REDUNDANT_REF_ELEMENTS: readonly string[] = Object.freeze(['incoming', 'outgoing']);

// ─────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────

/**
 * ★ 按 XML 声明的 `encoding` 解码字节流。
 *
 * 为什么必须做：BPMN 语料里 `encoding="ISO-8859-1"` 很常见（MIWG 就有）。
 * 调用方若按 utf8 读这类文件，`café` 会变成 `caf�` —— 而这是**调用方的锅**还是
 * **库的锅**？库既然看得到声明里的编码，就该自己解对，而不是要求调用方先猜对。
 *
 * 判定顺序：**BOM** > `encoding="…"` 声明 > 默认 UTF-8（XML 规范就是这个顺序）。
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  // BOM 优先（UTF-8 / UTF-16LE / UTF-16BE）
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  // 只看文件开头的声明（UTF-8 与 ASCII 前 200 字节同构，安全）
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(200, bytes.length)));
  const enc = /encoding\s*=\s*["']([\w-]+)["']/.exec(head)?.[1];
  if (enc) {
    const label = enc.toLowerCase();
    // utf-8 与 us-ascii 直接用默认解码器（后者是 utf-8 子集）
    if (label !== 'utf-8' && label !== 'utf8' && label !== 'us-ascii' && label !== 'ascii') {
      try {
        return new TextDecoder(label).decode(bytes);
      } catch {
        // 声明了不认识的编码 → 退回 UTF-8，不抛（宽容导入）
      }
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** 同步版（内部与测试用） */
export function fromXmlSync(xml: string | Uint8Array, opts: FromXmlOptions = {}): ProcessDefinition {
  for (const k of Object.keys(opts)) {
    if (!FROM_XML_OPTION_KEYS.includes(k)) throw unknownOptionError(k, FROM_XML_OPTION_KEYS);
  }
  if (typeof xml !== 'string') {
    if (!(xml instanceof Uint8Array)) {
      throw new ModdleError('xml must be a string or Uint8Array', {
        code: MODDLE_ERROR_CODES.ARG_INVALID_INPUT,
        details: { what: 'xml', expected: 'string | Uint8Array' },
      });
    }
    xml = decodeXmlBytes(xml);
  }
  const ctx: Ctx = {
    onUnsupported: opts.onUnsupported ?? 'preserve',
    warn: (d) => opts.onDiagnostic?.(d),
  };

  const doc = parseXml(xml, { ...(opts.allowDoctype !== undefined ? { allowDoctype: opts.allowDoctype } : {}) });
  const root = doc.root;
  if (root.local !== 'definitions' || root.ns !== BPMN_NS) {
    throw new ModdleError('根元素必须是 bpmn:definitions', {
      code: MODDLE_ERROR_CODES.XML_INVALID_CONTENT,
      details: { got: root.name, ns: root.ns ?? null },
      hint: '按 URI 识别（BPMN_NS），前缀写法不同不影响',
    });
  }

  // ── definitions 级 ──
  const meta: Record<string, unknown> = {};
  const namespaces = collectNamespaces(root);
  if (Object.keys(namespaces).length) meta[META_NAMESPACES_KEY] = namespaces;

  const defAttrs: Record<string, string> = {};
  for (const a of root.attrs) {
    const isNsDecl = a.local === 'xmlns' || a.prefix === 'xmlns';
    if (isNsDecl || a.local === 'id' || a.local === 'name') continue;
    if (a.ns === FLOKEN_NS && (a.local === 'schemaVersion' || a.local === 'version')) continue;
    /*
     * ★ `targetNamespace` 不再一律跳过：它是文件的身份标识，丢了会让往返后的文件变成"另一个东西"。
     * 唯一例外是我们**自己写出去的默认值** —— 回存它只会让 `meta` 凭空多一个键，
     * 把 AC-S2 的 `fromXml(toXml(m)) === m` 打破。别人的值一律保住。
     */
    if (a.local === 'targetNamespace' && a.value === TARGET_NS) continue;
    defAttrs[a.name] = a.value;
  }
  if (Object.keys(defAttrs).length) meta[META_DEFINITIONS_KEY] = defAttrs;

  const defExt = extensionElementsToBag(childByNs(root, BPMN_NS, 'extensionElements'));
  const metaJson = defExt?.['floken:meta'];
  // definitions 级同样可能有多条 documentation（第 2 条起保全，不丢）
  const defDocs = childrenByNs(root, BPMN_NS, 'documentation')
    .map((d) => textContent(d))
    .filter((t): t is string => t !== undefined);
  const [defDoc, ...defDocRest] = defDocs;

  const def: ProcessDefinition = {
    schemaVersion:
      readString(attrOf(root, 'schemaVersion', FLOKEN_NS)) ?? MODEL_SCHEMA_VERSION,
    id: attrOf(root, 'id') ?? 'Definitions_1',
    ...(attrOf(root, 'name') !== undefined ? { name: attrOf(root, 'name') as string } : {}),
    ...(readNumber(attrOf(root, 'version', FLOKEN_NS)) !== undefined
      ? { version: readNumber(attrOf(root, 'version', FLOKEN_NS)) }
      : {}),
    processes: [],
    ...(defDoc !== undefined ? { description: defDoc } : {}),
    ...(defDocRest.length ? { extraDocumentations: defDocRest } : {}),
    ...(metaJson && typeof metaJson === 'object'
      ? { meta: { ...(metaJson as Record<string, unknown>), ...meta } }
      : {}),
  };
  if (!def.meta && Object.keys(meta).length) def.meta = meta;

  /*
   * ── collaboration（泳道图 / 协作图根，**0..n**） ──
   * XSD 里 `definitions/collaboration` 是 `maxOccurs="unbounded"`；真实文件确有多个
   * （MIWG `C.4.0` 有 4 个，每个各带 1 个池）。只取第一个会让其余池连同它们的
   * `messageFlow` 一起消失 —— 那不是"简化"，是把用户的图吃掉。
   */
  const collabs: Collaboration[] = [];
  for (const collabEl of childrenByNs(root, BPMN_NS, 'collaboration')) {
    collabs.push(collaborationFromXml(collabEl));
  }
  if (collabs.length) def.collaborations = collabs;

  /*
   * ── definitions 级**不落地**的元素：原样快照 ──
   * 编排族 / 会话族 / `<bpmn:message>` / `<bpmn:signal>` / `<bpmn:error>` /
   * `<bpmn:itemDefinition>` / `<bpmn:interface>` / `<bpmn:relationship>` …
   *
   * ★ 这些以前是**静默丢弃**的，后果不只是"少了点数据"：
   * `<bpmn:message id="Msg_1">` 被丢后，事件里 `messageRef="Msg_1"` 变成**悬空引用**，
   * 导出的文件在我们自己的校验里都会报 dangling ref。
   */
  const extra: string[] = [];
  for (const child of childElements(root)) {
    if (child.ns !== BPMN_NS) continue;
    if (child.local === 'process' || child.local === 'collaboration') continue;
    if (child.local === 'documentation' || child.local === 'extensionElements') continue;
    extra.push(snapshot(child));
  }
  if (extra.length) def.extraElements = extra;

  // ── process ──
  for (const procEl of childrenByNs(root, BPMN_NS, 'process')) {
    const nodes: FlowNode[] = [];
    const flows: Flow[] = [];
    const laneSets: LaneSet[] = [];
    const proc: Process = {
      id: attrOf(procEl, 'id') ?? '',
      ...(attrOf(procEl, 'name') !== undefined ? { name: attrOf(procEl, 'name') as string } : {}),
      ...(readBool(attrOf(procEl, 'isExecutable')) !== undefined
        ? { executable: readBool(attrOf(procEl, 'isExecutable')) }
        : {}),
      nodes,
      flows,
    };
    for (const child of childElements(procEl)) {
      if (child.ns !== BPMN_NS) continue;
      if (child.local === 'extensionElements') {
        const bag = extensionElementsToBag(child);
        if (bag) proc.extension = bag;
        continue;
      }
      if (child.local === 'documentation') {
        const t = textContent(child);
        // 与节点同理：第一条进 `description`，其余**保全**进 `extraDocumentations`
        if (t !== undefined) {
          if (proc.description === undefined) proc.description = t;
          else (proc.extraDocumentations ??= []).push(t);
        }
        continue;
      }
      // ★ 泳道：单独落点，不再混进 nodes（见 definition.ts 的说明）
      if (child.local === 'laneSet') {
        const ls = laneSetFromXml(child);
        if (ls) laneSets.push(ls);
        continue;
      }
      if (child.local === 'sequenceFlow') {
        const f = flowFromXml(child, ctx);
        if (f) flows.push(f);
        continue;
      }
      if (REDUNDANT_REF_ELEMENTS.includes(child.local)) continue;
      const n = nodeFromXml(child, ctx);
      if (n) nodes.push(n);
      else preserveElement(child, proc, ctx, 'processes[].nodes[].type');
    }
    if (laneSets.length) proc.laneSets = laneSets;
    def.processes.push(proc);
  }

  // ── DI ──
  const diagram = childByNs(root, BPMNDI_NS, 'BPMNDiagram');
  if (diagram) {
    const ownerOf = buildOwnerMap(def);
    const planes: PlaneLayout[] = [];
    for (const planeEl of childrenByNs(diagram, BPMNDI_NS, 'BPMNPlane')) {
      const plane = planeFromXml(planeEl, ownerOf);
      if (plane) planes.push(plane);
    }
    if (planes.length) def.layout = { planes };
  }

  return def;
}

/** 文档口径的异步入口（§9 API 清单） */
export async function fromXml(xml: string, opts: FromXmlOptions = {}): Promise<ProcessDefinition> {
  return fromXmlSync(xml, opts);
}

// ─────────────────────────────────────────────────────────────────
// 节点 / 连线
// ─────────────────────────────────────────────────────────────────

function nodeFromXml(el: XmlElement, ctx: Ctx): FlowNode | undefined {
  const type = el.local;
  if (el.ns !== BPMN_NS) return undefined;
  if (!findCoverage(type) || !typeNameOf(type)) return undefined;

  const node: FlowNode = { id: attrOf(el, 'id') ?? '', type };
  const name = attrOf(el, 'name');
  if (name !== undefined) node.name = name;
  const attached = attrOf(el, 'attachedToRef');
  if (attached !== undefined) node.attachedTo = attached;
  const formKey = attrOf(el, 'formKey', FLOKEN_NS);
  if (formKey !== undefined) node.formKey = formKey;

  /*
   * ★ 组 A：BPMN 规范属性（§6.6）—— 读回**一等字段**，不再落进 extension 袋。
   * 这些键下面的属性循环会跳过，避免同值两处存（导出时就会写两遍）。
   */
  const defFlow = attrOf(el, 'default');
  if (defFlow !== undefined) node.defaultFlow = defFlow;
  for (const k of SPEC_ATTR_KEYS) {
    const v = attrOf(el, k);
    if (v !== undefined) (node as unknown as Record<string, unknown>)[k] = v;
  }
  // 布尔型 / 整数型规范属性（读成真布尔与真数字，engine 不必再对 `'false'` 做字符串判断）
  for (const k of SPEC_BOOL_ATTR_KEYS) {
    const v = readBool(attrOf(el, k));
    if (v !== undefined) (node as unknown as Record<string, unknown>)[k] = v;
  }
  for (const k of SPEC_INT_ATTR_KEYS) {
    const v = readNumber(attrOf(el, k));
    if (v !== undefined) (node as unknown as Record<string, unknown>)[k] = v;
  }

  let docs = 0;
  for (const child of childElements(el)) {
    if (child.ns === BPMN_NS && child.local === 'documentation') {
      const text = textContent(child);
      // ★ 空 `<bpmn:documentation />` 也是一条文档（值为空串），不该被当成"没有"
      if (text !== undefined) {
        docs += 1;
        /*
         * BPMN 的 `documentation` 是 `maxOccurs="unbounded"`，常按 `xml:lang` 写多语言；
         * 而 `FlowNode.description` 是**单值**，只能装一条。
         * → 取第一条，其余**必须告警**（静默丢弃违反 §4.5 纪律一）。
         */
        if (docs === 1) node.description = text;
        else (node.extraDocumentations ??= []).push(text);
      }
      continue;
    }
    if (child.ns === BPMN_NS && child.local === 'extensionElements') {
      const bag = extensionElementsToBag(child);
      if (bag) node.extension = bag;
      continue;
    }
    if (child.ns === BPMN_NS && child.local.endsWith('EventDefinition')) {
      node.eventDefinition = eventDefinitionFromXml(child);
      continue;
    }
    /*
     * 规范**子元素**（§6.6）：`<bpmn:script>`（scriptTask）与 `<bpmn:activationCondition>`（complexGateway）。
     * ⚠️ 不在覆盖表里 —— 不在这里接住就会掉进 `unsupported()`，
     * 默认 `onUnsupported:'throw'` 下**导入一个标准 ScriptTask 会直接抛错**。
     */
    if (child.ns === BPMN_NS && child.local === 'script') {
      node.script = textContent(child);
      continue;
    }
    if (child.ns === BPMN_NS && child.local === 'activationCondition') {
      node.activationCondition = expressionFromXml(child, `nodes[${node.id}].activationCondition`, ctx);
      continue;
    }
    /*
     * `<bpmn:text>` 是 **textAnnotation 的规范子元素**（不是扩展）。
     * 漏了它就会被当成"不认识的元素"塞进 `extensionElements` 快照 —— 位置错、且凭空带一份 xmlns。
     */
    if (child.ns === BPMN_NS && child.local === 'text') {
      node.text = textContent(child);
      continue;
    }
    if (child.ns === BPMN_NS && child.local === 'sequenceFlow') {
      const f = flowFromXml(child, ctx);
      if (f) (node.flows ??= []).push(f);
      continue;
    }
    // 冗余引用元素（`incoming` / `outgoing`）：静默吸收，见常量处说明
    if (child.ns === BPMN_NS && REDUNDANT_REF_ELEMENTS.includes(child.local)) continue;
    if (child.ns === BPMN_NS) {
      const inner = nodeFromXml(child, ctx);
      if (inner) {
        (node.nodes ??= []).push(inner);
        continue;
      }
      /*
       * ★ 规范里存在、但覆盖表未登记的元素（`ioSpecification` / `dataInputAssociation` /
       * `multiInstanceLoopCharacteristics` / `potentialOwner` / `text` …）→ **原样快照保全**。
       *
       * 以前这里是 `unsupported()` 抛错，实证结果是 **22 份 MIWG 语料 0 份能导入** ——
       * 拒收真实文件比多一个保全字段严重得多（§4.5 纪律一：认不出的东西一律保全）。
       */
      preserveElement(child, node, ctx, `processes[].nodes[${node.id}].nodes[].type`);
    }
  }

  // 规范属性里模型没有专门字段的 → 进 extension（导出时原样写回）
  const bag: ExtensionBag = node.extension ?? {};
  for (const a of el.attrs) {
    if (a.local === 'id' || a.local === 'name' || a.local === 'attachedToRef') continue;
    // 已升为一等字段的规范属性不再重复存（同值两处存会让"改哪边"变成谜题）
    if (a.local === 'default' || SPEC_ATTR_KEYS.includes(a.local)) continue;
    if (SPEC_BOOL_ATTR_KEYS.includes(a.local) || SPEC_INT_ATTR_KEYS.includes(a.local)) continue;
    if (a.ns === FLOKEN_NS && a.local === 'formKey') continue;
    if (a.prefix === 'xmlns' || a.local === 'xmlns') continue;
    bag[a.name] = a.value;
  }
  if (Object.keys(bag).length) node.extension = bag;

  return node;
}

function flowFromXml(el: XmlElement, ctx: Ctx): Flow | undefined {
  const id = attrOf(el, 'id');
  const from = attrOf(el, 'sourceRef');
  const to = attrOf(el, 'targetRef');
  if (id === undefined || from === undefined || to === undefined) {
    throw new ModdleError('sequenceFlow 缺少 id / sourceRef / targetRef', {
      code: MODDLE_ERROR_CODES.XML_INVALID_CONTENT,
      details: { id: id ?? null, sourceRef: from ?? null, targetRef: to ?? null },
    });
  }
  void ctx;
  const flow: Flow = { id, from, to };
  const name = attrOf(el, 'name');
  if (name !== undefined) flow.name = name;

  // 连线也能挂 `<bpmn:documentation>`（继承自 tBaseElement）：第 2 条起保全，不丢
  const fDocs = childrenByNs(el, BPMN_NS, 'documentation')
    .map((d) => textContent(d))
    .filter((t): t is string => t !== undefined);
  if (fDocs.length) {
    flow.description = fDocs[0];
    if (fDocs.length > 1) flow.extraDocumentations = fDocs.slice(1);
  }

  const cond = childByNs(el, BPMN_NS, 'conditionExpression');
  if (cond) flow.condition = expressionFromXml(cond, `flows[${id}].condition`, ctx);
  const imm = readBool(attrOf(el, 'isImmediate'));
  if (imm !== undefined) flow.isImmediate = imm;

  const extEl = childByNs(el, BPMN_NS, 'extensionElements');
  const bag = extensionElementsToBag(extEl);
  if (bag) flow.extension = bag;
  for (const a of el.attrs) {
    if (a.local === 'id' || a.local === 'sourceRef' || a.local === 'targetRef' || a.local === 'name') continue;
    if (a.prefix === 'xmlns' || a.local === 'xmlns') continue;
    (flow.extension ??= {})[a.name] = a.value;
  }
  return flow;
}

/**
 * `<conditionExpression>` → `FormalExpression`。
 *
 * ★ 导入宽容：Camunda 8 的 `= expr` 前导等号**剥离并告警**（FR-9.12 / `02` I-10 AC5），
 * 让迁移过来的图不被卡死在解析层。
 */
function expressionFromXml(
  el: XmlElement,
  path: string,
  ctx?: Ctx,
): { body: string; language?: string; evaluatesToTypeRef?: string } {
  let body = textContent(el);
  if (body.startsWith('=')) {
    body = body.slice(1).trim();
    ctx?.warn(
      diagnostic(
        'warn',
        MODDLE_DIAGNOSTIC_CODES.VALIDATE_LEGACY_PREFIX,
        '条件表达式带 Camunda 8 风格的 `=` 前缀，已剥离',
        { node: { path }, suggestions: ['本项目导出时不带 `=`，语言由 `language` 属性标识'] },
      ),
    );
  }
  const out: { body: string; language?: string; evaluatesToTypeRef?: string } = { body };
  const language = attrOf(el, 'language');
  if (language !== undefined) out.language = language;
  const typeRef = attrOf(el, 'evaluatesToTypeRef');
  if (typeRef !== undefined) out.evaluatesToTypeRef = typeRef;
  return out;
}

function eventDefinitionFromXml(el: XmlElement): EventDefinition {
  const type = el.local.replace(/EventDefinition$/, '');
  const out: EventDefinition = { type };
  for (const a of el.attrs) {
    if (a.prefix === 'xmlns' || a.local === 'xmlns') continue;
    out[a.local] = a.value;
  }
  for (const child of childElements(el)) {
    // `xsi:type` 在 xsi 命名空间下 —— 按本地名裸查会漏（无前缀属性不属于任何命名空间）
    const isFormal = attrOf(child, 'type', XSI_NS) === 'bpmn:tFormalExpression';
    if (isFormal) out[child.local] = expressionFromXml(child, `eventDefinition.${child.local}`);
    else if (childElements(child).length === 0) out[child.local] = textContent(child);
    else out[child.local] = eventDefinitionFromXml(child);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// extensionElements → ExtensionBag
// ─────────────────────────────────────────────────────────────────

function extensionElementsToBag(el: XmlElement | undefined): ExtensionBag | undefined {
  if (!el) return undefined;
  const bag: ExtensionBag = {};
  const snapshots: string[] = [];
  let any = false;

  for (const child of childElements(el)) {
    any = true;
    if (child.ns === FLOKEN_NS) {
      bag[`${FLOKEN_PREFIX}:${child.local}`] = xmlToJson(child);
      continue;
    }
    // 第三方元素：原样快照（规范化后的 XML 字符串），导出时嵌回去
    snapshots.push(snapshot(child));
  }
  if (snapshots.length) bag['_extensionElements'] = snapshots;
  return any ? bag : undefined;
}

/*
 * 把解析出的元素**规范化**回 XML 字符串（用于第三方元素快照）。
 *
 * ★ 快照必须**自带**它用到的命名空间声明：它是别人的 XML，将来被嵌进我们生成的
 * `<bpmn:extensionElements>`，而那里未必有它用到的前缀 —— 不带就会产出非法文件。
 *
 * ★ 只带**用得到的**前缀（`usedPrefixes`），不是把整个「命名空间现场」全抄一遍：
 * 全抄会让快照每往返一轮就胖一圈，`toXml(fromXml(toXml(m)))` 的逐字节恒等就没了。
 */
function snapshot(el: XmlElement): string {
  return serializeXml(toBuilder(el), { declaration: false }).trimEnd();
}

/** 子树里实际用到的前缀集合（`''` = 默认命名空间） */
function usedPrefixes(el: XmlElement, out: Set<string> = new Set()): Set<string> {
  out.add(splitQName(el.name).prefix ?? '');
  for (const a of el.attrs) {
    if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue; // 声明本身不算「使用」
    const p = splitQName(a.name).prefix;
    if (p) out.add(p);
  }
  for (const c of el.children) if (c.kind === 'element') usedPrefixes(c, out);
  return out;
}

/**
 * ★ 命名空间声明**只在快照的根元素上写一次**。
 *
 * 以前每个子元素都各带一份 `xmlns:camunda` —— 合法但冗余，且让快照每往返一轮就胖一圈
 * （长文件里这一项能占到快照体积的三分之一）。声明一次即可覆盖整棵子树。
 */
function toBuilder(el: XmlElement): XmlBuilder {
  return buildEl(el, true);
}

function buildEl(el: XmlElement, isRoot: boolean): XmlBuilder {
  const attrs: Record<string, AttrValue> = {};
  if (isRoot) {
    const used = usedPrefixes(el);
    for (const [prefix, uri] of Object.entries(el.nsInScope).sort()) {
      if (!used.has(prefix)) continue;
      if (prefix === 'xml') continue; // 内置前缀，声明它既冗余又不该出现在别人的快照里
      attrs[prefix ? `xmlns:${prefix}` : 'xmlns'] = uri;
    }
  }
  for (const a of el.attrs) attrs[a.name] = a.value;
  const kids: XmlChild[] = [];
  for (const c of el.children) kids.push(...childToBuilder(c));
  return mkEl(el.name, attrs, kids);
}

function childToBuilder(node: XmlNode): XmlChild[] {
  if (node.kind === 'element') return [buildEl(node, false)];
  if (node.kind === 'text' || node.kind === 'cdata') return [node.value];
  return []; // 注释不保全（见文件头「已知取舍」）
}

// ─────────────────────────────────────────────────────────────────
// DI → layout
// ─────────────────────────────────────────────────────────────────

/**
 * 元素 id → 容器 id（只有子流程内元素进表，顶层元素不在表里）。
 *
 * `parentId` 是**派生信息**：DI 里没有它的落点（`BPMNPlane` 扁平，见 `to-xml.ts` 的说明），
 * 所以导入时按**语义归属**重建 —— 谁的内嵌 nodes 里有它，谁就是它的容器。
 */
function buildOwnerMap(def: ProcessDefinition): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (nodes: readonly FlowNode[]): void => {
    for (const n of nodes) {
      for (const child of n.nodes ?? []) {
        map.set(child.id, n.id);
        walk([child]);
      }
    }
  };
  for (const p of def.processes) walk(p.nodes);
  return map;
}

function planeFromXml(el: XmlElement, ownerOf: Map<string, string>): PlaneLayout | undefined {
  const elementId = attrOf(el, 'bpmnElement');
  if (elementId === undefined) return undefined;
  const plane: PlaneLayout = {
    id: attrOf(el, 'id') ?? `${elementId}_plane`,
    elementId,
    shapes: {},
    edges: {},
  };

  /*
   * 标准 DI 是**扁平**的（所有 shape 都在 plane 下），所以这里只遍历直接子级；
   * 但为兼容把内嵌 shape 写成嵌套的非标准文件，仍递归一层兜底 —— 读到也算数。
   * 归属一律以 `ownerOf`（语义）为准，结构上的嵌套不作为 `parentId` 的来源。
   */
  const walkShapes = (parent: XmlElement): void => {
    for (const shapeEl of childrenByNs(parent, BPMNDI_NS, 'BPMNShape')) {
      const id = attrOf(shapeEl, 'bpmnElement');
      const bounds = childByNs(shapeEl, DC_NS, 'Bounds');
      if (id === undefined || !bounds) continue;
      const shape: ShapeLayout = {
        x: readNumber(attrOf(bounds, 'x')) ?? 0,
        y: readNumber(attrOf(bounds, 'y')) ?? 0,
        width: readNumber(attrOf(bounds, 'width')) ?? 0,
        height: readNumber(attrOf(bounds, 'height')) ?? 0,
      };
      const owner = ownerOf.get(id);
      if (owner !== undefined) shape.parentId = owner;
      const expanded = readBool(attrOf(shapeEl, 'isExpanded'));
      if (expanded !== undefined) shape.isExpanded = expanded;
      const horizontal = readBool(attrOf(shapeEl, 'isHorizontal'));
      if (horizontal !== undefined) shape.isHorizontal = horizontal;
      /*
       * ★ 记下 `BPMNShape@id`（缺省形态不记，保持 JSON 干净）：
       * XML 的 `id` 是 `xsd:ID`，**全文档唯一**。导出时凭空造 `${元素id}_di`
       * 会撞上原文件里本来就叫 `xxx_di` 的元素 → 产出 duplicate ID 的非法文件
       * （互操作实证抓到：bpmn-moddle 报 `unparsable content`，bpmn-js 丢图形）。
       */
      const diId = attrOf(shapeEl, 'id');
      if (diId !== undefined && diId !== `${id}_di`) shape.diId = diId;
      plane.shapes[id] = shape;
      walkShapes(shapeEl);
    }
  };
  walkShapes(el);

  for (const edgeEl of childrenByNs(el, BPMNDI_NS, 'BPMNEdge')) {
    const id = attrOf(edgeEl, 'bpmnElement');
    if (id === undefined) continue;
    const waypoints = childrenByNs(edgeEl, DI_NS, 'waypoint')
      .map((w) => ({ x: readNumber(attrOf(w, 'x')) ?? 0, y: readNumber(attrOf(w, 'y')) ?? 0 }));
    if (waypoints.length < 2) continue;
    const edge: EdgeLayout = { waypoints };
    const label = childByNs(edgeEl, BPMNDI_NS, 'BPMNLabel');
    const lb = label ? childByNs(label, DC_NS, 'Bounds') : undefined;
    if (lb) {
      edge.label = {
        x: readNumber(attrOf(lb, 'x')) ?? 0,
        y: readNumber(attrOf(lb, 'y')) ?? 0,
        width: readNumber(attrOf(lb, 'width')) ?? 0,
        height: readNumber(attrOf(lb, 'height')) ?? 0,
      };
    }
    // 同 shape：记住原 `BPMNEdge@id`（缺省形态不记），避免导出时撞 id
    const diId = attrOf(edgeEl, 'id');
    if (diId !== undefined && diId !== `${id}_di`) edge.diId = diId;
    plane.edges[id] = edge;
  }

  return plane;
}

// ─────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────

function readNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function readBool(v: string | undefined): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function readString(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v;
}

function unsupported(el: XmlElement, ctx: Ctx, path: string): void {
  const msg = `元素 '${el.name}' 不在覆盖表内`;
  if (ctx.onUnsupported === 'throw') {
    throw new ModdleError(msg, {
      code: MODDLE_ERROR_CODES.XML_UNSUPPORTED_ELEMENT,
      hint: '见 COVERED_ELEMENT_NAMES；确需导入请传 onUnsupported:"warn"',
      details: { element: el.name, ns: el.ns ?? null, start: el.start, end: el.end },
    });
  }
  ctx.warn(
    diagnostic('warn', MODDLE_DIAGNOSTIC_CODES.VALIDATE_ELEMENT_UNSUPPORTED, msg, {
      start: el.start,
      end: el.end,
      node: { path },
    }),
  );
}

/**
 * 覆盖表外的 BPMN 元素 → **原样快照保全**（§4.5 纪律一：认不出的东西一律保全）。
 *
 * ★ 但**分两个袋子**，判据是命名空间（不是"认不认识"）：
 *
 * - **BPMN 命名空间**的规范元素 → `_bpmnChildren`：导出时**原地**写成父元素的直接子元素。
 *   不能进 `<bpmn:extensionElements>` —— XSD 里它的内容是 `<xsd:any namespace="##other"/>`，
 *   规范元素放进去产出的是**非法** XML（`ioSpecification` / `multiInstanceLoopCharacteristics`
 *   / `potentialOwner` … 曾因此让 19 份语料的往返产物被官方 XSD 拒收）。
 * - **其它命名空间**（`camunda:*` 之类）→ `_extensionElements`：这才是 `extensionElements` 的地盘。
 */
function preserveElement(
  el: XmlElement,
  into: { extension?: ExtensionBag | undefined },
  ctx: Ctx,
  path: string,
): void {
  if (ctx.onUnsupported === 'throw') {
    unsupported(el, ctx, path);
    return;
  }
  const bag = (into.extension ??= {});
  const key = el.ns === BPMN_NS ? '_bpmnChildren' : '_extensionElements';
  const prev = bag[key];
  const arr: string[] = Array.isArray(prev) ? (prev as string[]).slice() : [];
  arr.push(snapshot(el));
  bag[key] = arr;
  if (ctx.onUnsupported === 'warn') {
    ctx.warn(
      diagnostic(
        'warn',
        MODDLE_DIAGNOSTIC_CODES.VALIDATE_ELEMENT_PRESERVED,
        `元素 '${el.name}' 不在覆盖表内，已原样保全（往返不丢）`,
        { start: el.start, end: el.end, node: { path } },
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 泳道 / 协作图
// ─────────────────────────────────────────────────────────────────

function collaborationFromXml(el: XmlElement): Collaboration {
  const out: Collaboration = { id: attrOf(el, 'id') ?? '', participants: [], messageFlows: [] };
  const name = attrOf(el, 'name');
  if (name !== undefined) out.name = name;
  for (const child of childElements(el)) {
    if (child.ns !== BPMN_NS) continue;
    if (child.local === 'participant') {
      out.participants.push(participantFromXml(child));
      continue;
    }
    if (child.local === 'messageFlow') {
      const mf = messageFlowFromXml(child);
      // 缺 sourceRef / targetRef 的非法连线：不建模，但**不能丢**（纪律一）
      if (mf) out.messageFlows.push(mf);
      else (out.extraElements ??= []).push(snapshot(child));
      continue;
    }
    if (child.local === 'extensionElements') {
      const bag = extensionElementsToBag(child);
      if (bag) out.extension = bag;
      continue;
    }
    // 会话族等不落地内容：原样快照（纪律一）
    (out.extraElements ??= []).push(snapshot(child));
  }
  const bag: ExtensionBag = {};
  for (const a of el.attrs) {
    if (a.local === 'id' || a.local === 'name') continue;
    if (a.prefix === 'xmlns' || a.local === 'xmlns') continue;
    bag[a.name] = a.value;
  }
  if (Object.keys(bag).length) out.extension = { ...bag, ...(out.extension ?? {}) };
  return out;
}

function participantFromXml(el: XmlElement): Participant {
  const out: Participant = { id: attrOf(el, 'id') ?? '' };
  const name = attrOf(el, 'name');
  if (name !== undefined) out.name = name;
  const pr = attrOf(el, 'processRef');
  if (pr !== undefined) out.processRef = pr;
  const bag: ExtensionBag = {};
  for (const a of el.attrs) {
    if (a.local === 'id' || a.local === 'name' || a.local === 'processRef') continue;
    if (a.prefix === 'xmlns' || a.local === 'xmlns') continue;
    bag[a.name] = a.value;
  }
  const ext = extensionElementsToBag(childByNs(el, BPMN_NS, 'extensionElements'));
  if (ext) Object.assign(bag, ext);
  if (Object.keys(bag).length) out.extension = bag;
  return out;
}

function messageFlowFromXml(el: XmlElement): MessageFlow | undefined {
  const id = attrOf(el, 'id');
  const from = attrOf(el, 'sourceRef');
  const to = attrOf(el, 'targetRef');
  if (id === undefined || from === undefined || to === undefined) return undefined;
  const out: MessageFlow = { id, from, to };
  const name = attrOf(el, 'name');
  if (name !== undefined) out.name = name;
  const bag: ExtensionBag = {};
  for (const a of el.attrs) {
    if (a.local === 'id' || a.local === 'name' || a.local === 'sourceRef' || a.local === 'targetRef') continue;
    if (a.prefix === 'xmlns' || a.local === 'xmlns') continue;
    bag[a.name] = a.value;
  }
  const ext = extensionElementsToBag(childByNs(el, BPMN_NS, 'extensionElements'));
  if (ext) Object.assign(bag, ext);
  if (Object.keys(bag).length) out.extension = bag;
  return out;
}

function laneSetFromXml(el: XmlElement): LaneSet {
  // ★ `laneSet@id` 在 XSD 里 optional（MIWG `C.10.0` 的 laneSet 就没有 id）
  // —— 不能像以前那样造一个空串 id 顶上，那会让校验器报 "Too small"。
  const out: LaneSet = { lanes: [] };
  const id = attrOf(el, 'id');
  if (id !== undefined) out.id = id;
  const name = attrOf(el, 'name');
  if (name !== undefined) out.name = name;
  for (const child of childElements(el)) {
    if (child.ns !== BPMN_NS) continue;
    if (child.local === 'lane') {
      out.lanes.push(laneFromXml(child));
      continue;
    }
    if (child.local === 'extensionElements') {
      const bag = extensionElementsToBag(child);
      if (bag) out.extension = bag;
      continue;
    }
  }
  const bag: ExtensionBag = {};
  for (const a of el.attrs) {
    if (a.local === 'id' || a.local === 'name') continue;
    if (a.prefix === 'xmlns' || a.local === 'xmlns') continue;
    bag[a.name] = a.value;
  }
  if (Object.keys(bag).length) out.extension = { ...bag, ...(out.extension ?? {}) };
  return out;
}

function laneFromXml(el: XmlElement): Lane {
  const out: Lane = { id: attrOf(el, 'id') ?? '' };
  const name = attrOf(el, 'name');
  if (name !== undefined) out.name = name;
  const per = attrOf(el, 'partitionElementRef');
  if (per !== undefined) out.partitionElementRef = per;
  for (const child of childElements(el)) {
    if (child.ns !== BPMN_NS) continue;
    // ★ 泳道真正的数据：哪些节点归这条道
    if (child.local === 'flowNodeRef') {
      const t = textContent(child).trim();
      if (t) (out.nodeIds ??= []).push(t);
      continue;
    }
    if (child.local === 'childLaneSet') {
      const inner = laneSetFromXml(child);
      if (inner.lanes.length) out.lanes = inner.lanes;
      continue;
    }
    if (child.local === 'extensionElements') {
      const bag = extensionElementsToBag(child);
      if (bag) out.extension = bag;
      continue;
    }
    // ★ 与 `preserveElement` 同一条判据：BPMN 命名空间的元素不能进 `extensionElements`
    const bag = (out.extension ??= {});
    const key = child.ns === BPMN_NS ? '_bpmnChildren' : '_extensionElements';
    const prev = bag[key];
    const arr: string[] = Array.isArray(prev) ? (prev as string[]).slice() : [];
    arr.push(snapshot(child));
    bag[key] = arr;
  }
  const bag: ExtensionBag = {};
  for (const a of el.attrs) {
    if (a.local === 'id' || a.local === 'name' || a.local === 'partitionElementRef') continue;
    if (a.prefix === 'xmlns' || a.local === 'xmlns') continue;
    bag[a.name] = a.value;
  }
  if (Object.keys(bag).length) out.extension = { ...bag, ...(out.extension ?? {}) };
  return out;
}

/**
 * 收集文件里出现过的 `xmlns:*`（标准六个与 floken 除外）→ `meta['@namespaces']`。
 *
 * ★ **不能**因为「前缀在 {@link KNOWN_EXT_NS} 里」就不记 —— 记的是 **URI**，
 * 而同一个前缀在不同文件里绑的 URI 未必相同（`camunda:` 在 7.x 与 8.x 下不同）。
 * 漏记的后果是导出时**没有声明却写回了该前缀的属性**，产出自己都解析不了的非法文件
 * （MIWG 的 C.9.0 / C.9.2 就是这么炸的：写回 `camunda:diagramRelationId` 却没写 `xmlns:camunda`）。
 * 递归收集（声明可能挂在任意后代上，不只根元素）。
 */
function collectNamespaces(root: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  const standard = new Set([
    BPMN_NS,
    BPMNDI_NS,
    DC_NS,
    DI_NS,
    FLOKEN_NS,
    XSI_NS,
    XML_NS,
  ]);
  const walk = (el: XmlElement): void => {
    for (const [prefix, uri] of Object.entries(el.nsDecls)) {
      if (!prefix || standard.has(uri)) continue;
      // 与已知表**完全一致**的绑定不记：导出时从 KNOWN_EXT_NS 补得出同一个 URI，
      // 记了只会让 `meta` 凭空多一个键，把 AC-S2 的「往返全等」打破。
      if (KNOWN_EXT_NS[prefix] === uri) continue;
      out[prefix] = uri;
    }
    for (const c of childElements(el)) walk(c);
  };
  walk(root);
  return out;
}
