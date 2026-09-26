/**
 * 互操作实证（2026-09-26）与 §6.6 定案补的回归。
 *
 * 这几条**只有把文件交给别人的解析器、把别人的文件喂给自己**才暴露得出来：
 * 改之前结构断言全绿、199 个测试全绿，它们照样挂。
 *
 * 真机实证脚本见 `tooling/interop.mjs`（挂 verify 的 `check:interop`）：
 * A ours→bpmn-moddle / B bpmn-moddle→ours / C MIWG 语料闭环 / D Camunda 扩展保全。
 * 本文件是它的**离线镜像**：不依赖沙箱，把抓到的四个 bug 钉死在单测里。
 */

import { describe, expect, it } from 'vitest';

import { MODDLE_DIAGNOSTIC_CODES } from '../src/core/errors.js';
import { validateDefinition, type ProcessDefinition } from '../src/model/definition.js';
import { BPMN_NS } from '../src/xml/namespaces.js';
import { fromXmlSync } from '../src/xml/from-xml.js';
import { toXmlSync } from '../src/xml/to-xml.js';

const def = (o: Partial<ProcessDefinition>): ProcessDefinition =>
  ({ schemaVersion: '1.0.0', id: 'D1', processes: [{ id: 'P1', nodes: [], flows: [] }], ...o }) as ProcessDefinition;

const nodesOf = (xml: string): Map<string, Record<string, unknown>> => {
  const back = fromXmlSync(xml, { onUnsupported: 'warn' });
  return new Map(back.processes.flatMap((p) => p.nodes).map((n) => [n.id, n as Record<string, unknown>]));
};

describe('互操作回归', () => {
  it('DI 的 id 不撞已有 id（撞了 = duplicate ID 的非法 XML）', () => {
    /*
     * 故意撞车的形态：有个节点 id 就叫 `t1_di`，而 `t1` 的 DI 默认会生成 `t1_di`。
     * 旧实现直接产出两个 `id="t1_di"` —— bpmn-moddle 报 `unparsable content`，
     * bpmn-js 会丢图形（互操作实证 C 方向一次抓出 669 条）。
     */
    const d = def({
      processes: [
        {
          id: 'P1',
          nodes: [
            { id: 't1', type: 'userTask' },
            { id: 't1_di', type: 'userTask' },
          ],
          flows: [],
        },
      ],
    });
    const xml = toXmlSync(d);
    const ids = [...xml.matchAll(/id="([^"]+)"/g)].map((m) => m[1] as string);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dup).toEqual([]);
    expect(xml).toContain('id="t1_di"');
    expect(xml).toContain('id="t1_di_2"');
    // 自己产出的文件必须自己读得回来，且二次导出幂等
    expect(toXmlSync(fromXmlSync(xml, { onUnsupported: 'warn' }))).toBe(xml);
  });

  it('悬空 DI 引用不落盘（语义元素没被收下，它的 shape 也该走）', () => {
    const d = def({
      processes: [{ id: 'P1', nodes: [{ id: 't1', type: 'userTask' }], flows: [] }],
      layout: {
        planes: [
          {
            id: 'plane1',
            elementId: 'P1',
            shapes: {
              t1: { x: 0, y: 0, width: 100, height: 80 },
              ghost: { x: 200, y: 0, width: 100, height: 80 }, // 语义层没有它
            },
            edges: { f_gone: { waypoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } },
          },
        ],
      },
    });
    const xml = toXmlSync(d);
    expect(xml).toContain('bpmnElement="t1"');
    expect(xml).not.toContain('bpmnElement="ghost"');
    expect(xml).not.toContain('bpmnElement="f_gone"');
  });

  it('导入时记住原 DI id（默认形态不记，保持 JSON 干净）', () => {
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1"><bpmn:userTask id="t1" /></bpmn:process>',
      '  <bpmndi:BPMNDiagram xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"',
      '    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="dia">',
      '    <bpmndi:BPMNPlane id="plane" bpmnElement="P1">',
      '      <bpmndi:BPMNShape id="shape-xyz" bpmnElement="t1">',
      '        <dc:Bounds x="1" y="2" width="3" height="4" />',
      '      </bpmndi:BPMNShape>',
      '    </bpmndi:BPMNPlane>',
      '  </bpmndi:BPMNDiagram>',
      '</bpmn:definitions>',
    ].join('\n');
    const back = fromXmlSync(xml, { onUnsupported: 'warn' });
    const shape = back.layout?.planes?.[0]?.shapes?.['t1'];
    expect(shape?.diId).toBe('shape-xyz');
    // 再导出沿用原 id（幂等 + 不破坏用户文件里的引用）
    const out = toXmlSync(back);
    expect(out).toContain('id="shape-xyz"');
    expect(toXmlSync(fromXmlSync(out, { onUnsupported: 'warn' }))).toBe(out);
  });
});

describe('§6.6 组 A：BPMN 规范属性是一等字段', () => {
  it('JSON→XML→JSON 双向落地（不是掉进 extension）', () => {
    const d = def({
      processes: [
        {
          id: 'P1',
          nodes: [
            { id: 'g', type: 'exclusiveGateway', gatewayDirection: 'Diverging', defaultFlow: 'f2' },
            { id: 't', type: 'userTask', implementation: '##unspecified' },
            { id: 'st', type: 'scriptTask', scriptFormat: 'javascript', script: 'amount * 0.1' },
            { id: 'ca', type: 'callActivity', calledElement: 'sub-key' },
            { id: 'sub', type: 'subProcess', triggeredByEvent: true },
            { id: 'dor', type: 'dataObjectReference', dataObjectRef: 'do1' },
            { id: 'dsr', type: 'dataStoreReference', dataStoreRef: 'ds1' },
            { id: 'send', type: 'sendTask', messageRef: 'm1', operationRef: 'o1' },
          ],
          flows: [
            { id: 'f1', from: 'g', to: 't' },
            { id: 'f2', from: 'g', to: 'st' },
          ],
        },
      ],
    });
    const xml = toXmlSync(d);
    expect(xml).toContain('gatewayDirection="Diverging"');
    expect(xml).toContain('default="f2"');
    expect(xml).toContain('implementation="##unspecified"');
    expect(xml).toContain('scriptFormat="javascript"');
    expect(xml).toContain('<bpmn:script>amount * 0.1</bpmn:script>');
    expect(xml).toContain('calledElement="sub-key"');
    expect(xml).toContain('triggeredByEvent="true"');
    expect(xml).toContain('dataObjectRef="do1"');
    expect(xml).toContain('dataStoreRef="ds1"');
    expect(xml).toContain('messageRef="m1"');
    expect(xml).toContain('operationRef="o1"');

    const byId = nodesOf(xml);
    expect(byId.get('g')!['gatewayDirection']).toBe('Diverging');
    expect(byId.get('g')!['defaultFlow']).toBe('f2');
    // ★ 不再重复存进 extension（旧实现只单向恒等，就是因为它落进了袋子里）
    expect((byId.get('g')!['extension'] as Record<string, unknown> | undefined)?.['default']).toBeUndefined();
    expect(byId.get('st')!['script']).toBe('amount * 0.1');
    expect(byId.get('sub')!['triggeredByEvent']).toBe(true);
    expect(byId.get('dor')!['dataObjectRef']).toBe('do1');
    expect(toXmlSync(fromXmlSync(xml, { onUnsupported: 'warn' }))).toBe(xml);
  });

  it('`false` 与「没配」是两回事：写了 false 必须落盘，没写则不凭空造值', () => {
    const written = toXmlSync(
      def({ processes: [{ id: 'P1', nodes: [{ id: 'sub', type: 'subProcess', triggeredByEvent: false }], flows: [] }] }),
    );
    expect(written).toContain('triggeredByEvent="false"');
    expect(fromXmlSync(written).processes[0]!.nodes[0]!.triggeredByEvent).toBe(false);

    const absent = toXmlSync(
      def({ processes: [{ id: 'P1', nodes: [{ id: 'sub', type: 'subProcess' }], flows: [] }] }),
    );
    expect(absent).not.toContain('triggeredByEvent');
    expect(fromXmlSync(absent).processes[0]!.nodes[0]!.triggeredByEvent).toBeUndefined();
  });

  it('<bpmn:script> 是规范子元素，不能被当成「覆盖表外元素」抛错', () => {
    // 默认 `onUnsupported` 是 `'throw'`（AC-S6）；旧实现会把标准 scriptTask 的子元素
    // 判成"没承诺的元素"→ 导入一个再普通不过的 ScriptTask 直接炸。
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:scriptTask id="st" scriptFormat="javascript">',
      '      <bpmn:script>1 + 1</bpmn:script>',
      '    </bpmn:scriptTask>',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    expect(() => fromXmlSync(xml)).not.toThrow();
    expect(fromXmlSync(xml).processes[0]!.nodes[0]!.script).toBe('1 + 1');
  });

  it('complexGateway 的 activationCondition 往返（不带多余的 xsi:type）', () => {
    const d = def({
      processes: [
        {
          id: 'P1',
          nodes: [
            { id: 'cg', type: 'complexGateway', activationCondition: { body: 'a > 1' } } as never,
          ],
          flows: [],
        },
      ],
    });
    const xml = toXmlSync(d);
    // 规范里 activationCondition 的声明类型**就是** tFormalExpression，写 xsi:type 是多余的
    expect(xml).toContain('<bpmn:activationCondition');
    expect(xml).not.toContain('activationCondition xsi:type');
    const back = fromXmlSync(xml, { onUnsupported: 'warn' });
    expect(back.processes[0]!.nodes[0]!.activationCondition).toEqual({
      body: 'a > 1',
      language: 'https://www.omg.org/spec/DMN/20230324/FEEL/',
    });
  });

  it('gatewayDirection 非法取值 → 报错并给全表；defaultFlow 悬空 → 报错', () => {
    const d = def({
      processes: [
        {
          id: 'P1',
          nodes: [{ id: 'g', type: 'exclusiveGateway', gatewayDirection: 'Sideways', defaultFlow: 'nope' }],
          flows: [],
        },
      ],
    });
    const ds = validateDefinition(d);
    const dir = ds.find((x) => x.code === MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE);
    expect(dir).toBeDefined();
    expect(dir!.expected).toEqual(['Unspecified', 'Converging', 'Diverging', 'Mixed']);
    const dangling = ds.find((x) => x.code === MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF);
    expect(dangling?.message).toContain('nope');
  });
});

describe('§6.6 组 B：第三方扩展不冒充规范属性', () => {
  it('assignee / candidateGroups / decisionRef 走带前缀的 extension', () => {
    const xml = [
      `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="D1" targetNamespace="http://x">`,
      '  <bpmn:process id="P1">',
      '    <bpmn:userTask id="t" camunda:assignee="zhangsan" camunda:candidateGroups="finance,admin" />',
      '    <bpmn:businessRuleTask id="br" camunda:decisionRef="discount" />',
      '  </bpmn:process>',
      '</bpmn:definitions>',
    ].join('\n');
    const byId = nodesOf(xml);
    // 类型表里查无此属性 → 写成不带前缀的属性就是**非法 XML**
    // （Camunda 7 用 camunda:、Flowable 用 flowable:，谁都不敢裸写）
    expect((byId.get('t')!['extension'] as Record<string, unknown>)['camunda:assignee']).toBe('zhangsan');
    expect(byId.get('t')!['assignee']).toBeUndefined();
    expect((byId.get('br')!['extension'] as Record<string, unknown>)['camunda:decisionRef']).toBe('discount');

    const out = toXmlSync(fromXmlSync(xml, { onUnsupported: 'warn' }));
    expect(out).toContain('camunda:assignee="zhangsan"');
    expect(out).toContain('camunda:candidateGroups="finance,admin"');
    expect(toXmlSync(fromXmlSync(out, { onUnsupported: 'warn' }))).toBe(out);
  });
});
