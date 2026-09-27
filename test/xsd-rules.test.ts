/*
 * 官方 XSD 抓出来的**结构性不变量**（源自 `check:xsd` 门禁，2026-09-26）。
 *
 * 这些规则在代码里看着都像"排版偏好"，其实是 OMG BPMN20.xsd 的 `xsd:sequence` /
 * 元素归属 —— 违反它们产出的是**非法** XML，而我们自己的解析器宽容读得回来，
 * 所以只有把它交给官方 XSD（或别人的解析器）才会暴露。
 * 这里用断言钉死，避免以后被当成"无关紧要的顺序"改回去。
 */
import { describe, expect, it } from 'vitest';
import { MODDLE_DIAGNOSTIC_CODES, type Diagnostic } from '../src/core/errors.js';
import { validateDefinition, type ProcessDefinition } from '../src/model/definition.js';
import { autoLayout } from '../src/layout/auto-layout.js';
import { fromXmlSync, toXmlSync } from '../src/xml/index.js';

const BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';

const wrap = (inner: string): string =>
  `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="D1" targetNamespace="http://x">${inner}</bpmn:definitions>`;

describe('官方 XSD 结构性不变量', () => {
  it('一个 BPMNDiagram 只装一个 BPMNPlane（BPMNDI.xsd 的 content model）', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      processes: [
        { id: 'P1', nodes: [{ id: 's', type: 'startEvent' }], flows: [] },
        { id: 'P2', nodes: [{ id: 's2', type: 'startEvent' }], flows: [] },
      ],
    };
    const xml = toXmlSync(def);
    const diagrams = xml.match(/<bpmndi:BPMNDiagram[^>]*>/g) ?? [];
    const planes = xml.match(/<bpmndi:BPMNPlane[^>]*>/g) ?? [];
    expect(diagrams.length).toBe(planes.length);
    expect(planes.length).toBe(2);
    // 每个 diagram 内部有且只有一个 plane
    const perDiagram = xml.split('<bpmndi:BPMNDiagram').slice(1);
    for (const d of perDiagram) {
      expect((d.match(/<bpmndi:BPMNPlane/g) ?? []).length).toBe(1);
    }
  });

  it('sequenceFlow：extensionElements 必须写在 conditionExpression **之前**', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      processes: [
        {
          id: 'P1',
          nodes: [
            { id: 's', type: 'startEvent' },
            { id: 't', type: 'task' },
          ],
          flows: [
            {
              id: 'f1',
              from: 's',
              to: 't',
              condition: 'true',
              extension: { _extensionElements: ['<camunda:foo a="1" />'] },
            },
          ],
        },
      ],
    };
    const xml = toXmlSync(def, { autoLayout: false });
    expect(xml.indexOf('extensionElements')).toBeLessThan(xml.indexOf('conditionExpression'));
  });

  it('documentation 必须写在 extensionElements **之前**（tBaseElement 的 sequence）', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      description: 'def doc',
      processes: [
        {
          id: 'P1',
          description: 'proc doc',
          nodes: [{ id: 's', type: 'startEvent', description: 'node doc' }],
          flows: [],
        },
      ],
    };
    const xml = toXmlSync(def, { autoLayout: false });
    const firstDoc = xml.indexOf('<bpmn:documentation>');
    const ext = xml.indexOf('extensionElements');
    if (ext >= 0) expect(firstDoc).toBeLessThan(ext);
    expect(xml).toContain('<bpmn:documentation>def doc</bpmn:documentation>');
    expect(xml).toContain('<bpmn:documentation>proc doc</bpmn:documentation>');
    expect(xml).toContain('<bpmn:documentation>node doc</bpmn:documentation>');
  });

  it('BPMN 命名空间的未落地元素进 _bpmnChildren，**不进** extensionElements', () => {
    // XSD：extensionElements 的内容是 <xsd:any namespace="##other"/>，规范元素放进去 = 非法
    const xml = wrap(
      '<bpmn:process id="P1"><bpmn:task id="t1"><bpmn:ioSpecification /></bpmn:task></bpmn:process>',
    );
    const def = fromXmlSync(xml);
    const ext = def.processes[0]!.nodes[0]!.extension ?? {};
    expect(ext['_bpmnChildren']).toBeDefined();
    expect(ext['_extensionElements']).toBeUndefined();
    // 且必须**原地**回写（不是塞进 extensionElements）
    const out = toXmlSync(def, { autoLayout: false });
    expect(out).toContain('ioSpecification');
    expect(out).not.toMatch(/<bpmn:extensionElements>[\s\S]*ioSpecification/);
  });

  it('第三方元素仍进 extensionElements（那是它该待的地方）', () => {
    const xml = wrap(
      '<bpmn:process id="P1"><bpmn:task id="t1"><bpmn:extensionElements><camunda:inputOutput /></bpmn:extensionElements></bpmn:task></bpmn:process>',
    );
    const def = fromXmlSync(xml);
    const ext = def.processes[0]!.nodes[0]!.extension ?? {};
    expect(ext['_extensionElements']).toBeDefined();
    expect(ext['_bpmnChildren']).toBeUndefined();
  });

  it('规范属性挂错元素类型 → 跳过并**告警**（不是静默丢，也不是写出非法 XML）', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      processes: [
        {
          id: 'P1',
          nodes: [
            // messageRef 是 messageEventDefinition / sendTask / receiveTask 的属性，不属于 catchEvent
            { id: 'ev', type: 'intermediateCatchEvent', messageRef: 'Msg_1' },
          ],
          flows: [],
        },
      ],
    };
    const seen: Diagnostic[] = [];
    const xml = toXmlSync(def, { autoLayout: false, onDiagnostic: (d) => seen.push(d) });
    expect(xml).not.toContain('messageRef');
    const hit = seen.find((d) => d.code === MODDLE_DIAGNOSTIC_CODES.VALIDATE_ATTR_NOT_ALLOWED);
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warn');
    expect(hit!.message).toContain('messageRef');
  });

  it('合法归属照常写出（不能因为加了过滤就把对的也挡了）', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      processes: [
        {
          id: 'P1',
          nodes: [
            { id: 'g', type: 'exclusiveGateway', gatewayDirection: 'Diverging' },
            { id: 'st', type: 'scriptTask', scriptFormat: 'javascript', script: '1+1' },
          ],
          flows: [],
        },
      ],
    };
    const xml = toXmlSync(def, { autoLayout: false });
    expect(xml).toContain('gatewayDirection="Diverging"');
    expect(xml).toContain('scriptFormat="javascript"');
  });

  it('association 缺端点 → error（XSD 里 sourceRef/targetRef 是 required）', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      processes: [
        {
          id: 'P1',
          nodes: [
            { id: 'ta', type: 'textAnnotation', text: 'x' },
            { id: 'as', type: 'association' },
          ],
          flows: [],
        },
      ],
    };
    const ds = validateDefinition(def);
    const hit = ds.find((d) => d.code === MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF);
    expect(hit?.severity).toBe('error');
    expect(hit!.message).toContain('sourceRef');
  });

  it('association 有端点 → 端点原样往返', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      processes: [
        {
          id: 'P1',
          nodes: [
            { id: 'ta', type: 'textAnnotation', text: 'x' },
            { id: 't1', type: 'task' },
            {
              id: 'as',
              type: 'association',
              sourceRef: 'ta',
              targetRef: 't1',
              associationDirection: 'One',
            },
          ],
          flows: [],
        },
      ],
    };
    const back = fromXmlSync(toXmlSync(def, { autoLayout: false }));
    const as = back.processes[0]!.nodes.find((n) => n.id === 'as');
    expect(as?.sourceRef).toBe('ta');
    expect(as?.targetRef).toBe('t1');
    expect(as?.associationDirection).toBe('One');
  });

  it('artifact 必须排在所有 flowElement（含 sequenceFlow）之后 —— 子流程内同样适用', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      processes: [
        {
          id: 'P1',
          nodes: [
            {
              id: 'sub',
              type: 'subProcess',
              nodes: [
                { id: 'si', type: 'startEvent' },
                { id: 'se', type: 'endEvent' },
                { id: 'ta', type: 'textAnnotation', text: 'note' },
              ],
              flows: [{ id: 'sf1', from: 'si', to: 'se' }],
            },
          ],
          flows: [],
        },
      ],
    };
    const xml = toXmlSync(def, { autoLayout: false });
    expect(xml.indexOf('textAnnotation')).toBeGreaterThan(xml.indexOf('sequenceFlow'));
  });

  it('definitions 的 <bpmn:import> 必须排在 BPMNDiagram 之前', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      extraElements: ['<bpmn:import namespace="http://a" location="a.bpmn" importType="http://www.omg.org/spec/BPMN/20100524/MODEL" />'],
      processes: [{ id: 'P1', nodes: [{ id: 's', type: 'startEvent' }], flows: [] }],
    };
    const xml = toXmlSync(def);
    expect(xml.indexOf('<bpmn:import')).toBeLessThan(xml.indexOf('BPMNDiagram'));
  });

  it('泳道有**真**图形（不是假框，也不是没有）', () => {
    const def: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D1',
      processes: [
        {
          id: 'P1',
          laneSets: [{ id: 'LS1', lanes: [{ id: 'L1', nodeIds: ['s', 't'] }] }],
          nodes: [
            { id: 's', type: 'startEvent' },
            { id: 't', type: 'task' },
          ],
          flows: [{ id: 'f1', from: 's', to: 't' }],
        },
      ],
    };
    const layout = autoLayout(def);
    const shapes = layout.planes[0]!.shapes;
    expect(shapes['L1']).toBeDefined();
    expect(shapes['LS1']).toBeUndefined(); // laneSet 是容器，不是图元
    // 泳道必须包住自己的节点（不是 100×80 的假框）
    const l = shapes['L1']!;
    const s = shapes['s']!;
    const t = shapes['t']!;
    expect(l.x).toBeLessThan(Math.min(s.x, t.x));
    expect(l.x + l.width).toBeGreaterThan(Math.max(s.x + s.width, t.x + t.width));
  });
});
