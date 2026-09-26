/**
 * ★ 自有扩展值的 JSON ⇄ XML 编解码（`<floken:*>` 的落点）
 *
 * 问题：XML 只有**字符串**，而我们要保住 `false` / `0.5` / `[]` / `{}` 的**类型**。
 * 常见做法是"读回来再猜"，但 `allowed="false"` 猜成布尔、`version="1"` 猜成数字，
 * 全靠猜就没有往返恒等 —— §6.5 坑 3 说的正是这件事（`false` 被吞 = 语义反转）。
 *
 * 所以这里用**显式类型标记**：仅在值不是字符串时打一个 `t` 属性。
 *
 * | JSON | XML |
 * |---|---|
 * | 字符串 | `<floken:k>text</floken:k>`（空串 = `<floken:k />`） |
 * | 数字 | `<floken:k t="number">0.5</floken:k>` |
 * | 布尔 | `<floken:k t="boolean">false</floken:k>` |
 * | null | `<floken:k t="null" />` |
 * | 对象 | `<floken:k>` + 每个键一个子元素；空对象加 `t="object"` |
 * | 数组 | `<floken:k t="array">` + 每项一个子元素（名字只是好看，读回时**不看**名字）；空数组加 `t="array"` |
 * | undefined | **不写**（与 null 不同：null 是"显式为空"） |
 *
 * 读回的判据只有 `t` 属性与「有没有子元素」，**永远不猜**。
 *
 * 为什么不用属性存标量（`<floken:approver type="user" value="u1"/>` 那样更短）：
 * 属性同样只有字符串，一样要类型标记，而且标记得挂在**另一个属性**上
 * （`t-type="string"`），比挂在自己身上更难读。元素 + 文本是最少歧义的形态。
 */

import { MODDLE_ERROR_CODES, ModdleError } from '../core/errors.js';
import type { XmlElement } from './sax.js';
import { el, type XmlBuilder } from './writer.js';

/** XML NCName 的保守判据：字母/下划线开头，只含字母数字下划线点连字符 */
const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function assertNcName(key: string): void {
  if (!NCNAME.test(key)) {
    throw new ModdleError('扩展字段名不是合法的 XML 名字', {
      code: MODDLE_ERROR_CODES.XML_UNSUPPORTED_VALUE,
      details: { key },
      hint: '自有扩展的键只允许字母/数字/下划线；含特殊字符的内容请走 _extensionElements 原样快照',
    });
  }
}

/** 数组项的元素名：仅影响可读性（读回时按 `t="array"` 判，不看名字） */
function itemName(key: string): string {
  return key.endsWith('s') ? key.slice(0, -1) : key;
}

/**
 * JSON 值 → `prefix:key` 元素。`undefined` 返回 `undefined`（调用方跳过）。
 */
export function jsonToXml(key: string, value: unknown, prefix: string): XmlBuilder | undefined {
  assertNcName(key);
  if (value === undefined) return undefined;
  const name = `${prefix}:${key}`;

  if (value === null) return el(name, { t: 'null' });

  if (Array.isArray(value)) {
    const kids: XmlBuilder[] = [];
    const item = itemName(key);
    for (const v of value) {
      const kid = jsonToXml(item, v, prefix);
      if (kid) kids.push(kid);
    }
    return el(name, { t: 'array' }, kids);
  }

  if (typeof value === 'object') {
    const kids: XmlBuilder[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const kid = jsonToXml(k, v, prefix);
      if (kid) kids.push(kid);
    }
    return el(name, kids.length ? {} : { t: 'object' }, kids);
  }

  if (typeof value === 'boolean') return el(name, { t: 'boolean' }, [String(value)]);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ModdleError('数值无法用 XML 表达', {
        code: MODDLE_ERROR_CODES.XML_UNSUPPORTED_VALUE,
        details: { key, value: String(value) },
        hint: 'NaN / Infinity 没有 XML 表示，请改成 null 或字符串',
      });
    }
    return el(name, { t: 'number' }, [String(value)]);
  }
  if (typeof value !== 'string') {
    throw new ModdleError('值无法用 XML 表达', {
      code: MODDLE_ERROR_CODES.XML_UNSUPPORTED_VALUE,
      details: { key, type: typeof value },
    });
  }
  return el(name, {}, [value]);
}

/**
 * `prefix:*` 元素 → JSON 值。
 *
 * 宽容点只有一处：**未知类型标记不报错、按字符串处理** ——
 * 旧版本写的 `t` 值若将来被废弃，静默退化成文本比抛错更有用；
 * 反过来，"没有标记就猜类型"是**绝不做**的。
 */
export function xmlToJson(node: XmlElement): unknown {
  const t = node.attrs.find((a) => a.local === 't' && a.ns === undefined)?.value;
  if (t === 'null') return null;
  if (t === 'array') {
    return node.children
      .filter((c): c is XmlElement => c.kind === 'element')
      .map((c) => xmlToJson(c));
  }
  if (t === 'object') return {};

  const kids = node.children.filter((c): c is XmlElement => c.kind === 'element');
  if (kids.length) {
    const out: Record<string, unknown> = {};
    for (const k of kids) out[k.local] = xmlToJson(k);
    return out;
  }

  const text = node.children
    .filter((c) => c.kind === 'text' || c.kind === 'cdata')
    .map((c) => (c.kind === 'text' || c.kind === 'cdata' ? c.value : ''))
    .join('');
  if (t === 'number') return Number(text);
  if (t === 'boolean') return text === 'true';
  return text;
}
