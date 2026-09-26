/**
 * **AC-S4**：类型表里每个**可实例化**类型都要能「进类型表 → 导出 XML → 解析回来」不丢不歪。
 *
 * 覆盖范围 = 语义层 120 个非抽象类型 + 图形层（DI）非抽象类型 —— 数字一律从
 * `SPEC_STATS` / `DI_TYPES` 推导，不手抄（§5.1 的教训：手列的数字迟早错）。
 *
 * 为什么**只跑可实例化的**：抽象类型（`Gateway` / `Activity` / `FlowElement` …）在 XSD 里
 * 就没有对应的元素，实例化它们产出的 XML 是**非法**的，跑了是假绿。
 *
 * 这一条测的是**类型表本身**的完整性（属性名/attr-or-element 判定/命名空间），
 * 不是语义映射（后者归 `xml.test.ts` 的 48 类图面元素往返）。
 */

import { describe, expect, it } from 'vitest';

import { BPMN_TYPES, DI_TYPES, SPEC_STATS, effectiveProperties, xmlNameOf } from '../src/spec/index.js';
import type { BpmnNs, PropertySpec } from '../src/spec/spec-types.js';
import {
  attrOf,
  childElements,
  childrenByNs,
  parseXml,
  textContent,
  type XmlElement,
} from '../src/xml/sax.js';
import { el, serializeXml, type XmlChild } from '../src/xml/writer.js';
import { BPMN_NS, BPMNDI_NS, DC_NS, DI_NS, PREFIX_BY_NS } from '../src/xml/namespaces.js';

const NS_URI_OF: Record<BpmnNs, string> = {
  bpmn: BPMN_NS,
  bpmndi: BPMNDI_NS,
  di: DI_NS,
  dc: DC_NS,
};

const SCALARS: Record<string, string> = {
  String: 'v',
  Boolean: 'true',
  Integer: '7',
  Real: '1.5',
};

/** 该属性要不要跳过（XML 里根本不存在 / 我们无法凭空造出合法内容） */
function skipReason(p: PropertySpec): string | undefined {
  if (p.isVirtual || p.isReadOnly) return 'virtual/readOnly';
  if (p.isMany && p.isAttr) return 'isMany+isAttr（空格分隔列表，形态不唯一）';
  return undefined;
}

/** 标量就返回样例值，复杂类型返回 `undefined`（不展开造，避免递归到天荒地老） */
function sampleValue(p: PropertySpec): string | undefined {
  if (p.isReference) return 'Ref_1';
  return SCALARS[p.type];
}

describe('AC-S4 全类型逐个往返', () => {
  const targets = [
    ...BPMN_TYPES.filter((t) => !t.isAbstract).map((t) => ({ ...t, group: 'bpmn' as const })),
    ...DI_TYPES.filter((t) => !t.isAbstract).map((t) => ({ ...t, group: 'di' as const })),
  ];

  it('覆盖数 = 语义层可实例化 + 图形层可实例化（数字从数据算）', () => {
    const semantic = BPMN_TYPES.filter((t) => !t.isAbstract).length;
    const graphic = DI_TYPES.filter((t) => !t.isAbstract).length;
    expect(semantic).toBe(SPEC_STATS.semanticInstantiable);
    expect(targets.length).toBe(semantic + graphic);
    expect(targets.length).toBeGreaterThanOrEqual(SPEC_STATS.semanticInstantiable);
  });

  it('每个类型生成的最小实例都能被解析回来且不丢属性', () => {
    const failures: string[] = [];
    let checked = 0;
    let withProps = 0;
    const bare: string[] = [];

    for (const t of targets) {
      const prefix = t.ns;
      const xmlName = xmlNameOf(t.name);
      const props = effectiveProperties(t.name, t.ns);

      const attrs: Record<string, string> = {};
      const kids: XmlChild[] = [];
      const expectedAttrs: Array<[string, string]> = [];
      const expectedChildren: Array<[string, string]> = [];

      for (const [, p] of props) {
        if (skipReason(p)) continue;
        const v = sampleValue(p);
        if (v === undefined) continue;
        if (p.isAttr) {
          attrs[p.name] = v;
          expectedAttrs.push([p.name, v]);
        } else {
          const childPrefix = p.type.includes(':') ? p.type.split(':')[0] : prefix;
          kids.push(el(`${childPrefix}:${p.name}`, {}, [v]));
          expectedChildren.push([p.name, v]);
        }
      }

      const rootAttrs: Record<string, string> = {
        'xmlns:bpmn': BPMN_NS,
        'xmlns:bpmndi': BPMNDI_NS,
        'xmlns:di': DI_NS,
        'xmlns:dc': DC_NS,
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        ...attrs,
      };
      const xml = serializeXml(el(`${prefix}:${xmlName}`, rootAttrs, kids));

      try {
        const doc = parseXml(xml);
        const root: XmlElement = doc.root;
        if (root.local !== xmlName) failures.push(`${t.name}: 根元素名 != ${xmlName}（${root.local}）`);
        if ((root.ns ?? '') !== NS_URI_OF[t.ns]) failures.push(`${t.name}: 命名空间 != ${t.ns}`);
        for (const [k, v] of expectedAttrs) {
          if (attrOf(root, k) !== v) failures.push(`${t.name}: 属性 ${k} 回读为 ${String(attrOf(root, k))}`);
        }
        for (const [k, v] of expectedChildren) {
          const list = childrenByNs(root, NS_URI_OF[t.ns], k);
          if (!list.length) failures.push(`${t.name}: 子元素 ${k} 丢失`);
          else if (textContent(list[0] as XmlElement) !== v) {
            failures.push(`${t.name}: 子元素 ${k} 文本 != ${v}`);
          }
        }
        // 自洽：解析出的子元素数应与我们写进去的一致（多的说明有属性被当成子元素重复落盘）
        const parsedKids = childElements(root).filter((c) => !expectedChildren.some(([k]) => k === c.local));
        if (parsedKids.length) failures.push(`${t.name}: 多出子元素 ${parsedKids.map((c) => c.local).join(',')}`);
        checked += 1;
        if (expectedAttrs.length + expectedChildren.length > 0) withProps += 1;
        else bare.push(t.name);
      } catch (e) {
        failures.push(`${t.name}: 抛错 ${(e as Error).message}`);
      }
    }

    expect(checked).toBe(targets.length);
    expect(failures).toEqual([]);

    // 防「空跑」：绝大多数类型必须有属性被真实校验（裸类型允许存在，但不能是大多数）
    console.log(
      `[AC-S4] 实例化往返 ${checked} 个类型；有属性被校验 ${withProps} 个；裸类型 ${bare.length} 个` +
        (bare.length ? `：${bare.join(', ')}` : ''),
    );
    expect(withProps).toBeGreaterThanOrEqual(Math.floor(targets.length * 0.9));
  });
});

it('命名空间 URI → 前缀映射齐备（四大标准命名空间）', () => {
  expect(PREFIX_BY_NS[BPMN_NS]).toBe('bpmn');
  expect(PREFIX_BY_NS[BPMNDI_NS]).toBe('bpmndi');
  expect(PREFIX_BY_NS[DI_NS]).toBe('di');
  expect(PREFIX_BY_NS[DC_NS]).toBe('dc');
});
