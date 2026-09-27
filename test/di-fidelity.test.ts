/*
 * **DI（图面信息）保真**回归 —— 由第二十道门禁 `check:graph-equiv` 抓出来的两个真 bug，
 * 在这里钉死，避免以后被当成"无关紧要"改回去。
 *
 * 这两个 bug 的共同点是：**元素一个都没少，' 所以元素计数类的守恒检查全绿**；
 * 只有把同一个文件交给**别人的解析器**比对"它眼里的图"才看得出来。
 *
 * bug ①：只保全、不建模的元素（`group` / `dataInput` / `data*Association` …）
 *         虽然作为 XML 快照原样写回了，但它的 `BPMNShape` 被当成"悬空 DI"删掉
 *         → **元素还在、框没了**（MIWG 实测 C.5.0 丢 25 个 shape）。
 * bug ②：`ensureLayout` 把自动布局的整份结果往已有 layout 上合并，
 *         而自动布局的 plane 挂在 **process** 上、别人的 plane 常挂在 **collaboration** 上，
 *         对不上就整份追加 → A.4.0 原本 1 张图，转一圈变成 3 张。
 */
import { describe, expect, it } from 'vitest';
import { fromXmlSync, toXmlSync } from '../src/xml/index.js';
import { ensureLayout } from '../src/layout/auto-layout.js';
import type { ProcessDefinition } from '../src/model/definition.js';

const BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
const DI_NS = 'http://www.omg.org/spec/DD/20100524/DI'; // waypoint 的命名空间（**不是** MODEL/DI）
const BPMNDI_NS = 'http://www.omg.org/spec/BPMN/20100524/DI';
const DC_NS = 'http://www.omg.org/spec/DD/20100524/DC';

/** 一份带"只保全元素 + 它的坐标"的最小语料 */
const SNAPSHOT_DI = `<bpmn:definitions xmlns:bpmn="${BPMN_NS}"
     xmlns:bpmndi="${BPMNDI_NS}" xmlns:dc="${DC_NS}" xmlns:di="${DI_NS}"
     id="D1" targetNamespace="http://x">
  <bpmn:process id="P1" isExecutable="false">
    <bpmn:startEvent id="s" />
    <bpmn:task id="t" />
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t" />
    <bpmn:group id="G1" />
    <bpmn:dataInputAssociation id="DIA1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="DIA">
    <bpmndi:BPMNPlane id="PL" bpmnElement="P1">
      <bpmndi:BPMNShape id="S_s" bpmnElement="s"><dc:Bounds x="10" y="10" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="S_t" bpmnElement="t"><dc:Bounds x="100" y="10" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="S_G1" bpmnElement="G1"><dc:Bounds x="0" y="0" width="200" height="160"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="S_DIA1" bpmnElement="DIA1"><dc:Bounds x="20" y="20" width="30" height="30"/></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="E_f1" bpmnElement="f1">
        <di:waypoint x="46" y="28"/><di:waypoint x="100" y="50"/>
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

/** plane 挂在 **collaboration** 上的语料（MIWG A.4.0 那一型） */
const COLLAB_PLANE = `<bpmn:definitions xmlns:bpmn="${BPMN_NS}"
     xmlns:bpmndi="${BPMNDI_NS}" xmlns:dc="${DC_NS}" xmlns:di="${DI_NS}"
     id="D1" targetNamespace="http://x">
  <bpmn:collaboration id="C1">
    <bpmn:participant id="PA1" processRef="P1" />
  </bpmn:collaboration>
  <bpmn:process id="P1" isExecutable="false">
    <bpmn:startEvent id="s" />
    <bpmn:task id="t" />
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="DIA">
    <bpmndi:BPMNPlane id="PL" bpmnElement="C1">
      <bpmndi:BPMNShape id="S_PA1" bpmnElement="PA1" isHorizontal="true"><dc:Bounds x="0" y="0" width="600" height="250"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="S_s" bpmnElement="s"><dc:Bounds x="10" y="10" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="S_t" bpmnElement="t"><dc:Bounds x="100" y="10" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="E_f1" bpmnElement="f1">
        <di:waypoint x="46" y="28"/><di:waypoint x="100" y="50"/>
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

const shapeRefs = (xml: string): string[] =>
  [...xml.matchAll(/bpmnElement="([^"]+)"/g)].map((m) => m[1] as string);

describe('DI 保真 · 只保全元素的坐标不许丢', () => {
  it('★ group / dataInputAssociation 的 BPMNShape 往返后都还在', () => {
    const xml = toXmlSync(fromXmlSync(SNAPSHOT_DI));
    const refs = shapeRefs(xml);
    expect(refs).toContain('G1');
    expect(refs).toContain('DIA1');
  });

  it('往返前后 bpmnElement 的集合完全一致（不多也不少）', () => {
    const before = new Set(shapeRefs(SNAPSHOT_DI));
    const after = new Set(shapeRefs(toXmlSync(fromXmlSync(SNAPSHOT_DI))));
    expect([...after].sort()).toEqual([...before].sort());
  });

  it('元素本体也还在（光有坐标没有元素是另一种错）', () => {
    const xml = toXmlSync(fromXmlSync(SNAPSHOT_DI));
    expect(xml).toContain('bpmn:group');
    expect(xml).toContain('bpmn:dataInputAssociation');
  });
});

describe('DI 保真 · 不凭空追加 diagram', () => {
  it('★ plane 挂在 collaboration 上时，导出不多出 process 的 diagram', () => {
    const xml = toXmlSync(fromXmlSync(COLLAB_PLANE));
    const diagrams = xml.match(/<bpmndi:BPMNDiagram[^>]*>/g) ?? [];
    expect(diagrams.length).toBe(1);
    const planes = xml.match(/<bpmndi:BPMNPlane[^>]*>/g) ?? [];
    expect(planes.length).toBe(1);
    expect(xml).toContain('bpmnElement="C1"');
  });

  it('转一圈再转一圈，图的数量不变（幂等）', () => {
    const once = toXmlSync(fromXmlSync(COLLAB_PLANE));
    const twice = toXmlSync(fromXmlSync(once));
    expect((twice.match(/<bpmndi:BPMNDiagram/g) ?? []).length).toBe(
      (once.match(/<bpmndi:BPMNDiagram/g) ?? []).length,
    );
  });

  it('ensureLayout：已有 layout 时原样返回，不生成 process plane', () => {
    const def = fromXmlSync(COLLAB_PLANE);
    const planes = ensureLayout(def).planes.map((p) => p.elementId);
    expect(planes).toEqual(['C1']);
  });
});

describe('DI 保真 · 没有 layout 时才生成', () => {
  it('新建模型（无 layout）仍全量补出泳道 / 池的图形', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      collaborations: [{ id: 'C1', participants: [{ id: 'PA1', processRef: 'P1' }], messageFlows: [] }],
      processes: [
        {
          id: 'P1',
          laneSets: [{ id: 'LS1', lanes: [{ id: 'L1', name: '发起', nodeIds: ['s'] }] }],
          nodes: [
            { id: 's', type: 'startEvent' },
            { id: 't', type: 'userTask' },
            { id: 'e', type: 'endEvent' },
          ],
          flows: [
            { id: 'f1', from: 's', to: 't' },
            { id: 'f2', from: 't', to: 'e' },
          ],
        },
      ],
    };
    const xml = toXmlSync(def);
    const refs = shapeRefs(xml);
    // 泳道与池也必须画出来（第十七道画布门禁的要求）
    expect(refs).toContain('L1');
    expect(refs).toContain('PA1');
    expect(refs).toContain('s');
    expect(refs).toContain('f1');
  });
});
