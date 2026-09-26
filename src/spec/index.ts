/**
 * BPMN 2.0 规范查询 API。
 *
 * 数据来自 `*.generated.ts`（生成产物），这里只提供**查询与继承展开**，
 * 不持有一份自己的类型清单 —— 规模永远从这个 data 算，不是抄数字。
 *
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §3
 */
import { BPMN_TYPES, BPMN_ABSTRACT_TYPES } from './bpmn.generated.js';
import { DI_TYPES, DI_TYPE_GROUPS } from './di.generated.js';
import { ENUMERATIONS } from './enums.generated.js';
import type { BpmnNs, BpmnTypeSpec, PropertySpec } from './spec-types.js';

export type { BpmnNs, BpmnTypeSpec, PropertySpec };
export { BPMN_TYPES, BPMN_ABSTRACT_TYPES, DI_TYPES, DI_TYPE_GROUPS, ENUMERATIONS };

/* ───────────────────────────── 索引 ───────────────────────────── */

const SEMANTIC_INDEX: ReadonlyMap<string, BpmnTypeSpec> = new Map(
  BPMN_TYPES.map((t) => [t.name, t]),
);
const GRAPHIC_INDEX: ReadonlyMap<string, BpmnTypeSpec> = new Map(
  DI_TYPES.map((t) => [t.name, t]),
);

/**
 * 跨命名空间重名的类型。`bpmn:Extension`（扩展容器）与 `di:Extension`（DI 扩展）
 * 同名不同源 —— 不指定 ns 时 {@link getSpec} 取语义层那个。
 */
export const DUPLICATE_TYPE_NAMES: readonly string[] = Object.freeze(
  [...GRAPHIC_INDEX.keys()].filter((n) => SEMANTIC_INDEX.has(n)),
);

/* ───────────────────────────── 查询 ───────────────────────────── */

/** 从 `ns:Name` 里拆 namespace；没有前缀时返回 `undefined` */
function splitRef(ref: string): { ns?: string; name: string } {
  const i = ref.indexOf(':');
  return i < 0 ? { name: ref } : { ns: ref.slice(0, i), name: ref.slice(i + 1) };
}

/** 按命名空间取该组的类型数组（`'bpmn'` 走语义层，其余走图形层） */
function groupOf(ns: string): readonly BpmnTypeSpec[] {
  return ns === 'bpmn' ? BPMN_TYPES : (DI_TYPE_GROUPS[ns] ?? []);
}

/**
 * 按**引用**解析类型 —— 引用可以是裸名（`Task`）或限定名（`di:Diagram`）。
 *
 * ⚠️ 走 `ns:` 前缀解析是必需的：`bpmndi` 层会跨命名空间继承 `di:Diagram` / `di:DiagramElement`，
 * 只按裸名查会查不到（而且 `Extension` 在 bpmn 与 di 里同名不同源，裸名查一律有歧义）。
 */
export function resolveSpec(ref: string): BpmnTypeSpec | undefined {
  const { ns, name } = splitRef(ref);
  if (ns) return groupOf(ns).find((t) => t.name === name);
  return SEMANTIC_INDEX.get(name) ?? GRAPHIC_INDEX.get(name);
}

/** 取类型定义。引用可以是裸名或限定名；不指定 `ns` 时**语义层优先**。 */
export function getSpec(name: string, ns?: BpmnNs): BpmnTypeSpec | undefined {
  if (ns) return groupOf(ns).find((t) => t.name === name);
  return resolveSpec(name);
}

/** 找不到就抛 —— 内部调用点用这个，避免 `!` 满天飞 */
export function specOf(name: string, ns?: BpmnNs): BpmnTypeSpec {
  const spec = getSpec(name, ns);
  if (!spec) throw new Error(`未知的 BPMN 类型：${ns ? ns + ':' : ''}${name}`);
  return spec;
}

export function isAbstract(name: string, ns?: BpmnNs): boolean {
  return getSpec(name, ns)?.isAbstract === true;
}

/* ──────────────────────── 继承关系 ──────────────────────── */

/** 内部版：祖先链一律返回**限定名** `ns:Name`，避免跨命名空间时被剥裸名导致查错。 */
function qualifiedAncestors(start: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([start]);
  let frontier = [start];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      const spec = resolveSpec(cur);
      if (!spec) continue;
      for (const parent of spec.superClass ?? []) {
        const key = parent.includes(':') ? parent : `${spec.ns}:${parent}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
        next.push(key);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * 祖先链，**由近到远**（`UserTask` → `['Task','Activity','InteractionNode','FlowNode',…]`）。
 * 多重继承走广度优先，所以最近的覆盖最远的。
 *
 * ⚠️ **跨命名空间的祖先保留 `ns:` 前缀**：`BPMNDiagram` 的父类是 `di:Diagram`，
 * 剥成裸名 `Diagram` 就说不清它是哪个命名空间的了。同命名空间内的祖先一律是裸名。
 * 环与悬空引用按已访问集合剪枝，不会死循环。
 */
export function ancestorsOf(name: string, ns?: BpmnNs): readonly string[] {
  const startNs = ns ?? resolveSpec(name)?.ns ?? 'bpmn';
  return qualifiedAncestors(`${startNs}:${name}`).map((ref) =>
    ref.startsWith(`${startNs}:`) ? ref.slice(startNs.length + 1) : ref,
  );
}

/** 自身 + {@link ancestorsOf}，自身在最前 */
export function selfAndAncestors(name: string, ns?: BpmnNs): readonly string[] {
  return [name, ...ancestorsOf(name, ns)];
}

/** `name` 是不是 `ancestor` 的后代（或就是它自己） */
export function isSubtypeOf(name: string, ancestor: string, ns?: BpmnNs): boolean {
  return selfAndAncestors(name, ns).includes(ancestor);
}

/* ──────────────────────── 属性展开 ──────────────────────── */

/**
 * 把继承树上的属性摊平到一张表，**子类覆盖父类同名属性**。
 * 这是白名单校验与属性面板的数据源 —— 只看类型自己声明的那几行是不够的。
 */
export function effectiveProperties(
  name: string,
  ns?: BpmnNs,
): ReadonlyMap<string, PropertySpec> {
  const out = new Map<string, PropertySpec>();
  const startNs = ns ?? resolveSpec(name)?.ns ?? 'bpmn';
  // 由远到近写入，近的自然覆盖远的（限名版，跨命名空间的父类也不会漏）
  for (const ref of [...qualifiedAncestors(`${startNs}:${name}`)].reverse()) {
    for (const p of resolveSpec(ref)?.properties ?? []) out.set(p.name, p);
  }
  for (const p of getSpec(name, ns)?.properties ?? []) out.set(p.name, p);
  return out;
}

/** {@link effectiveProperties} 的名清单（祖先属性在前，自有属性在后） */
export function propertyNames(name: string, ns?: BpmnNs): readonly string[] {
  return [...effectiveProperties(name, ns).keys()];
}

/* ──────────────────────── XML 名互换 ──────────────────────── */

/**
 * 类型名 → XML 元素名/JSON `type`（大驼峰 → 小驼峰）。
 * 这条恒等关系是 Model JSON 的基石：`userTask` 必须是 BPMN 的名字，不能叫 `审批节点`。
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §4.1
 */
export function xmlNameOf(typeName: string): string {
  return typeName.charAt(0).toLowerCase() + typeName.slice(1);
}

/** {@link xmlNameOf} 的逆：小驼峰 → 大驼峰。返回 `undefined` 表示规范里没有这个元素名。 */
export function typeNameOf(xmlName: string): string | undefined {
  const t = xmlName.charAt(0).toUpperCase() + xmlName.slice(1);
  return SEMANTIC_INDEX.has(t) ? t : undefined;
}

/** 语义层里可实例化的类型（非抽象）—— 白名单校验的候选集 */
export function instantiableSpecs(): readonly BpmnTypeSpec[] {
  return BPMN_TYPES.filter((t) => !t.isAbstract);
}

/* ──────────────────────── 规模（从 data 算） ──────────────────────── */

const countProps = (specs: readonly BpmnTypeSpec[]) =>
  specs.reduce((n, s) => n + s.properties.length, 0);

/**
 * 类型表规模。**从数据算，不是抄的数字** —— 类型表一改，这个就跟着改，
 * 测试再用它钉死契约（137/318），改动就不会静默溜过去。
 */
export const SPEC_STATS: Readonly<Record<string, number>> = Object.freeze({
  semanticTypes: BPMN_TYPES.length,
  semanticProperties: countProps(BPMN_TYPES),
  semanticAbstract: BPMN_TYPES.filter((t) => t.isAbstract).length,
  semanticInstantiable: BPMN_TYPES.filter((t) => !t.isAbstract).length,
  graphicTypes: DI_TYPES.length,
  graphicProperties: countProps(DI_TYPES),
  /** 四份描述符合计；与「对外口径 137」差的是图形层 */
  totalTypes: BPMN_TYPES.length + DI_TYPES.length,
  enumerations: Object.keys(ENUMERATIONS).length,
  /** abstract 清单长度应与 {semanticAbstract} 相等（两者互为交叉校验） */
  abstractListLength: BPMN_ABSTRACT_TYPES.length,
});
