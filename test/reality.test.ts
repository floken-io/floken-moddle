/**
 * 真实语料实证（2026-09-26 第二轮审计固化）
 *
 * ★ 为什么必须有这一组：**241 条单元测试 + 十道 verify 门禁一条都没拦住**下面这些 bug，
 * 因为它们测的都是"我们自己的往返自洽"，而真实文件是别人写的。
 *
 * 本轮它拦住的问题（每一条都是实测抓到、读代码读不出来的）：
 * 1. `definitions` 下多个 `<collaboration>` 只留 1 个 —— MIWG `C.4.0` 丢 3 个池；
 * 2. `<laneSet>` 没有 `id`（XSD optional）被判 error —— `C.10.0` 5 条；
 * 3. `messageFlow` 端点可指向 FlowNode（不只 participant）—— `A.4.0` 26 条误报；
 * 4. 收集引用目标 id 时**没递归进子流程** —— 嵌套元素被判"不存在"；
 * 5. `sequenceFlow` 上的 `<bpmn:documentation>` 没有落点 —— `C.9.0` 丢 3 条；
 * 6. 导入后 `validateDefinition` 在 22 份合法语料上产出 **464 条诊断**（含 10 份 error）。
 *
 * 语料不在（未跑 `npm run fetch:miwg`）时**跳过**，不进依赖链、不影响发布。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fromXmlSync, toXmlSync, validateDefinition, type ProcessDefinition } from '../src/index.js';

const MIWG_DIR = join(import.meta.dirname ?? '.', '../../../.workbuddy/miwg');
const HAS_CORPUS = existsSync(MIWG_DIR);
const CORPUS = HAS_CORPUS ? readdirSync(MIWG_DIR).filter((f) => f.endsWith('.bpmn')).sort() : [];

/** 命名空间前缀任意（`bpmn:` / `semantic:` / 默认无前缀都要认） */
const P = '(?:[A-Za-z_][\\w.-]*:)?';
const countOf = (xml: string, tag: string): number =>
  (xml.match(new RegExp(`<${P}${tag}[\\s/>]`, 'g')) ?? []).length;

const TAGS = [
  'startEvent', 'endEvent', 'intermediateThrowEvent', 'intermediateCatchEvent', 'boundaryEvent',
  'task', 'userTask', 'serviceTask', 'scriptTask', 'sendTask', 'receiveTask', 'manualTask',
  'businessRuleTask', 'callActivity', 'subProcess', 'exclusiveGateway', 'inclusiveGateway',
  'parallelGateway', 'complexGateway', 'eventBasedGateway',
] as const;

function census(xml: string): Record<string, number> {
  const nodes = TAGS.reduce((a, t) => a + countOf(xml, t), 0);
  return {
    nodes,
    flows: countOf(xml, 'sequenceFlow'),
    evDefs: (xml.match(new RegExp(`<${P}\\w*EventDefinition[\\s/>]`, 'g')) ?? []).length,
    lanes: countOf(xml, 'lane'),
    participants: countOf(xml, 'participant'),
    msgFlows: countOf(xml, 'messageFlow'),
    docs: countOf(xml, 'documentation'),
    collaborations: countOf(xml, 'collaboration'),
  };
}

describe.skipIf(!HAS_CORPUS)('MIWG 真实语料：信息守恒', () => {
  it('语料存在且不少于 20 份', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(20);
  });

  for (const f of CORPUS) {
    it(`${f} 往返后元素计数不减少`, () => {
      const src = readFileSync(join(MIWG_DIR, f), 'utf8');
      const before = census(src);
      // 一次往返（不做 autoLayout：坐标是输入的，不该被重算干扰守恒判定）
      const after = census(toXmlSync(fromXmlSync(src), { declaration: false, autoLayout: false }));
      for (const k of Object.keys(before)) {
        expect(after[k], `${f} 的 ${k}`).toBe(before[k]);
      }
    });
  }

  it('往返幂等：XML → JSON → XML → JSON → XML 稳定', () => {
    for (const f of CORPUS.slice(0, 6)) {
      const src = readFileSync(join(MIWG_DIR, f), 'utf8');
      const x1 = toXmlSync(fromXmlSync(src), { declaration: false, autoLayout: false });
      const x2 = toXmlSync(fromXmlSync(x1), { declaration: false, autoLayout: false });
      expect(x2, f).toBe(x1);
    }
  });
});

describe.skipIf(!HAS_CORPUS)('MIWG 真实语料：导入后可校验', () => {
  /**
   * ★ 这条是"导入宽容化"的另一半：导入不抛错只是及格线，
   * 导入完再用自己的校验器跑一遍，**一份合法文件都不该被判 error**。
   * 曾经 22 份里 10 份报 error、合计 464 条诊断。
   */
  it('22 份语料导入后 error 级诊断为 0', () => {
    const bad: string[] = [];
    for (const f of CORPUS) {
      const def: ProcessDefinition = fromXmlSync(readFileSync(join(MIWG_DIR, f), 'utf8'));
      const errs = validateDefinition(def).filter((d) => d.severity === 'error');
      if (errs.length) bad.push(`${f}: ${errs.length} 条，如 ${errs[0]?.message}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('多个 collaboration（XSD maxOccurs=unbounded）', () => {
  const xml = [
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D1" targetNamespace="http://x">',
    '  <bpmn:collaboration id="C1"><bpmn:participant id="P1" processRef="PR1"/></bpmn:collaboration>',
    '  <bpmn:collaboration id="C2"><bpmn:participant id="P2" processRef="PR2"/></bpmn:collaboration>',
    '  <bpmn:collaboration id="C3"><bpmn:participant id="P3"/></bpmn:collaboration>',
    '  <bpmn:process id="PR1"><bpmn:task id="t1"/></bpmn:process>',
    '</bpmn:definitions>',
  ].join('\n');

  it('全部进模型，不只剩第一个', () => {
    const def = fromXmlSync(xml);
    expect(def.collaborations?.map((c) => c.id)).toEqual(['C1', 'C2', 'C3']);
    expect(def.collaborations?.flatMap((c) => c.participants.map((p) => p.id))).toEqual(['P1', 'P2', 'P3']);
  });

  it('往返不丢池', () => {
    const out = toXmlSync(fromXmlSync(xml), { declaration: false, autoLayout: false });
    expect((out.match(/<bpmn:collaboration/g) ?? []).length).toBe(3);
    expect((out.match(/<bpmn:participant/g) ?? []).length).toBe(3);
  });
});

describe('laneSet 的 id 是可选的（XSD optional）', () => {
  const xml = [
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D1" targetNamespace="http://x">',
    '  <bpmn:process id="P1">',
    '    <bpmn:laneSet><bpmn:lane id="L1"><bpmn:flowNodeRef>t1</bpmn:flowNodeRef></bpmn:lane></bpmn:laneSet>',
    '    <bpmn:task id="t1"/>',
    '  </bpmn:process>',
    '</bpmn:definitions>',
  ].join('\n');

  it('无 id 的 laneSet 不产生 error 诊断', () => {
    const def = fromXmlSync(xml);
    expect(def.processes[0]!.laneSets?.[0]!.id).toBeUndefined();
    expect(validateDefinition(def).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('导出不写空 id', () => {
    const out = toXmlSync(fromXmlSync(xml), { declaration: false, autoLayout: false });
    expect(out).not.toContain('laneSet id=""');
    expect(out).toContain('<bpmn:laneSet>');
  });
});

describe('导入字节流：按 XML 声明解码', () => {
  it('Buffer + encoding="ISO-8859-1" 不再乱码', () => {
    const xml =
      '<?xml version="1.0" encoding="ISO-8859-1"?>' +
      '<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D1">' +
      '<process id="P1"><task id="t" name="café"/></process></definitions>';
    const bytes = new TextEncoder().encode(xml); // 先用 utf8 造字节
    const latin1 = Buffer.from(xml, 'latin1');
    expect(fromXmlSync(latin1).processes[0]!.nodes[0]!.name).toBe('café');
    // 同一份内容按 UTF-8 声明时应解出 utf8 语义
    const utf8Xml = xml.replace('ISO-8859-1', 'UTF-8');
    expect(fromXmlSync(Buffer.from(utf8Xml, 'utf8')).processes[0]!.nodes[0]!.name).toBe('café');
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('UTF-8 BOM 可识别', () => {
    const body =
      '<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D1">' +
      '<process id="P1"><task id="t" name="中文"/></process></definitions>';
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
    expect(fromXmlSync(buf).processes[0]!.nodes[0]!.name).toBe('中文');
  });

  it('入参既不是 string 也不是 Uint8Array → ARG_INVALID_INPUT', () => {
    expect(() => fromXmlSync(42 as never)).toThrow(/xml must be/);
  });
});

describe('导出的悬空坐标要说出来', () => {
  it('shape 指向模型里没有的元素 → warn 诊断，不静默丢', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      processes: [{ id: 'P1', nodes: [{ id: 't1', type: 'task' }], flows: [] }],
      layout: {
        planes: [{
          id: 'PL', elementId: 'P1',
          shapes: { t1: { x: 0, y: 0, width: 100, height: 80 }, GHOST: { x: 0, y: 0, width: 10, height: 10 } },
          edges: {},
        }],
      },
    };
    const seen: string[] = [];
    const out = toXmlSync(def, { declaration: false, onDiagnostic: (d) => seen.push(d.code) });
    expect(seen).toContain('MODDLE_VALIDATE_DANGLING_REF');
    expect(out).not.toContain('GHOST');
  });
});

describe('textAnnotation 的正文', () => {
  it('<bpmn:text> 作为规范子元素保回，不进 extensionElements', () => {
    const xml =
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D1">' +
      '<bpmn:process id="P1"><bpmn:textAnnotation id="ta1"><bpmn:text>note</bpmn:text></bpmn:textAnnotation></bpmn:process>' +
      '</bpmn:definitions>';
    const def = fromXmlSync(xml);
    expect(def.processes[0]!.nodes[0]!.text).toBe('note');
    const out = toXmlSync(def, { declaration: false, autoLayout: false });
    expect(out).toContain('<bpmn:text>note</bpmn:text>');
    expect(out).not.toContain('extensionElements');
  });
});
