/**
 * 包级冒烟（§7 对外 API 清单 + AC-M9「包内无 XML」）
 *
 * ★ AC-M9 是本轮重做的**门禁**：包里不许再出现 `toXml` / `fromXml` / XML 解析器。
 * 它不是"少了个功能"，而是**目标变更**（Q48）—— 有了这道断言，
 * 将来有人又把 XML 加回来会被立刻拦下。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as m from '../src/index';
import { PACKAGE } from '../src/index';

const srcRoot = join(import.meta.dirname ?? '.', '..', 'src');

/** 递归列出所有源码文件（相对于 srcRoot 的路径） */
function allSourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) allSourceFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p.slice(srcRoot.length + 1));
  }
  return out;
}

describe('@floken-io/moddle smoke', () => {
  it('exposes package name', () => {
    expect(PACKAGE).toBe('@floken-io/moddle');
  });

  it('★ AC-M9：不导出 toXml / fromXml（本包是 JSON-only）', () => {
    const keys = Object.keys(m);
    for (const forbidden of ['toXmlSync', 'fromXmlSync', 'toXml', 'fromXml']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('★ AC-M9：不导出 BPMN 规范类型表 / 覆盖表（随 XML 一起删除）', () => {
    const keys = Object.keys(m);
    for (const forbidden of ['BPMN_TYPES', 'DI_TYPES', 'ENUMERATIONS', 'getSpec', 'COVERAGE_STATS', 'COVERED_ELEMENT_NAMES']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('★ AC-M9：源码里没有 XML 解析器 / 命名空间登记残留', () => {
    const files = allSourceFiles(srcRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      const src = readFileSync(join(srcRoot, rel), 'utf8');
      for (const needle of ['xmlns', 'META_NAMESPACES_KEY', 'SAX', 'DOMParser']) {
        expect(src.includes(needle), `${rel} 含 ${needle}`).toBe(false);
      }
    }
  });

  it('★ AC-M9：抛出码里没有 MODDLE_XML_* / MODDLE_PARSE_*（XML 专属码已删）', () => {
    const codes = Object.values(m.MODDLE_ERROR_CODES) as string[];
    for (const c of codes) {
      expect(c.startsWith('MODDLE_XML_') || c.startsWith('MODDLE_PARSE_'), c).toBe(false);
    }
  });

  it('★ 导出白名单：NODE_TYPES 21 / EXECUTABLE 17 / UNIMPLEMENTED 4', () => {
    expect(m.NODE_TYPES.length).toBe(21);
    expect(m.EXECUTABLE_NODE_TYPES.length).toBe(17);
    expect(m.UNIMPLEMENTED_NODE_TYPES.length).toBe(4);
  });

  it('★ 导出审批语义与校验入口（引擎与设计器都靠这几个）', () => {
    for (const fn of ['normalizeApproval', 'requiredVotes', 'shouldTerminate', 'validateDefinition', 'assertValidDefinition', 'autoLayout']) {
      expect(typeof (m as Record<string, unknown>)[fn], fn).toBe('function');
    }
  });

  it('MODEL_SCHEMA_VERSION 是 2.0.0', () => {
    expect(m.MODEL_SCHEMA_VERSION).toBe('2.0.0');
  });
});
