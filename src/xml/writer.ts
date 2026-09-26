/**
 * 自研 XML 构造器与序列化器（Q38：不引第三方 XML 库）。
 *
 * **为什么用构造器而不是拼字符串**（§6.5.2）：拼错不会报错，只会静默产出非法文件 ——
 * 这是最坏的一类 bug。构造器把「转义 / 自闭合 / 缩进」收在一处，调用方只描述结构。
 *
 * **输出的确定性是硬要求**：AC-S2（往返恒等）与 AC-S3（规范化后逐字节一致）都依赖
 * 「同一模型永远得到同一串字节」。因此：
 * - 属性**按写入顺序**输出（不排序、不按对象键的偶然顺序）；
 * - 缩进固定两空格、换行固定 `\n`（不随平台变）；
 * - 缩进用两个空格而非制表符，与 bpmn-js 产出的习惯一致。
 */

import { argError, unknownOptionError } from '../core/errors.js';

/** 允许的属性值类型。`undefined` = 省略该属性（与"空字符串"不同，别混） */
export type AttrValue = string | number | boolean | undefined;

export interface XmlBuilder {
  name: string;
  attrs: Array<[string, string | number | boolean]>;
  children: XmlChild[];
}

/** 原样输出（供 `_extensionElements` 快照回写用 —— 那段是别人的 XML，我们不做解释） */
export class RawXml {
  constructor(readonly text: string) {}
}

export type XmlChild = XmlBuilder | string | RawXml;

export interface SerializeOptions {
  /** 是否输出 `<?xml …?>`（默认 true） */
  declaration?: boolean;
  /** 缩进（默认两空格） */
  indent?: string;
  /** 换行（默认 `\n`，**不随平台变**） */
  newline?: string;
}

export const SERIALIZE_OPTION_KEYS: readonly string[] = Object.freeze([
  'declaration',
  'indent',
  'newline',
]);

/**
 * 建一个元素。
 *
 * @param name QName（调用方负责前缀，如 `bpmn:userTask`）
 * @param attrs 属性表；`undefined` 的项会被**省略**（不是写成空串）
 */
export function el(
  name: string,
  attrs: Record<string, AttrValue> = {},
  children: XmlChild[] = [],
): XmlBuilder {
  const list: Array<[string, string | number | boolean]> = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    list.push([k, v]);
  }
  return { name, attrs: list, children };
}

/** 转义文本节点：`<` `&` 必转，`>` 一并转（与 bpmn-js 的习惯一致，读起来更对称） */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

/**
 * 转义属性值。
 * 除了 `&` `<` `>` `"`，**换行/制表符也必须转成字符引用** ——
 * XML 的属性值归一化会把字面换行变成空格，不转的话往返会静默改值。
 */
export function escapeAttr(v: string | number | boolean): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;');
}

function hasElementChild(node: XmlBuilder): boolean {
  return node.children.some((c) => typeof c !== 'string');
}

function push(
  out: string[],
  node: XmlBuilder,
  depth: number,
  indent: string,
  newline: string,
): void {
  const pad = indent.repeat(depth);
  const attrs = node.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  const kids = node.children.filter((c) => c !== '' && c !== undefined);

  if (kids.length === 0) {
    out.push(`${pad}<${node.name}${attrs} />`);
    return;
  }
  if (!hasElementChild(node)) {
    // 纯文本：单行内联，读起来紧凑
    const text = kids.map((c) => (typeof c === 'string' ? escapeText(c) : '')).join('');
    out.push(`${pad}<${node.name}${attrs}>${text}</${node.name}>`);
    return;
  }
  out.push(`${pad}<${node.name}${attrs}>`);
  for (const c of kids) {
    if (typeof c === 'string') {
      out.push(`${indent.repeat(depth + 1)}${escapeText(c)}`);
    } else if (c instanceof RawXml) {
      // 原样片段：按当前缩进重排一次行首，保证嵌套进来的第三方 XML 也整齐
      const lines = c.text.split('\n').filter((l) => l.trim() !== '');
      for (const l of lines) out.push(`${indent.repeat(depth + 1)}${l.trim()}`);
    } else {
      push(out, c, depth + 1, indent, newline);
    }
  }
  out.push(`${pad}</${node.name}>`);
}

/** 序列化成字符串。`root` 之外不允许第二个顶层节点（XML 只能有一个根） */
export function serializeXml(root: XmlBuilder, opts: SerializeOptions = {}): string {
  if (!root || typeof root.name !== 'string' || root.name === '') {
    throw argError('root', 'a non-empty element', {});
  }
  for (const k of Object.keys(opts)) {
    if (!SERIALIZE_OPTION_KEYS.includes(k)) throw unknownOptionError(k, SERIALIZE_OPTION_KEYS);
  }
  const indent = opts.indent ?? '  ';
  const newline = opts.newline ?? '\n';
  const out: string[] = [];
  if (opts.declaration !== false) out.push('<?xml version="1.0" encoding="UTF-8"?>');
  push(out, root, 0, indent, newline);
  return out.join(newline) + newline;
}
