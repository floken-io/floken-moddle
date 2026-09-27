/**
 * 泳道 / 协作图（泳道族 5 类真落地）。
 *
 * ★ 这几条用例的存在理由：覆盖表把 `participant` / `laneSet` / `lane` 登记为
 * **L1 必开（中国式审批流程图高频需求）**，但实现上它们曾经：
 * ① 被当顶层 flow node 塞进 `processes[].nodes`；② `flowNodeRef` 被丢弃；
 * ③ `collaboration` / `messageFlow` 整个不进模型 —— 导入泳道图再导出，泳道全没了。
 * 这里的断言逐条钉死"真落地"到底指什么。
 */
import { describe, expect, it } from 'vitest';

import { autoLayout, fromXmlSync, toXmlSync, validateDefinition } from '../src/index.js';
import { MODDLE_DIAGNOSTIC_CODES } from '../src/core/errors.js';

const wrap = (body: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"' +
  ' xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"' +
  ' xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"' +
  ' xmlns:di="http://www.omg.org/spec/DD/20100524/DI"' +
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="D1" targetNamespace="http://x">' +
  body +
  '</bpmn:definitions>';

const SWIMLANE = wrap(
  '<bpmn:process id="P1" isExecutable="true">' +
    '<bpmn:laneSet id="LS1">' +
    '<bpmn:lane id="L1" name="申请人"><bpmn:flowNodeRef>t1</bpmn:flowNodeRef></bpmn:lane>' +
    '<bpmn:lane id="L2" name="部门经理"><bpmn:flowNodeRef>t2</bpmn:flowNodeRef></bpmn:lane>' +
    '</bpmn:laneSet>' +
    '<bpmn:startEvent id="s"/>' +
    '<bpmn:userTask id="t1"/>' +
    '<bpmn:userTask id="t2"/>' +
    '<bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t1"/>' +
    '<bpmn:sequenceFlow id="f2" sourceRef="t1" targetRef="t2"/>' +
    '</bpmn:process>',
);

describe('泳道（laneSet / lane）', () => {
  it('★ 泳道进 Model JSON 的**专门落点**，不污染 nodes', () => {
    const def = fromXmlSync(SWIMLANE);
    const proc = def.processes[0]!;
    expect(proc.nodes.map((n) => n.id)).toEqual(['s', 't1', 't2']);
    expect(proc.laneSets).toHaveLength(1);
    const ls = proc.laneSets![0]!;
    expect(ls.id).toBe('LS1');
    expect(ls.lanes.map((l) => l.id)).toEqual(['L1', 'L2']);
    // ★ 泳道真正的数据：哪些节点归这条道
    expect(ls.lanes[0]!.nodeIds).toEqual(['t1']);
    expect(ls.lanes[1]!.nodeIds).toEqual(['t2']);
  });

  it('★ 往返后 flowNodeRef 还在（丢它就等于泳道变空壳）', () => {
    const out = toXmlSync(fromXmlSync(SWIMLANE), { declaration: false, autoLayout: false });
    expect(out).toContain('<bpmn:laneSet id="LS1">');
    expect(out).toContain('<bpmn:flowNodeRef>t1</bpmn:flowNodeRef>');
    expect(out).toContain('<bpmn:flowNodeRef>t2</bpmn:flowNodeRef>');
  });

  it('★ laneSet 必须排在 flowElement 之前（XSD 是 sequence，颠倒即非法）', () => {
    const out = toXmlSync(fromXmlSync(SWIMLANE), { declaration: false, autoLayout: false });
    expect(out.indexOf('<bpmn:laneSet')).toBeLessThan(out.indexOf('<bpmn:startEvent'));
  });

  /*
   * 泳道的图形：历史上做过两个极端，都错 ——
   *  ① 早期泳道被当成**顶层 flow node** 塞进 `nodes`，autoLayout 给它画 100×80 的**假框**；
   *  ② 修好 ① 之后泳道干脆**没有**图形，导出到画布上泳道不可见（bpmn-visualization 实测）。
   * 现在是第三条路：泳道有**真**图形 —— 用它名下节点的包围盒算出来，laneSet 本身仍不是图元。
   */
  it('autoLayout 给泳道画**真**框（节点包围盒），但不给 laneSet 画', () => {
    const def = fromXmlSync(SWIMLANE);
    const layout = autoLayout(def);
    const shapes = layout.planes[0]!.shapes;
    expect(Object.keys(shapes)).toContain('t1');
    expect(Object.keys(shapes)).toContain('L1');
    expect(Object.keys(shapes)).not.toContain('LS1'); // laneSet 是容器不是图元
    // 不是 100×80 的假框：它必须包住自己名下的节点
    const lane = shapes['L1']!;
    const t1 = shapes['t1']!;
    expect(lane.width).toBeGreaterThan(t1.width);
    expect(lane.x).toBeLessThanOrEqual(t1.x);
  });

  it('flowNodeRef 指向不存在的节点 → warn（不是 error：归属错了只是渲染问题）', () => {
    const def = fromXmlSync(SWIMLANE);
    def.processes[0]!.laneSets![0]!.lanes[0]!.nodeIds = ['nope'];
    const ds = validateDefinition(def);
    const hit = ds.find((d) => d.code === MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF);
    expect(hit?.severity).toBe('warn');
  });
});

describe('协作图（collaboration / participant / messageFlow）', () => {
  const COLLAB = wrap(
    '<bpmn:collaboration id="C1">' +
      '<bpmn:participant id="PA1" name="采购部" processRef="P1"/>' +
      '<bpmn:participant id="PA2" name="财务部"/>' +
      '<bpmn:messageFlow id="MF1" sourceRef="PA1" targetRef="PA2"/>' +
      '</bpmn:collaboration>' +
      '<bpmn:process id="P1"><bpmn:startEvent id="s"/></bpmn:process>',
  );

  it('★ 池与消息流进模型（以前整个丢掉）', () => {
    const def = fromXmlSync(COLLAB);
    expect(def.collaborations?.[0]?.id).toBe('C1');
    expect(def.collaborations?.[0]?.participants.map((p) => p.id)).toEqual(['PA1', 'PA2']);
    expect(def.collaborations?.[0]?.participants[0]?.processRef).toBe('P1');
    expect(def.collaborations?.[0]?.messageFlows).toEqual([{ id: 'MF1', from: 'PA1', to: 'PA2' }]);
  });

  it('★ 往返后池与消息流还在', () => {
    const out = toXmlSync(fromXmlSync(COLLAB), { declaration: false, autoLayout: false });
    expect(out).toContain('<bpmn:collaboration id="C1">');
    expect(out).toContain('processRef="P1"');
    expect(out).toContain('<bpmn:messageFlow id="MF1" sourceRef="PA1" targetRef="PA2"');
  });

  it('池的 DI 不被当成悬空过滤掉', () => {
    const xml = wrap(
      '<bpmn:collaboration id="C1"><bpmn:participant id="PA1" processRef="P1"/></bpmn:collaboration>' +
        '<bpmn:process id="P1"><bpmn:startEvent id="s"/></bpmn:process>' +
        '<bpmndi:BPMNDiagram id="DIA"><bpmndi:BPMNPlane id="PL1" bpmnElement="C1">' +
        '<bpmndi:BPMNShape id="PA1_di" bpmnElement="PA1" isHorizontal="true">' +
        '<dc:Bounds x="0" y="0" width="600" height="250"/></bpmndi:BPMNShape>' +
        '<bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="30" y="30" width="36" height="36"/>' +
        '</bpmndi:BPMNShape></bpmndi:BPMNPlane></bpmndi:BPMNDiagram>',
    );
    const out = toXmlSync(fromXmlSync(xml), { declaration: false });
    expect(out).toContain('bpmnElement="PA1"');
  });

  it('messageFlow 指向不存在的 participant → error', () => {
    const def = fromXmlSync(COLLAB);
    def.collaborations![0]!.messageFlows[0]!.to = 'nope';
    const ds = validateDefinition(def);
    expect(ds.some((d) => d.code === MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF && d.severity === 'error')).toBe(true);
  });
});

describe('会话族等不落地元素：不建模但必须保全', () => {
  it('会话族进 collaboration.extraElements，往返不丢', () => {
    const xml = wrap(
      '<bpmn:collaboration id="C1"><bpmn:participant id="PA1"/>' +
        '<bpmn:conversation id="CV1" name="订单会话"/>' +
        '<bpmn:conversationLink id="CL1" sourceRef="PA1" targetRef="CV1"/>' +
        '</bpmn:collaboration>' +
        '<bpmn:process id="P1"><bpmn:startEvent id="s"/></bpmn:process>',
    );
    const def = fromXmlSync(xml);
    const extra = def.collaborations?.[0]?.extraElements ?? [];
    expect(extra.some((s) => s.includes('bpmn:conversation'))).toBe(true);
    expect(toXmlSync(def, { declaration: false, autoLayout: false })).toContain('bpmn:conversation');
  });

  it('根级 <bpmn:message> 保全 → messageRef 不再是悬空引用', () => {
    const xml = wrap(
      '<bpmn:message id="Msg_1" name="订单消息"/>' +
        '<bpmn:process id="P1"><bpmn:startEvent id="s">' +
        '<bpmn:messageEventDefinition id="med1" messageRef="Msg_1"/>' +
        '</bpmn:startEvent></bpmn:process>',
    );
    const def = fromXmlSync(xml);
    expect(def.extraElements?.some((s) => s.includes('Msg_1'))).toBe(true);
    const out = toXmlSync(def, { declaration: false, autoLayout: false });
    expect(out).toContain('id="Msg_1"');
    expect(out).toContain('messageRef="Msg_1"');
  });
});
