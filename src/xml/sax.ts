/**
 * ★ 自研 SAX 解析器（Q38：XML 读/写全部自研，不引第三方库）
 *
 * 定位：**够用即止的 XML 1.0 子集**，不是通用解析器。它必须做到四件事：
 * 1. **命名空间正确** —— 前缀是绑定缩写、URI 才是身份（§6.2）。历史文件用旧前缀绑同一 URI 也认得。
 * 2. **定位精确** —— 每个节点带扁平偏移，错误才有 `position`（AGENTS.md §5）。
 * 3. **脏文件不静默** —— 未闭合 / 重名属性 / 未声明前缀 / 非法字符一律**抛**，不是容错跳过。
 *    理由：解析层静默容错 = 后面每个消费者都要各自猜一次（AGENTS.md §5 四禁）。
 * 4. **XXE 默认关闭** —— `<!DOCTYPE` 默认拒绝；即便显式放行，外部实体（`SYSTEM`/`PUBLIC`）**永不展开**。
 *    这是自研最容易漏的一条，也是唯一一条"漏了会变成安全事件"的。
 *
 * 不做：DTD 校验、XInclude、命名空间外的 schema 校验 —— 都不属于本包职责（§11 不做清单）。
 *
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §6.5.1
 */

import { MODDLE_ERROR_CODES, parseError, unknownOptionError, type Position } from '../core/errors.js';
import { NsScope, splitQName } from './namespaces.js';

// ─────────────────────────────────────────────────────────────────
// 节点形状
// ─────────────────────────────────────────────────────────────────

export interface XmlAttr {
  /** 原样 QName */
  name: string;
  prefix?: string;
  local: string;
  /** 解析出的 URI。**无前缀的属性不属于任何命名空间**（W3C Namespaces §6.2），故为 `undefined` */
  ns?: string;
  /** 已展开实体的值 */
  value: string;
  start: number;
  end: number;
}

export interface XmlElement {
  kind: 'element';
  /** 原样 QName */
  name: string;
  prefix?: string;
  local: string;
  ns?: string;
  attrs: XmlAttr[];
  /** 本元素上的 `xmlns` 声明；键 `''` = 默认命名空间 */
  nsDecls: Record<string, string>;
  /**
   * **本元素上生效的**全部绑定（祖先的 + 自己的）。
   * 用途：把子树原样快照成字符串时，必须把它用到的前缀一并写进去，否则那段 XML 是非法的。
   */
  nsInScope: Record<string, string>;
  children: XmlNode[];
  selfClosing: boolean;
  start: number;
  end: number;
}

export interface XmlText {
  kind: 'text';
  /** 已展开实体的文本 */
  value: string;
  start: number;
  end: number;
}

export interface XmlCdata {
  kind: 'cdata';
  value: string;
  start: number;
  end: number;
}

export interface XmlComment {
  kind: 'comment';
  value: string;
  start: number;
  end: number;
}

export type XmlNode = XmlElement | XmlText | XmlCdata | XmlComment;

export interface XmlDeclaration {
  version?: string;
  encoding?: string;
  standalone?: string;
}

export interface XmlDocument {
  declaration?: XmlDeclaration;
  root: XmlElement;
}

// ─────────────────────────────────────────────────────────────────
// 选项
// ─────────────────────────────────────────────────────────────────

export interface XmlParseOptions {
  /**
   * 是否允许 `<!DOCTYPE`（默认 **false**）。
   * 关着的原因是 XXE：DTD 里的外部实体可以读本地文件、打内网。
   * 允许也**只**展开内部子集里的普通实体，`SYSTEM` / `PUBLIC` 一律抛
   * {@link MODDLE_ERROR_CODES.PARSE_EXTERNAL_ENTITY}。
   */
  allowDoctype?: boolean;
  /** 是否保留注释节点（默认 false —— 注释不进模型，留着只会让往返比对变复杂） */
  keepComments?: boolean;
}

export const XML_PARSE_OPTION_KEYS: readonly string[] = Object.freeze([
  'allowDoctype',
  'keepComments',
]);

// ─────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

function isWs(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function isNameStart(c: string | undefined): boolean {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x3a ||
    code > 0x7f
  );
}

function isNameChar(c: string | undefined): boolean {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x3a ||
    code === 0x2e ||
    code === 0x2d ||
    code > 0x7f
  );
}

/** XML 1.0 里非法的裸控制字符（`\t` `\n` `\r` 合法） */
function isIllegalChar(c: string): boolean {
  const code = c.charCodeAt(0);
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || code === 0x7f;
}

/** 由扁平偏移算行列（1-based）—— 报错信息里给人看的 */
export function lineColOf(source: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 0x0a) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

// ─────────────────────────────────────────────────────────────────
// 解析
// ─────────────────────────────────────────────────────────────────

export function parseXml(source: string, opts: XmlParseOptions = {}): XmlDocument {
  if (typeof source !== 'string') {
    throw new Error('parseXml: source must be a string');
  }
  for (const k of Object.keys(opts)) {
    if (!XML_PARSE_OPTION_KEYS.includes(k)) {
      throw unknownOptionError(k, XML_PARSE_OPTION_KEYS);
    }
  }
  const keepComments = opts.keepComments === true;
  const allowDoctype = opts.allowDoctype === true;
  const entities: Record<string, string> = { ...PREDEFINED_ENTITIES };
  const scope = new NsScope();

  let i = 0;
  if (source.charCodeAt(0) === 0xfeff) i = 1; // BOM

  const at = (from: number, to = from): Position => ({ from, to });
  const eof = (from: number, what: string): never => {
    throw parseError(MODDLE_ERROR_CODES.PARSE_UNEXPECTED_EOF, `XML 提前结束：${what}未闭合`, at(from, source.length), {
      hint: '检查是否有标签/引号未闭合',
    });
  };

  const skipWs = (): void => {
    while (isWs(source[i])) i += 1;
  };

  const startsWith = (s: string): boolean => source.startsWith(s, i);

  /** 读一个名字（元素名/属性名） */
  const readName = (): string => {
    const from = i;
    if (!isNameStart(source[i])) {
      throw parseError(
        MODDLE_ERROR_CODES.PARSE_INVALID_NAME,
        '期望一个元素/属性名',
        at(from, from + 1),
        { details: { char: source[i] ?? '' } },
      );
    }
    i += 1;
    while (isNameChar(source[i])) i += 1;
    return source.slice(from, i);
  };

  /** 展开实体引用（文本与属性值共用） */
  const decode = (raw: string, offset: number): string => {
    if (raw.indexOf('&') < 0) return raw;
    let out = '';
    let j = 0;
    while (j < raw.length) {
      const c = raw[j] as string;
      if (c !== '&') {
        out += c;
        j += 1;
        continue;
      }
      const semi = raw.indexOf(';', j);
      if (semi < 0) {
        throw parseError(
          MODDLE_ERROR_CODES.PARSE_MALFORMED,
          '实体引用缺少结束分号',
          at(offset + j, offset + raw.length),
          { hint: '写成 &amp; 这样带分号的形式' },
        );
      }
      const body = raw.slice(j + 1, semi);
      if (body.startsWith('#')) {
        const hex = body[1] === 'x' || body[1] === 'X';
        const digits = hex ? body.slice(2) : body.slice(1);
        const code = parseInt(digits, hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
          throw parseError(MODDLE_ERROR_CODES.PARSE_MALFORMED, '字符实体引用不是合法码位', at(offset + j, offset + semi + 1), {
            details: { body },
          });
        }
        out += String.fromCodePoint(code);
      } else {
        const v = entities[body];
        if (v === undefined) {
          throw parseError(
            MODDLE_ERROR_CODES.PARSE_UNDEFINED_ENTITY,
            '引用了未定义的实体',
            at(offset + j, offset + semi + 1),
            { details: { name: body }, hint: '只允许 XML 预定义实体；DTD 外部实体一律不展开' },
          );
        }
        out += v;
      }
      j = semi + 1;
    }
    return out;
  };

  const expect = (s: string, what: string): void => {
    if (!startsWith(s)) {
      throw parseError(MODDLE_ERROR_CODES.PARSE_MALFORMED, `期望 ${what}`, at(i, i + s.length), {
        details: { expected: s, got: source.slice(i, i + s.length) },
      });
    }
    i += s.length;
  };

  /** 跳过注释 / PI；`keepComments` 时返回注释节点 */
  const readMarkupOrNull = (): XmlNode | null => {
    if (startsWith('<!--')) {
      const from = i;
      const endIdx = source.indexOf('-->', i + 4);
      if (endIdx < 0) eof(from, '注释');
      const value = source.slice(i + 4, endIdx);
      i = endIdx + 3;
      return keepComments ? { kind: 'comment', value, start: from, end: i } : null;
    }
    if (startsWith('<?')) {
      const from = i;
      const endIdx = source.indexOf('?>', i + 2);
      if (endIdx < 0) eof(from, '处理指令');
      i = endIdx + 2;
      return null;
    }
    return null;
  };

  /** 读 `<!DOCTYPE …>`：默认拒绝；放行时收集内部实体、拒绝外部实体 */
  const readDoctype = (): void => {
    const from = i;
    // 找到匹配的 '>'（内部子集里可能有 '>'，故按 '[' / ']' 成对处理）
    let depth = 0;
    let j = i + 2; // 跳过 '<!'
    let subsetStart = -1;
    let subsetEnd = -1;
    while (j < source.length) {
      const c = source[j] as string;
      if (c === '[') {
        if (depth === 0) subsetStart = j;
        depth += 1;
      } else if (c === ']') {
        subsetEnd = j;
        depth -= 1;
      } else if (c === '>' && depth === 0) {
        break;
      }
      j += 1;
    }
    if (j >= source.length) eof(from, 'DOCTYPE');
    const body = source.slice(i, j + 1);
    i = j + 1;

    if (!allowDoctype) {
      throw parseError(
        MODDLE_ERROR_CODES.PARSE_DOCTYPE_FORBIDDEN,
        'XML 含 DTD，默认拒绝解析',
        at(from, i),
        { hint: 'DTD 可携带外部实体（XXE）。确需解析请显式传 allowDoctype:true —— 外部实体仍不展开' },
      );
    }
    if (/SYSTEM|PUBLIC/.test(subsetStart >= 0 ? body.slice(0, subsetStart) : body)) {
      throw parseError(
        MODDLE_ERROR_CODES.PARSE_EXTERNAL_ENTITY,
        '拒绝展开外部实体',
        at(from, i),
        { hint: '外部实体可读取本地文件/访问内网，属于 XXE 攻击面' },
      );
    }
    if (subsetStart >= 0 && subsetEnd > subsetStart) {
      const subset = source.slice(subsetStart + 1, subsetEnd);
      for (const m of subset.matchAll(/<!ENTITY\s+([^\s>]+)\s+"([^"]*)"\s*>/g)) {
        entities[m[1] as string] = decode(m[2] as string, subsetStart);
      }
    }
  };

  /** 读属性值（引号包裹，内部展开实体） */
  const readAttrValue = (): { value: string; start: number; end: number } => {
    skipWs();
    const quote = source[i];
    if (quote !== '"' && quote !== "'") {
      throw parseError(MODDLE_ERROR_CODES.PARSE_MALFORMED, '属性值必须用引号包裹', at(i, i + 1), {
        details: { got: quote ?? '' },
      });
    }
    const from = i;
    i += 1;
    const close = source.indexOf(quote as string, i);
    if (close < 0) eof(from, '属性值');
    const raw = source.slice(i, close);
    if (raw.indexOf('<') >= 0) {
      throw parseError(MODDLE_ERROR_CODES.PARSE_MALFORMED, '属性值里不得出现裸 <', at(from, close + 1));
    }
    i = close + 1;
    return { value: decode(raw, from + 1), start: from, end: i };
  };

  /** 读一个元素（含子树） */
  const readElement = (): XmlElement => {
    const start = i;
    expect('<', '<');
    const name = readName();
    const { prefix, local } = splitQName(name);
    const attrs: XmlAttr[] = [];
    const nsDecls: Record<string, string> = {};
    let selfClosing = false;

    for (;;) {
      if (i >= source.length) eof(start, `元素 <${name}>`);
      if (startsWith('/>')) {
        i += 2;
        selfClosing = true;
        break;
      }
      if (source[i] === '>') {
        i += 1;
        break;
      }
      if (!isWs(source[i])) {
        throw parseError(MODDLE_ERROR_CODES.PARSE_MALFORMED, '标签内出现意外字符', at(i, i + 1), {
          details: { got: source[i] ?? '' },
        });
      }
      skipWs();
      if (startsWith('/>') || source[i] === '>') continue;
      const aStart = i;
      const aName = readName();
      if (attrs.some((a) => a.name === aName)) {
        throw parseError(MODDLE_ERROR_CODES.PARSE_DUPLICATE_ATTR, '同一元素上出现重复属性', at(aStart, i), {
          details: { attribute: aName, element: name },
        });
      }
      skipWs();
      expect('=', `属性 ${aName} 的 '='`);
      const { value, end } = readAttrValue();
      const parts = splitQName(aName);
      if (aName === 'xmlns') nsDecls[''] = value;
      else if (parts.prefix === 'xmlns') nsDecls[parts.local] = value;
      else attrs.push({ name: aName, ...(parts.prefix ? { prefix: parts.prefix } : {}), local: parts.local, value, start: aStart, end });
    }

    scope.push(nsDecls);
    const nsInScope = scope.capture();
    let ns: string | undefined;
    if (prefix) {
      ns = scope.resolve(prefix);
      if (ns === undefined) {
        throw parseError(
          MODDLE_ERROR_CODES.PARSE_UNDECLARED_PREFIX,
          '使用了未声明的命名空间前缀',
          at(start, i),
          { details: { prefix, element: name }, hint: '补上 xmlns:' + prefix + '="…"' },
        );
      }
    } else {
      ns = scope.resolve('');
    }

    // 属性：无前缀的不属于任何命名空间；有前缀的必须能解析到 URI
    for (const a of attrs) {
      if (a.prefix) {
        const uri = scope.resolve(a.prefix);
        if (uri === undefined) {
          throw parseError(
            MODDLE_ERROR_CODES.PARSE_UNDECLARED_PREFIX,
            '属性使用了未声明的命名空间前缀',
            at(a.start, a.end),
            { details: { prefix: a.prefix, attribute: a.name } },
          );
        }
        a.ns = uri;
      }
    }

    const children: XmlNode[] = [];
    if (!selfClosing) {
      for (;;) {
        if (i >= source.length) eof(start, `元素 <${name}>`);
        if (startsWith('</')) {
          const cStart = i;
          i += 2;
          const closing = readName();
          skipWs();
          if (source[i] !== '>') {
            throw parseError(MODDLE_ERROR_CODES.PARSE_MALFORMED, '闭合标签后只能跟 >', at(i, i + 1), {
              details: { element: closing },
            });
          }
          i += 1;
          if (closing !== name) {
            throw parseError(
              MODDLE_ERROR_CODES.PARSE_MISMATCHED_TAG,
              '闭合标签与开始标签不匹配',
              at(cStart, i),
              { details: { open: name, close: closing } },
            );
          }
          break;
        }
        if (startsWith('<![CDATA[')) {
          const from = i;
          const endIdx = source.indexOf(']]>', i + 9);
          if (endIdx < 0) eof(from, 'CDATA 段');
          children.push({ kind: 'cdata', value: source.slice(i + 9, endIdx), start: from, end: endIdx + 3 });
          i = endIdx + 3;
          continue;
        }
        if (startsWith('<!--') || startsWith('<?')) {
          const node = readMarkupOrNull();
          if (node) children.push(node);
          continue;
        }
        if (source[i] === '<') {
          if (startsWith('<!DOCTYPE')) {
            readDoctype();
            continue;
          }
          children.push(readElement());
          continue;
        }
        // 文本
        const from = i;
        let to = source.indexOf('<', i);
        if (to < 0) to = source.length;
        const raw = source.slice(from, to);
        i = to;
        for (let k = 0; k < raw.length; k += 1) {
          if (isIllegalChar(raw[k] as string)) {
            throw parseError(MODDLE_ERROR_CODES.PARSE_MALFORMED, '文本含 XML 非法控制字符', at(from + k, from + k + 1), {
              details: { code: (raw[k] as string).charCodeAt(0) },
            });
          }
        }
        const value = decode(raw, from);
        // 纯缩进/换行文本不进节点树 —— 它们只是格式化，留着会让往返比对无谓地变复杂
        if (value.trim() !== '') children.push({ kind: 'text', value, start: from, end: to });
      }
    }
    scope.pop();

    return {
      kind: 'element',
      name,
      ...(prefix ? { prefix } : {}),
      local,
      ...(ns !== undefined ? { ns } : {}),
      attrs,
      nsDecls,
      nsInScope,
      children,
      selfClosing,
      start,
      end: i,
    };
  };

  // ── prolog ──
  let declaration: XmlDeclaration | undefined;
  for (;;) {
    skipWs();
    if (i >= source.length) {
      throw parseError(MODDLE_ERROR_CODES.PARSE_MALFORMED, 'XML 为空或缺少根元素', at(0, source.length));
    }
    if (startsWith('<?xml')) {
      const from = i;
      const endIdx = source.indexOf('?>', i);
      if (endIdx < 0) eof(from, 'XML 声明');
      const body = source.slice(i + 5, endIdx);
      const decl: XmlDeclaration = {};
      for (const m of body.matchAll(/([A-Za-z]+)\s*=\s*"([^"]*)"/g)) {
        const k = m[1] ?? '';
        const v = m[2] ?? '';
        if (k === 'version') decl.version = v;
        else if (k === 'encoding') decl.encoding = v;
        else if (k === 'standalone') decl.standalone = v;
      }
      declaration = decl;
      i = endIdx + 2;
      continue;
    }
    if (startsWith('<!--') || startsWith('<?')) {
      readMarkupOrNull();
      continue;
    }
    if (startsWith('<!DOCTYPE')) {
      readDoctype();
      continue;
    }
    break;
  }

  const root = readElement();

  // ── epilog：只允许空白 / 注释 / PI ──
  for (;;) {
    skipWs();
    if (i >= source.length) break;
    if (startsWith('<!--') || startsWith('<?')) {
      readMarkupOrNull();
      continue;
    }
    throw parseError(MODDLE_ERROR_CODES.PARSE_MALFORMED, '根元素之后又出现了第二个顶层元素', at(i, i + 1));
  }

  return { ...(declaration ? { declaration } : {}), root };
}

// ─────────────────────────────────────────────────────────────────
// 查询辅助
// ─────────────────────────────────────────────────────────────────

export function childElements(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.kind === 'element');
}

/** 按「URI + 本地名」取子元素 —— **按 URI 认，不认前缀**（§6.2） */
export function childByNs(el: XmlElement, ns: string | undefined, local: string): XmlElement | undefined {
  return childElements(el).find((c) => c.local === local && c.ns === ns);
}

export function childrenByNs(el: XmlElement, ns: string | undefined, local: string): XmlElement[] {
  return childElements(el).filter((c) => c.local === local && c.ns === ns);
}

/** 拼接直接文本与 CDATA（不递归进子元素） */
export function textContent(el: XmlElement): string {
  let out = '';
  for (const c of el.children) {
    if (c.kind === 'text' || c.kind === 'cdata') out += c.value;
  }
  return out;
}

export function attrOf(el: XmlElement, local: string, ns?: string): string | undefined {
  for (const a of el.attrs) {
    if (a.local !== local) continue;
    if (ns === undefined ? a.ns === undefined : a.ns === ns) return a.value;
  }
  return undefined;
}
