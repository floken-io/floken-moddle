/**
 * 自研 SAX 解析器测试（M2 / Q38：不引第三方 XML 库）
 *
 * 重点不是「能解析」，而是**脏文件不静默**与**命名空间按 URI 认**：
 * 前者决定错误信息有没有 `position`，后者决定历史文件里的旧前缀能不能读进来。
 */

import { describe, expect, it } from 'vitest';

import {
  MODDLE_ERROR_CODES,
  ModdleError,
  type ModdleParseError,
} from '../src/core/errors.js';
import { XML_NS } from '../src/xml/namespaces.js';
import {
  attrOf,
  childByNs,
  childElements,
  lineColOf,
  parseXml,
  textContent,
  type XmlElement,
} from '../src/xml/sax.js';

/** 捕获抛出的错误并断言它的码 —— 顺带校验「是 floken 的结构化错误」 */
function expectCode(fn: () => unknown, code: string): ModdleError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `期望抛出 ${code}`).toBeInstanceOf(ModdleError);
  const err = caught as ModdleError;
  expect(err.code).toBe(code);
  expect(err.floken).toBe(true);
  expect(err.pkg).toBe('moddle');
  return err;
}

describe('parseXml · 基本形态', () => {
  it('解析元素 / 属性 / 文本 / 自闭合', () => {
    const doc = parseXml('<r a="1" b=\'2\'><c>hi</c><d /></r>');
    expect(doc.root.local).toBe('r');
    expect(doc.root.selfClosing).toBe(false);
    const c = childElements(doc.root)[0] as XmlElement;
    expect(c.local).toBe('c');
    expect(textContent(c)).toBe('hi');
    const d = childElements(doc.root)[1] as XmlElement;
    expect(d.local).toBe('d');
    expect(d.selfClosing).toBe(true);
    expect(attrOf(doc.root, 'a')).toBe('1');
    expect(attrOf(doc.root, 'b')).toBe('2');
  });

  it('XML 声明单独收集，不进节点树', () => {
    const doc = parseXml('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><r/>');
    expect(doc.declaration).toEqual({ version: '1.0', encoding: 'UTF-8', standalone: 'yes' });
    expect(doc.root.local).toBe('r');
  });

  it('吃掉 BOM，且不影响偏移量语义', () => {
    const doc = parseXml('\uFEFF<r/>');
    expect(doc.root.local).toBe('r');
  });

  it('prolog / epilog 里的注释与 PI 被跳过', () => {
    const doc = parseXml('<!-- lead --><?pi data?><r/><!-- tail --><?pi?>');
    expect(doc.root.local).toBe('r');
  });

  it('纯缩进的空白文本不进节点树', () => {
    const doc = parseXml('<r>\n  <a>\n    <b>x</b>\n  </a>\n</r>');
    const a = childElements(doc.root)[0] as XmlElement;
    expect(childElements(a)).toHaveLength(1);
    expect(childElements(doc.root)).toHaveLength(1);
  });
});

describe('parseXml · 命名空间（按 URI 认，不认前缀）', () => {
  it('默认命名空间作用于元素、不作用于属性', () => {
    const doc = parseXml('<r xmlns="urn:d"><c k="v"/></r>');
    expect(doc.root.ns).toBe('urn:d');
    const c = childElements(doc.root)[0] as XmlElement;
    expect(c.ns).toBe('urn:d');
    // W3C Namespaces §6.2：无前缀的属性不属于任何命名空间
    expect(attrOf(c, 'k')).toBe('v');
    const attr = c.attrs[0];
    expect(attr?.ns).toBeUndefined();
  });

  it('同一 URI 换前缀照样认得', () => {
    const a = parseXml('<bpmn:definitions xmlns:bpmn="urn:x"/>');
    const b = parseXml('<definitions xmlns="urn:x"/>');
    expect(a.root.ns).toBe(b.root.ns);
    expect(a.root.local).toBe(b.root.local);
  });

  it('前缀绑定是栈式的：子元素覆盖、出栈后恢复', () => {
    const doc = parseXml('<r xmlns:p="urn:1"><a xmlns:p="urn:2"><p:b/></a><p:c/></r>');
    const [a, c] = childElements(doc.root) as [XmlElement, XmlElement];
    const inner = childElements(a)[0] as XmlElement;
    expect(inner.ns).toBe('urn:2');
    expect(c.ns).toBe('urn:1');
  });

  it('xmlns 声明不进 attrs，单独落在 nsDecls', () => {
    const doc = parseXml('<r xmlns="urn:d" xmlns:p="urn:p" id="1"/>');
    expect(doc.root.nsDecls).toEqual({ '': 'urn:d', p: 'urn:p' });
    expect(doc.root.attrs.map((a) => a.name)).toEqual(['id']);
  });
});

describe('parseXml · CDATA / 实体 / 注释', () => {
  it('CDATA 里的尖括号与 & 原样保留', () => {
    const doc = parseXml('<a><![CDATA[<b> & ]]></a>');
    expect(textContent(doc.root)).toBe('<b> & ');
  });

  it('CDATA 与文本拼接成一个值', () => {
    const doc = parseXml('<a>x<![CDATA[y]]>z</a>');
    expect(textContent(doc.root)).toBe('xyz');
  });

  it('预定义实体与字符引用都展开', () => {
    const doc = parseXml('<a>&lt;&amp;&gt;&quot;&apos;&#65;&#x42;</a>');
    expect(textContent(doc.root)).toBe('<&>"\'AB');
  });

  it('属性值里的实体同样展开', () => {
    const doc = parseXml('<a k="&lt;&amp;&#10;"/>');
    expect(attrOf(doc.root, 'k')).toBe('<&\n');
  });

  it('注释默认丢弃，keepComments 时保留', () => {
    const src = '<r><!-- note --><a/></r>';
    expect(parseXml(src).root.children).toHaveLength(1);
    const kept = parseXml(src, { keepComments: true });
    expect(kept.root.children.filter((c) => c.kind === 'comment')).toHaveLength(1);
  });
});

describe('parseXml · 定位', () => {
  it('每个元素带扁平偏移', () => {
    const src = '<r><a/></r>';
    const doc = parseXml(src);
    expect(doc.root.start).toBe(0);
    expect(doc.root.end).toBe(src.length);
    const a = childElements(doc.root)[0] as XmlElement;
    expect(src.slice(a.start, a.end)).toBe('<a/>');
  });

  it('lineColOf 给出 1-based 行列', () => {
    const src = '<r>\n  <a/>\n</r>';
    const doc = parseXml(src);
    const a = childElements(doc.root)[0] as XmlElement;
    expect(lineColOf(src, a.start)).toEqual({ line: 2, col: 3 });
  });

  it('解析错误必带 position', () => {
    const err = expectCode(() => parseXml('<a></b>'), MODDLE_ERROR_CODES.PARSE_MISMATCHED_TAG) as ModdleParseError;
    expect(err.position).toBeDefined();
    expect(typeof err.position?.from).toBe('number');
    expect(err.name).toBe('ModdleParseError');
  });
});

describe('parseXml · 脏文件一律抛（不静默容错）', () => {
  it('标签不匹配', () => {
    expectCode(() => parseXml('<a></b>'), MODDLE_ERROR_CODES.PARSE_MISMATCHED_TAG);
  });

  it('重复属性', () => {
    expectCode(() => parseXml('<a x="1" x="2"/>'), MODDLE_ERROR_CODES.PARSE_DUPLICATE_ATTR);
  });

  it('未声明前缀（元素）', () => {
    expectCode(() => parseXml('<foo:a/>'), MODDLE_ERROR_CODES.PARSE_UNDECLARED_PREFIX);
  });

  it('未声明前缀（属性）', () => {
    expectCode(() => parseXml('<a xmlns="urn:d" foo:k="v"/>'), MODDLE_ERROR_CODES.PARSE_UNDECLARED_PREFIX);
  });

  it('提前结束（标签未闭合）', () => {
    expectCode(() => parseXml('<a>'), MODDLE_ERROR_CODES.PARSE_UNEXPECTED_EOF);
  });

  it('提前结束（CDATA 未收尾）', () => {
    expectCode(() => parseXml('<a><![CDATA[x'), MODDLE_ERROR_CODES.PARSE_UNEXPECTED_EOF);
  });

  it('空文档', () => {
    expectCode(() => parseXml(''), MODDLE_ERROR_CODES.PARSE_MALFORMED);
  });

  it('第二个顶层元素', () => {
    expectCode(() => parseXml('<a/><b/>'), MODDLE_ERROR_CODES.PARSE_MALFORMED);
  });

  it('文本含非法控制字符', () => {
    expectCode(() => parseXml('<a>\u0001</a>'), MODDLE_ERROR_CODES.PARSE_MALFORMED);
  });

  it('未定义实体', () => {
    expectCode(() => parseXml('<a>&foo;</a>'), MODDLE_ERROR_CODES.PARSE_UNDEFINED_ENTITY);
  });

  it('实体缺分号', () => {
    expectCode(() => parseXml('<a>&amp</a>'), MODDLE_ERROR_CODES.PARSE_MALFORMED);
  });

  it('未知选项不静默忽略', () => {
    const err = expectCode(() => parseXml('<a/>', { nope: true } as never), MODDLE_ERROR_CODES.ARG_UNKNOWN_OPTION);
    expect(err.details?.['key']).toBe('nope');
  });
});

describe('parseXml · XXE 防线', () => {
  it('★ 默认拒绝 DOCTYPE', () => {
    expectCode(
      () => parseXml('<!DOCTYPE r [<!ENTITY a "b">]><r>&a;</r>'),
      MODDLE_ERROR_CODES.PARSE_DOCTYPE_FORBIDDEN,
    );
  });

  it('★ 显式放行也拒绝外部实体（SYSTEM）', () => {
    expectCode(
      () => parseXml('<!DOCTYPE r SYSTEM "file:///etc/passwd"><r/>', { allowDoctype: true }),
      MODDLE_ERROR_CODES.PARSE_EXTERNAL_ENTITY,
    );
  });

  it('★ 显式放行也拒绝外部实体（PUBLIC）', () => {
    expectCode(
      () => parseXml('<!DOCTYPE r PUBLIC "-//x//y" "http://evil/x.dtd"><r/>', { allowDoctype: true }),
      MODDLE_ERROR_CODES.PARSE_EXTERNAL_ENTITY,
    );
  });

  it('放行时展开内部子集的普通实体', () => {
    const doc = parseXml('<!DOCTYPE r [<!ENTITY a "hello">]><r>&a;</r>', { allowDoctype: true });
    expect(textContent(doc.root)).toBe('hello');
  });

  it('内部子集里的实体在属性值里也生效', () => {
    const doc = parseXml('<!DOCTYPE r [<!ENTITY v "42">]><r k="&v;"/>', { allowDoctype: true });
    expect(attrOf(doc.root, 'k')).toBe('42');
  });
});

describe('查询辅助', () => {
  it('childByNs 按 URI + 本地名查找', () => {
    const doc = parseXml('<r xmlns="urn:d" xmlns:o="urn:o"><o:x/><y/></r>');
    expect(childByNs(doc.root, 'urn:o', 'x')?.local).toBe('x');
    expect(childByNs(doc.root, 'urn:d', 'y')?.local).toBe('y');
    expect(childByNs(doc.root, 'urn:o', 'y')).toBeUndefined();
  });

  it('attrOf 区分「无命名空间」与「某命名空间」', () => {
    const doc = parseXml('<r xmlns="urn:d" xmlns:f="urn:f" k="a" f:k="b"/>');
    expect(attrOf(doc.root, 'k')).toBe('a');
    expect(attrOf(doc.root, 'k', 'urn:f')).toBe('b');
    expect(attrOf(doc.root, 'k', 'urn:d')).toBeUndefined();
  });

  /*
   * ★ `xml:` 是 XML 规范**内置**前缀（W3C Namespaces §3）：不需要、也不该显式声明。
   * 缺这条，真实文件里一个 `xml:lang` 就能让整份文件解析失败（MIWG C.10.0 / C.8.x）。
   */
  it('★ `xml:` 前缀内置，不声明也能用（且不可被覆盖）', () => {
    const doc = parseXml('<r xmlns="urn:d" xml:lang="zh-CN"/>');
    expect(attrOf(doc.root, 'lang', XML_NS)).toBe('zh-CN');
    // 即便有人显式把它绑到别的 URI，内置的 'xml' 也不该被改
    const weird = parseXml('<r xmlns:xml="urn:hack" xml:lang="en"/>');
    expect(attrOf(weird.root, 'lang', XML_NS)).toBe('en');
  });
});
