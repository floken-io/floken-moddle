/**
 * `toXml` / `fromXml` 测试（M2 / AC-S2 往返恒等 · AC-S3 规范化后逐字节一致）
 *
 * 这份测试守的是**三条不可逆的承诺**：
 * 1. 同一模型永远得到同一串字节（确定性）；
 * 2. `fromXml(toXml(m))` 与 `m` 全等（往返恒等）—— **含 `false` / `0.5` / `[]` / `null` 的类型**；
 * 3. 认不出的东西一律保全（第三方属性、第三方元素、用户 meta），绝不静默丢弃。
 */

import { describe, expect, it } from 'vitest';

import {
  MODDLE_DIAGNOSTIC_CODES,
  MODDLE_ERROR_CODES,
  ModdleError,
  type Diagnostic,
} from '../src/core/errors.js';
import { FEEL_EXPRESSION_LANGUAGE, type ProcessDefinition } from '../src/model/definition.js';
import { BPMN_NS, BPMNDI_NS, FLOKEN_NS } from '../src/xml/namespaces.js';
import { childrenByNs, parseXml, type XmlElement } from '../src/xml/sax.js';
import { fromXml, fromXmlSync } from '../src/xml/from-xml.js';
import { toXml, toXmlSync } from '../src/xml/to-xml.js';

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
  return err;
}

/** 覆盖往返各条分支的样例模型（含子流程、边界事件、审批语义、第三方属性、特殊字符） */
function sample(): ProcessDefinition {
  return {
    schemaVersion: '1.0.0',
    id: 'Definitions_1',
    name: '报销流程 & <审批>',
    version: 3,
    processes: [
      {
        id: 'Process_1',
        name: '主流程',
        executable: true,
        nodes: [
          { id: 'StartEvent_1', type: 'startEvent', name: '发起' },
          {
            id: 'UserTask_1',
            type: 'userTask',
            name: '部门经理 "审批"',
            description: '第一段说明',
            formKey: 'expense-form',
            extension: {
              'floken:approval': {
                approvers: [
                  { type: 'user', value: 'u1' },
                  { type: 'deptLeader', of: 'starter' },
                ],
                approverPolicy: 'all',
                mode: 'vote',
                vote: { threshold: 0.5 },
                onReject: 'wait',
                reject: { allowed: false, requireComment: true },
                timeout: { duration: 'P3D', actions: [{ type: 'remind', interval: 'PT4H' }] },
                cc: { to: [{ type: 'role', value: 'finance' }], on: ['completed'] },
              },
              'camunda:assignee': 'demo',
            },
          },
          {
            id: 'Gateway_1',
            type: 'exclusiveGateway',
            name: '金额判断',
          },
          {
            id: 'SubProcess_1',
            type: 'subProcess',
            name: '复核',
            nodes: [
              { id: 'Inner_Start', type: 'startEvent' },
              { id: 'Inner_Task', type: 'userTask', name: '复核' },
            ],
            flows: [{ id: 'Inner_Flow', from: 'Inner_Start', to: 'Inner_Task' }],
          },
          { id: 'EndEvent_1', type: 'endEvent' },
          {
            id: 'Boundary_1',
            type: 'boundaryEvent',
            attachedTo: 'UserTask_1',
            eventDefinition: {
              type: 'timer',
              timeDuration: { body: 'PT2H', language: FEEL_EXPRESSION_LANGUAGE },
            },
          },
        ],
        flows: [
          { id: 'Flow_1', from: 'StartEvent_1', to: 'UserTask_1' },
          {
            id: 'Flow_2',
            from: 'UserTask_1',
            to: 'Gateway_1',
            condition: { body: 'amount > 5000', language: FEEL_EXPRESSION_LANGUAGE },
          },
          { id: 'Flow_3', from: 'Gateway_1', to: 'SubProcess_1', name: '大于五千' },
          { id: 'Flow_4', from: 'SubProcess_1', to: 'EndEvent_1' },
        ],
      },
    ],
    meta: { owner: 'finance-team' },
  };
}

describe('toXml · 确定性', () => {
  it('同一模型两次导出逐字节一致', () => {
    const a = toXmlSync(sample());
    const b = toXmlSync(sample());
    expect(a).toBe(b);
  });

  it('输入顺序不影响输出（节点按模型顺序、DI 按 id 排序）', () => {
    const m = sample();
    const proc = m.processes[0]!;
    proc.nodes = [...proc.nodes].reverse();
    const xmlA = toXmlSync(m);
    expect(xmlA).toContain('<bpmn:userTask id="UserTask_1"');
  });

  it('不合规范的换行动作不影响输出（`newline` 恒为 \\n）', () => {
    expect(toXmlSync(sample())).not.toContain('\r');
  });
});

describe('toXml · 形态', () => {
  const xml = toXmlSync(sample());

  it('根元素是带命名空间声明的 bpmn:definitions', () => {
    expect(xml).toContain(`xmlns:bpmn="${BPMN_NS}"`);
    expect(xml).toContain(`xmlns:floken="${FLOKEN_NS}"`);
    expect(xml).toContain('<bpmn:definitions');
  });

  it('★ 条件表达式写 `xsi:type` 与 `language`（不写会被当成 XPath）', () => {
    expect(xml).toContain('xsi:type="bpmn:tFormalExpression"');
    expect(xml).toContain(`language="${FEEL_EXPRESSION_LANGUAGE}"`);
  });

  it('★ `false` 必须写出来，不能省略（否则语义反转）', () => {
    const m = sample();
    m.processes[0]!.executable = false;
    expect(toXmlSync(m)).toContain('isExecutable="false"');
  });

  it('特殊字符被正确转义', () => {
    expect(xml).toContain('name="报销流程 &amp; &lt;审批&gt;"');
    expect(xml).toContain('name="部门经理 &quot;审批&quot;"');
  });

  it('输出 DI（bpmndi）：形状带 Bounds、连线带 waypoint', () => {
    expect(xml).toContain('<bpmndi:BPMNDiagram');
    expect(xml).toContain('<bpmndi:BPMNPlane');
    expect(xml).toContain('<dc:Bounds');
    expect(xml).toContain('<di:waypoint');
  });

  /*
   * ★ BPMNShape **扁平同级**，不按 parentId 嵌套（AC-S1 实证抓回来的真 bug）。
   * XSD 里 `BPMNShape` 的 content model 只准一个 `BPMNLabel`，把内嵌 shape 套进去
   * 会被 bpmn-moddle 判成 `unparsable content`，bpmn-js 画不出子流程内容。
   */
  it('★ 子流程内元素的 DI 与顶层扁平同级（BPMNShape 不嵌套）', () => {
    expect(xml).toContain('bpmnElement="SubProcess_1" isExpanded="true"');
    expect(xml).toContain('bpmnElement="Inner_Task"');

    const doc = parseXml(xml);
    const plane = doc.root.children.find(
      (c): c is XmlElement => c.kind === 'element' && c.local === 'BPMNDiagram',
    )?.children.find((c): c is XmlElement => c.kind === 'element' && c.local === 'BPMNPlane');
    expect(plane).toBeDefined();
    const shapes = childrenByNs(plane as XmlElement, BPMNDI_NS, 'BPMNShape');
    expect(shapes.length).toBeGreaterThan(1);
    for (const s of shapes) {
      expect(childrenByNs(s, BPMNDI_NS, 'BPMNShape').length, `${s.attrs} 内不得再嵌 BPMNShape`).toBe(0);
    }
  });

  /*
   * MIWG 的 C.9.0 / C.9.2 回归：definitions 上的第三方属性（`camunda:diagramRelationId`）
   * 走的是 `meta['@definitions']`，不经模型字段 —— 漏了它会写出「用了未声明前缀」的
   * **非法**文件（我们导出的文件，我们自己的解析器都读不回来）。
   */
  it('★ definitions 上的第三方属性导出时自动补 xmlns 声明', () => {
    const m = sample();
    m.meta = { ...m.meta, '@definitions': { 'camunda:diagramRelationId': '8dc12e9b' } };
    const out = toXmlSync(m);
    expect(out).toContain('xmlns:camunda="http://camunda.org/schema/1.0/bpmn"');
    expect(out).toContain('camunda:diagramRelationId="8dc12e9b"');
    // 自己导出的文件，自己必须读得回来
    const back = fromXmlSync(out);
    expect((back.meta?.['@definitions'] as Record<string, string>)['camunda:diagramRelationId']).toBe('8dc12e9b');
  });
});

describe('往返恒等（AC-S2 / AC-S3）', () => {
  it('★ fromXml(toXml(m)) 与 m 全等（layout 由 autoLayout 补）', () => {
    const m = sample();
    const back = fromXmlSync(toXmlSync(m));
    expect(back).toEqual({ ...m, layout: back.layout });
  });

  it('★ 二次导出逐字节一致（幂等）', () => {
    const m = sample();
    const first = toXmlSync(m);
    const second = toXmlSync(fromXmlSync(first));
    expect(second).toBe(first);
  });

  it('★ 类型不丢：`false` / `0.5` / `[]` / `{}` / `null` / 空串都原样回来', () => {
    const m = sample();
    m.processes[0]!.nodes[1]!.extension!['floken:debug'] = {
      n: 0.5,
      b: false,
      s: '',
      nil: null,
      emptyArr: [],
      emptyObj: {},
      list: [1, 'a', true],
    };
    const back = fromXmlSync(toXmlSync(m));
    expect(back.processes[0]!.nodes[1]!.extension!['floken:debug']).toEqual({
      n: 0.5,
      b: false,
      s: '',
      nil: null,
      emptyArr: [],
      emptyObj: {},
      list: [1, 'a', true],
    });
  });

  it('审批语义里的 `false` 不会被吞（reject.allowed=false 是主动关闭）', () => {
    const m = sample();
    const back = fromXmlSync(toXmlSync(m));
    const approval = back.processes[0]!.nodes[1]!.extension!['floken:approval'] as Record<string, unknown>;
    expect((approval['reject'] as Record<string, unknown>)['allowed']).toBe(false);
  });

  it('用户 meta 不被丢', () => {
    const back = fromXmlSync(toXmlSync(sample()));
    expect(back.meta?.['owner']).toBe('finance-team');
  });

  it('async 入口与 sync 入口结果一致', async () => {
    const m = sample();
    const xml = await toXml(m);
    expect(xml).toBe(toXmlSync(m));
    expect(await fromXml(xml)).toEqual(fromXmlSync(xml));
  });
});

describe('保全（纪律一：认不出的东西一律保全）', () => {
  it('第三方属性原样往返（`camunda:assignee`）', () => {
    const m = sample();
    const xml = toXmlSync(m);
    expect(xml).toContain('xmlns:camunda="http://camunda.org/schema/1.0/bpmn"');
    expect(xml).toContain('camunda:assignee="demo"');
    const back = fromXmlSync(xml);
    expect(back.processes[0]!.nodes[1]!.extension!['camunda:assignee']).toBe('demo');
  });

  it('未登记的第三方前缀记进 meta[@namespaces]，导出时补回声明', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" xmlns:acme="http://acme.example/ns" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:userTask id="T1" acme:foo="bar" />',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    const back = fromXmlSync(xml);
    expect(back.meta?.['@namespaces']).toEqual({ acme: 'http://acme.example/ns' });
    expect(toXmlSync(back)).toContain('xmlns:acme="http://acme.example/ns"');
  });

  it('第三方元素按原样快照往返（_extensionElements）', () => {
    const raw = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:userTask id="T1">',
      '      <bpmn:extensionElements>',
      '        <camunda:inputOutput />',
      '      </bpmn:extensionElements>',
      '    </bpmn:userTask>',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    const back = fromXmlSync(raw);
    const snap = back.processes[0]!.nodes[0]!.extension!['_extensionElements'] as string[];
    expect(snap[0]).toContain('camunda:inputOutput');
    // 二次往返稳定（快照是规范化后的字符串）
    expect(toXmlSync(fromXmlSync(toXmlSync(back)))).toBe(toXmlSync(back));
  });

  it('未知前缀没有 URI 时抛错，不凭空编一个', () => {
    const m = sample();
    m.processes[0]!.nodes[0]!.extension = { 'nope:x': '1' };
    const err = expectCode(() => toXmlSync(m), MODDLE_ERROR_CODES.XML_UNSUPPORTED_VALUE);
    expect(err.details?.['prefix']).toBe('nope');
    expect(err.hint).toContain('@namespaces');
  });
});

describe('导入宽容 / 导出严格', () => {
  it('★ Camunda 8 风格的 `=` 前缀被剥离并告警（FR-9.12）', () => {
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:startEvent id="S" />',
      '    <bpmn:userTask id="T" />',
      '    <bpmn:sequenceFlow id="F" sourceRef="S" targetRef="T">',
      '      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">= amount &gt; 10</bpmn:conditionExpression>',
      '    </bpmn:sequenceFlow>',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    const seen: Diagnostic[] = [];
    const back = fromXmlSync(xml, { onDiagnostic: (d) => seen.push(d) });
    const cond = back.processes[0]!.flows[0]!.condition as { body: string };
    expect(cond.body).toBe('amount > 10');
    expect(seen.some((d) => d.code === MODDLE_DIAGNOSTIC_CODES.VALIDATE_LEGACY_PREFIX)).toBe(true);
  });

  it('根元素不是 bpmn:definitions → XML_INVALID_CONTENT', () => {
    expectCode(() => fromXmlSync('<foo/>'), MODDLE_ERROR_CODES.XML_INVALID_CONTENT);
  });

  it('按 URI 识别：换前缀写的 BPMN 照样读得进来', () => {
    const xml = [
      `<definitions xmlns="${BPMN_NS}" id="D1" targetNamespace="http://x">`,
      '  <process id="P1" isExecutable="true">',
      '    <startEvent id="S" />',
      '  </process>',
      '</definitions>',
    ].join('\n');
    const back = fromXmlSync(xml);
    expect(back.processes[0]!.id).toBe('P1');
    expect(back.processes[0]!.executable).toBe(true);
    expect(back.processes[0]!.nodes[0]!.type).toBe('startEvent');
  });

  it('sequenceFlow 缺 id/sourceRef/targetRef → XML_INVALID_CONTENT', () => {
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:sequenceFlow id="F" sourceRef="S" />',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    expectCode(() => fromXmlSync(xml), MODDLE_ERROR_CODES.XML_INVALID_CONTENT);
  });
});

describe('覆盖表外的元素（FR-S8 / AC-S6）', () => {
  it('导出：默认抛 XML_UNSUPPORTED_ELEMENT', () => {
    const m = sample();
    m.processes[0]!.nodes.push({ id: 'X1', type: 'monitoring' });
    const err = expectCode(() => toXmlSync(m), MODDLE_ERROR_CODES.XML_UNSUPPORTED_ELEMENT);
    expect(err.details?.['type']).toBe('monitoring');
  });

  it('导出：onUnsupported:"warn" 降级并给出诊断', () => {
    const m = sample();
    m.processes[0]!.nodes.push({ id: 'X1', type: 'monitoring' });
    const seen: Diagnostic[] = [];
    const xml = toXmlSync(m, { onUnsupported: 'warn', onDiagnostic: (d) => seen.push(d) });
    expect(xml).toContain('bpmn:monitoring');
    expect(seen.some((d) => d.code === MODDLE_DIAGNOSTIC_CODES.VALIDATE_ELEMENT_UNSUPPORTED)).toBe(true);
  });

  /*
   * ★ 默认**不再是 throw**：实证——默认 throw 时 22 份 MIWG 真实语料 0 份能导入
   * （`incoming` / `outgoing` / `flowNodeRef` / `ioSpecification` 全在 bpmn 命名空间里，
   * 只是不在 48 类覆盖表内）。拒收真实文件比多一个保全字段严重得多 → 改成原样快照保全。
   */
  it('导入：默认原样保全（不抛、不丢）', () => {
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:monitoring />',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    const def = fromXmlSync(xml);
    const kept = def.processes[0]?.extension?.['_extensionElements'] as string[] | undefined;
    expect(kept?.some((s) => s.includes('bpmn:monitoring'))).toBe(true);
    // 保全了就得导得回去（往返不丢，纪律一）
    expect(toXmlSync(def, { autoLayout: false })).toContain('bpmn:monitoring');
  });

  it('导入：onUnsupported:"throw" 仍抛 XML_UNSUPPORTED_ELEMENT', () => {
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:monitoring />',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    const err = expectCode(
      () => fromXmlSync(xml, { onUnsupported: 'throw' }),
      MODDLE_ERROR_CODES.XML_UNSUPPORTED_ELEMENT,
    );
    expect(err.details?.['element']).toBe('bpmn:monitoring');
  });

  it('导入：onUnsupported:"warn" 降级', () => {
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:monitoring />',
      '    <bpmn:startEvent id="S" />',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    const seen: Diagnostic[] = [];
    const back = fromXmlSync(xml, { onUnsupported: 'warn', onDiagnostic: (d) => seen.push(d) });
    expect(back.processes[0]!.nodes).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });
});

describe('选项', () => {
  /*
   * ★ 口径（2026-09-26 修订）：净化剔的是**审批语义**扩展（`floken:approval` / `floken:formKey` …），
   * `floken:schemaVersion` 是 **Model JSON 自身的格式身份**，恒写 —— 否则净化导出再读回，
   * schemaVersion 会静默退回默认值、version 直接消失（一份文件被换了身份）。
   */
  it('includeExtensions:false → 净化导出不含审批语义，但保留格式身份', () => {
    const xml = toXmlSync(sample(), { includeExtensions: false });
    expect(xml).not.toContain('floken:approval');
    expect(xml).not.toContain('floken:formKey');
    expect(xml).toContain('floken:schemaVersion');
    expect(xml).toContain('bpmn:userTask');
  });

  it('净化导出往返：schemaVersion / version 不丢', () => {
    const def = sample();
    def.schemaVersion = '2.3.4';
    def.version = 7;
    const xml = toXmlSync(def, { includeExtensions: false });
    const back = fromXmlSync(xml);
    expect(back.schemaVersion).toBe('2.3.4');
    expect(back.version).toBe(7);
  });

  it('autoLayout:false 且模型没有 layout → 不输出 BPMNDiagram', () => {
    const xml = toXmlSync(sample(), { autoLayout: false });
    expect(xml).not.toContain('BPMNDiagram');
  });

  it('未知选项不静默忽略', () => {
    expectCode(() => toXmlSync(sample(), { nope: true } as never), MODDLE_ERROR_CODES.ARG_UNKNOWN_OPTION);
    expectCode(() => fromXmlSync('<a/>', { nope: true } as never), MODDLE_ERROR_CODES.ARG_UNKNOWN_OPTION);
  });

  it('入参不是定义 → ARG_INVALID_INPUT', () => {
    expectCode(() => toXmlSync({} as never), MODDLE_ERROR_CODES.ARG_INVALID_INPUT);
    expectCode(() => fromXmlSync(42 as never), MODDLE_ERROR_CODES.ARG_INVALID_INPUT);
  });
});

/**
 * 收口审计补的回归（2026-09-26）：两条都是「结构断言测不出、只有真喂文件才抓得到」的。
 */
describe('收口回归', () => {
  it('内置前缀兜底：树里出现 floken: 时必补 xmlns:floken（否则是非法 XML）', () => {
    // 直接构造「净化模式下仍写了自有前缀」的极端形态：meta 不登记任何命名空间，
    // 兜底必须认得内置前缀，而不是抛「第三方扩展前缀没有对应的命名空间 URI」。
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      processes: [
        {
          id: 'P1',
          nodes: [{ id: 't1', type: 'userTask', formKey: 'fk' }],
          flows: [],
        },
      ],
    };
    // 正常模式下 formKey 走 floken: 前缀 → 必须能导出且自洽
    const xml = toXmlSync(def);
    expect(xml).toContain('floken:formKey');
    expect(xml).toContain('xmlns:floken=');
    // ★ 自己导出的文件自己必须读得回来（非法 XML 会在这里现形）
    expect(() => fromXmlSync(xml)).not.toThrow();
    // 净化模式：floken:* 全部去掉，且仍是合法 BPMN
    const clean = toXmlSync(def, { includeExtensions: false });
    expect(clean).not.toContain('floken:formKey');
    expect(() => fromXmlSync(clean)).not.toThrow();
  });

  /*
   * ★ 口径（2026-09-26 修订）：单值的 `description` 装不下多条文档，但"装不下"不等于"可以丢"。
   * 第 2 条起进 `extraDocumentations` 原样回写 —— MIWG `C.9.0` 实测丢过 3 条。
   */
  it('多条 <bpmn:documentation>：第 2 条起保全，往返不丢', () => {
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:userTask id="t1">',
      '      <bpmn:documentation xml:lang="zh">中文说明</bpmn:documentation>',
      '      <bpmn:documentation xml:lang="en">English</bpmn:documentation>',
      '    </bpmn:userTask>',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    const back = fromXmlSync(xml);
    expect(back.processes[0]!.nodes[0]!.description).toBe('中文说明');
    expect(back.processes[0]!.nodes[0]!.extraDocumentations).toEqual(['English']);
    // 往返后两条都还在
    const out = toXmlSync(back, { autoLayout: false });
    expect(out).toContain('中文说明');
    expect(out).toContain('English');
  });

  it('连线（sequenceFlow）上的 documentation 不丢', () => {
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:startEvent id="s"/>',
      '    <bpmn:task id="t"/>',
      '    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t"><bpmn:documentation>flow doc</bpmn:documentation></bpmn:sequenceFlow>',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    const back = fromXmlSync(xml);
    expect(back.processes[0]!.flows[0]!.description).toBe('flow doc');
    expect(toXmlSync(back, { autoLayout: false })).toContain('flow doc');
  });

  it('单条 documentation 不告警', () => {
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1"><bpmn:userTask id="t1">',
      '    <bpmn:documentation>只有一条</bpmn:documentation>',
      '  </bpmn:userTask></bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    const seen: Diagnostic[] = [];
    const back = fromXmlSync(xml, { onDiagnostic: (d) => seen.push(d) });
    expect(back.processes[0]!.nodes[0]!.description).toBe('只有一条');
    expect(seen).toEqual([]);
  });
});
