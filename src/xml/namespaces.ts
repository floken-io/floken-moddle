/**
 * XML 命名空间常量与前缀表（§6.2「不可逆承诺」的落点）。
 *
 * 两条铁律：
 * 1. **URI 才是身份、前缀只是绑定缩写** —— 解析一律按 URI 识别，
 *    所以历史文件里用旧前缀绑同一个 URI 照样认得（`floken:approval` ≡ `cn:approval`）。
 * 2. **这些值不可改**。前四个是 OMG 的，改了 XML 就不是合法 BPMN；
 *    `FLOKEN_NS` 是我们自己的，但它已经写进用户的 `.bpmn` 文件里了，
 *    改它等于让历史文件里的审批语义静默失效（违 AGENTS.md §5 四禁之「吞异常返默认值」）。
 *
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §6.2
 */

/** BPMN 2.0 语义层 */
export const BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
/** BPMN 图形交换（Diagram Interchange） */
export const BPMNDI_NS = 'http://www.omg.org/spec/BPMN/20100524/DI';
/** OMG DD 图形核心（Bounds / Point） */
export const DC_NS = 'http://www.omg.org/spec/DD/20100524/DC';
/** OMG DD 图形通用（waypoint） */
export const DI_NS = 'http://www.omg.org/spec/DD/20100524/DI';
/** XML Schema instance（`xsi:type`，写 `tFormalExpression` 需要它） */
export const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
/**
 * **`xml` 前缀**是 XML 规范**内置**的（`xml:lang` / `xml:space` / `xml:base`），
 * 按 W3C Namespaces §3 **不需要、也不允许**显式声明。
 * 缺了它，MIWG 语料里一个 `xml:lang` 就能让整个文件解析失败（实测 C.10.0 / C.8.x）。
 */
export const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** ★ 自有扩展命名空间 —— 发布后永久不可改 */
export const FLOKEN_NS = 'http://floken.dev/schema/approval/1.0';
/** 自有扩展的**默认**前缀（可被历史文件改写，解析按 URI 认） */
export const FLOKEN_PREFIX = 'floken';

/** `definitions/@targetNamespace` —— 写自己的域名，不盗用 OMG 的 */
export const TARGET_NS = 'http://floken.dev/schema/bpmn/1.0';

/**
 * 我们写文件时使用的前缀绑定。**顺序即输出顺序**（序列化确定性依赖它）。
 */
export const DEFAULT_PREFIXES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['bpmn', BPMN_NS],
  ['bpmndi', BPMNDI_NS],
  ['dc', DC_NS],
  ['di', DI_NS],
  ['xsi', XSI_NS],
  [FLOKEN_PREFIX, FLOKEN_NS],
]);

/**
 * 内置前缀 → URI。**兜底解析的第一顺位**。
 *
 * ⚠️ 为什么要单独有这张表：`DEFAULT_PREFIXES` 是「写文件时用的绑定」，
 * 而导出末尾补声明时（`completeNamespaceDecls`）扫的是**最终树里实际用到的前缀** ——
 * 净化导出（§6.4）不会预声明 `floken`，但只要树里还写着 `floken:xxx`（哪怕是漏网的），
 * 没有这张表就会产出「用了未声明前缀」的**非法 XML** —— 我们导出的文件自己都读不回来。
 */
export const BUILTIN_PREFIX_NS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(DEFAULT_PREFIXES),
  xml: XML_NS,
});

/**
 * 第三方扩展前缀 → URI（FR-S13：第三方属性还原成原生 XML 属性）。
 *
 * 只登记**确实会在真实 `.bpmn` 里出现**的前缀，且只用于「写回时补 `xmlns:` 声明」；
 * 遇到未登记的前缀时，解析阶段会把文件里实际的 `xmlns:` 声明记进
 * `meta['@namespaces']`，导出时照样能补出来 —— 所以这张表**不是**保全的前提，只是兜底。
 */
export const KNOWN_EXT_NS: Readonly<Record<string, string>> = Object.freeze({
  camunda: 'http://camunda.org/schema/1.0/bpmn',
  zeebe: 'http://camunda.org/schema/zeebe/1.0',
  flowable: 'http://flowable.org/bpmn',
  activiti: 'http://activiti.org/bpmn',
  bioc: 'http://bpmn.io/schema/bpmn/biocolor/1.0',
  color: 'http://www.omg.org/spec/BPMN/non-normative/color/1.0',
});

/** 反向表：URI → 推荐前缀。给「未知 URI 起前缀」的场景用 */
export const PREFIX_BY_NS: Readonly<Record<string, string>> = Object.freeze({
  [BPMN_NS]: 'bpmn',
  [BPMNDI_NS]: 'bpmndi',
  [DC_NS]: 'dc',
  [DI_NS]: 'di',
  [XSI_NS]: 'xsi',
  [FLOKEN_NS]: FLOKEN_PREFIX,
  ...KNOWN_EXT_NS,
});

/** 拆 QName：`bpmn:userTask` → `{ prefix:'bpmn', local:'userTask' }` */
export function splitQName(name: string): { prefix?: string; local: string } {
  const i = name.indexOf(':');
  if (i < 0) return { local: name };
  return { prefix: name.slice(0, i), local: name.slice(i + 1) };
}

/** 拼 QName；无前缀时返回裸名（`prefix` 为 undefined / 空串都算没有） */
export function joinQName(prefix: string | undefined, local: string): string {
  return prefix ? `${prefix}:${local}` : local;
}

/**
 * 命名空间作用域栈。
 *
 * 前缀绑定是**栈式**的（子元素可覆盖父元素），默认命名空间（`xmlns="..."`）单独一条线 ——
 * 它**不作用于属性**（W3C Namespaces §6.2：无前缀的属性不属于任何命名空间）。
 */
export class NsScope {
  /** 初始层就带上 `xml`（内置前缀，永远生效，且**不可**被声明覆盖） */
  private readonly stack: Record<string, string>[] = [{ xml: XML_NS }];

  push(bindings: Record<string, string>): void {
    this.stack.push({ ...this.current(), ...bindings });
  }

  pop(): void {
    this.stack.pop();
  }

  private current(): Record<string, string> {
    return this.stack[this.stack.length - 1] ?? {};
  }

  /** 查前缀绑定的 URI；`''` 表示默认命名空间。未绑定返回 `undefined` */
  resolve(prefix: string): string | undefined {
    if (prefix === 'xml') return XML_NS; // 内置，不可被覆盖
    return this.current()[prefix];
  }

  /** 复制当前**全部**生效的绑定（含祖先的）—— 给元素打「命名空间现场」快照用 */
  capture(): Record<string, string> {
    return { ...this.current() };
  }
}
