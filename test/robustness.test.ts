/**
 * 第二轮审计抓出来的真 bug 与口径缺口（回归锁定）。
 *
 * ★ 这批用例的共同点：它们**在 211 条全绿时全部存在**，因为旧用例只验"我们自己往返自洽"，
 * 不验"真实文件进得来 / 一等字段说了算 / 别人读得了"。
 */
import { describe, expect, it } from 'vitest';

import {
  fromXmlSync,
  isValidXmlId,
  toXmlSync,
  validateDefinition,
  type ProcessDefinition,
} from '../src/index.js';
import { MODDLE_DIAGNOSTIC_CODES, MODDLE_ERROR_CODES } from '../src/core/errors.js';

const wrap = (body: string, ns = ''): string =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"' +
  ' xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"' +
  ' xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"' +
  ' xmlns:di="http://www.omg.org/spec/DD/20100524/DI"' +
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
  ns +
  ' id="D1" targetNamespace="http://x">' +
  body +
  '</bpmn:definitions>';

const minimal = (over: Partial<ProcessDefinition> = {}): ProcessDefinition =>
  ({
    schemaVersion: '1.0.0',
    id: 'D1',
    processes: [{ id: 'P1', nodes: [{ id: 's', type: 'startEvent' }], flows: [] }],
    ...over,
  }) as ProcessDefinition;

describe('一等字段必须说了算（不能被 extension 反压）', () => {
  it('★ triggeredByEvent 改成 false，导出的就是 false', () => {
    const def = fromXmlSync(
      wrap('<bpmn:process id="P1"><bpmn:subProcess id="sp" triggeredByEvent="true"/></bpmn:process>'),
    );
    // 导入后不许同值两处存（否则"改哪边"是谜题）
    expect(def.processes[0]!.nodes[0]!.extension?.['triggeredByEvent']).toBeUndefined();
    expect(def.processes[0]!.nodes[0]!.triggeredByEvent).toBe(true);

    def.processes[0]!.nodes[0]!.triggeredByEvent = false;
    const out = toXmlSync(def, { declaration: false, autoLayout: false });
    expect(out).toContain('triggeredByEvent="false"');
    expect(fromXmlSync(out).processes[0]!.nodes[0]!.triggeredByEvent).toBe(false);
  });
});

describe('组 A 第二批：执行语义关键属性按真类型落地', () => {
  it('布尔 / 整数 / 枚举都按类型读，不再是字符串', () => {
    const xml = wrap(
      '<bpmn:process id="P1">' +
        '<bpmn:startEvent id="s" isInterrupting="false" parallelMultiple="true"/>' +
        '<bpmn:eventBasedGateway id="eg" eventGatewayType="Exclusive" instantiate="true"/>' +
        '<bpmn:userTask id="ut" isForCompensation="true" startQuantity="2" completionQuantity="3"/>' +
        '<bpmn:dataObject id="do1" isCollection="false"/>' +
        '<bpmn:boundaryEvent id="be" attachedToRef="ut" cancelActivity="false"/>' +
        '</bpmn:process>',
    );
    const nodes = fromXmlSync(xml).processes[0]!.nodes;
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId['s']!.isInterrupting).toBe(false); // ★ 不是字符串 'false'（truthy 陷阱）
    expect(byId['s']!.parallelMultiple).toBe(true);
    expect(byId['eg']!.eventGatewayType).toBe('Exclusive');
    expect(byId['eg']!.instantiate).toBe(true);
    expect(byId['ut']!.isForCompensation).toBe(true);
    expect(byId['ut']!.startQuantity).toBe(2);
    expect(byId['ut']!.completionQuantity).toBe(3);
    expect(byId['do1']!.isCollection).toBe(false);
    expect(byId['be']!.cancelActivity).toBe(false);
  });

  it('往返后都还在（engine 能按名字读，不必去 extension 里掏）', () => {
    const xml = wrap(
      '<bpmn:process id="P1"><bpmn:boundaryEvent id="be" cancelActivity="false"/>' +
        '<bpmn:eventBasedGateway id="eg" eventGatewayType="Parallel"/></bpmn:process>',
    );
    const out = toXmlSync(fromXmlSync(xml), { declaration: false, autoLayout: false });
    expect(out).toContain('cancelActivity="false"');
    expect(out).toContain('eventGatewayType="Parallel"');
  });

  it('eventGatewayType 写非法值 → error（带上规范全表）', () => {
    const def = minimal();
    (def.processes[0]!.nodes[0] as Record<string, unknown>)['eventGatewayType'] = 'Whatever';
    const hit = validateDefinition(def).find((d) => d.code === MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE);
    expect(hit?.severity).toBe('error');
    expect(hit?.expected).toEqual(['Parallel', 'Exclusive']);
  });
});

describe('id 必须是合法 xsd:ID', () => {
  it('判据：数字开头 / 含空白 / 含冒号一律不行', () => {
    expect(isValidXmlId('Activity_0abc')).toBe(true);
    expect(isValidXmlId('_x1')).toBe(true);
    expect(isValidXmlId('1s')).toBe(false);
    expect(isValidXmlId('a b')).toBe(false);
    expect(isValidXmlId('a:b')).toBe(false);
    expect(isValidXmlId('.a')).toBe(false);
    expect(isValidXmlId('')).toBe(false);
  });

  it('★ 非法 id 在校验层报 MODDLE_VALIDATE_INVALID_ID', () => {
    const def = minimal();
    def.processes[0]!.nodes[0]!.id = '1s';
    const ds = validateDefinition(def);
    expect(ds.some((d) => d.code === MODDLE_DIAGNOSTIC_CODES.VALIDATE_INVALID_ID && d.severity === 'error')).toBe(true);
  });

  it('合法 id 不报', () => {
    expect(validateDefinition(minimal()).filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('真实文件进得来（默认配置）', () => {
  it('★ 标准 BPMN 的 incoming / outgoing 被静默吸收（冗余替代组）', () => {
    const xml = wrap(
      '<bpmn:process id="P1"><bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>' +
        '<bpmn:endEvent id="e"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>' +
        '<bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="e"/></bpmn:process>',
    );
    const def = fromXmlSync(xml);
    expect(def.processes[0]!.nodes.map((n) => n.id)).toEqual(['s', 'e']);
    // 冗余信息不该变成保全袋里的几百条噪音
    expect(def.processes[0]!.nodes[0]!.extension).toBeUndefined();
  });

  it('★ 规范内未登记元素（ioSpecification / 多实例 / text）默认不抛，且往返不丢', () => {
    const xml = wrap(
      '<bpmn:process id="P1"><bpmn:serviceTask id="sv1">' +
        '<bpmn:ioSpecification id="io1"><bpmn:inputSet id="is1"/></bpmn:ioSpecification>' +
        '<bpmn:multiInstanceLoopCharacteristics isSequential="false"/>' +
        '</bpmn:serviceTask>' +
        '<bpmn:textAnnotation id="ta1"><bpmn:text>说明</bpmn:text></bpmn:textAnnotation>' +
        '</bpmn:process>',
    );
    const def = fromXmlSync(xml);
    const out = toXmlSync(def, { declaration: false, autoLayout: false });
    expect(out).toContain('bpmn:ioSpecification');
    expect(out).toContain('bpmn:multiInstanceLoopCharacteristics');
    expect(out).toContain('bpmn:text');
  });

  it('显式 onUnsupported:"throw" 仍然抛', () => {
    const xml = wrap('<bpmn:process id="P1"><bpmn:monitoring/></bpmn:process>');
    let code = '';
    try {
      fromXmlSync(xml, { onUnsupported: 'throw' });
    } catch (e) {
      code = String((e as { code?: string }).code ?? '');
    }
    expect(code).toBe(MODDLE_ERROR_CODES.XML_UNSUPPORTED_ELEMENT);
  });
});

describe('文件级信息不丢', () => {
  it('★ 别人的 targetNamespace 保住（不再被换成我们的）', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"' +
      ' id="D1" targetNamespace="http://bpmn.io/schema/bpmn">' +
      '<bpmn:process id="P1"><bpmn:startEvent id="s"/></bpmn:process></bpmn:definitions>';
    const def = fromXmlSync(xml);
    const out = toXmlSync(def, { declaration: false, autoLayout: false });
    expect(out).toContain('targetNamespace="http://bpmn.io/schema/bpmn"');
  });

  it('xsi:type 保回不再抛（前缀解析两处统一）', () => {
    const xml = wrap('<bpmn:process id="P1"><bpmn:task id="t1" xsi:type="bpmn:userTask"/></bpmn:process>');
    const out = toXmlSync(fromXmlSync(xml), { declaration: false, autoLayout: false });
    expect(out).toContain('xsi:type="bpmn:userTask"');
  });

  it('definitions / process 的 documentation 不再静默丢弃', () => {
    const xml = wrap(
      '<bpmn:documentation>def doc</bpmn:documentation>' +
        '<bpmn:process id="P1"><bpmn:documentation>proc doc</bpmn:documentation>' +
        '<bpmn:startEvent id="s"/></bpmn:process>',
    );
    const def = fromXmlSync(xml);
    expect(def.description).toBe('def doc');
    expect(def.processes[0]!.description).toBe('proc doc');
    const out = toXmlSync(def, { declaration: false, autoLayout: false });
    expect(out).toContain('def doc');
    expect(out).toContain('proc doc');
  });

  it('空 description 往返不丢', () => {
    const def = minimal();
    def.processes[0]!.nodes[0]!.description = '';
    const out = toXmlSync(def, { declaration: false, autoLayout: false });
    expect(fromXmlSync(out).processes[0]!.nodes[0]!.description).toBe('');
  });
});

describe('导出的形态细节', () => {
  it('★ timer 的 timeCycle 不套 FEEL 语言（它是 ISO 8601 字面量）', () => {
    const xml = wrap(
      '<bpmn:process id="P1"><bpmn:startEvent id="s"><bpmn:timerEventDefinition id="td">' +
        '<bpmn:timeCycle xsi:type="bpmn:tFormalExpression">R3/PT10H</bpmn:timeCycle>' +
        '</bpmn:timerEventDefinition></bpmn:startEvent></bpmn:process>',
    );
    const out = toXmlSync(fromXmlSync(xml), { declaration: false, autoLayout: false });
    const seg = out.slice(out.indexOf('timeCycle'));
    expect(seg).toContain('R3/PT10H');
    expect(seg.slice(0, seg.indexOf('>'))).not.toContain('language');
  });

  it('conditionExpression 必须带 language（默认 XPath，不写等于把 FEEL 当 XPath）', () => {
    const def = minimal();
    def.processes[0]!.flows = [{ id: 'f1', from: 's', to: 's', condition: 'amount > 5000' }];
    const out = toXmlSync(def, { declaration: false, autoLayout: false });
    expect(out).toContain('language="https://www.omg.org/spec/DMN/20230324/FEEL/"');
  });

  it('★ plane 的 id 不与语义元素撞车（duplicate ID = 非法 XML）', () => {
    const def = minimal();
    def.processes[0]!.nodes = [{ id: 'PL1', type: 'startEvent' }];
    def.layout = { planes: [{ id: 'PL1', elementId: 'P1', shapes: {}, edges: {} }] };
    const out = toXmlSync(def, { declaration: false, autoLayout: false });
    expect(out.match(/id="PL1"/g)).toHaveLength(1);
  });

  it('第三方元素快照的 xmlns 只声明一次（不逐轮变胖）', () => {
    const xml = wrap(
      '<bpmn:process id="P1"><bpmn:userTask id="t1"><bpmn:extensionElements>' +
        '<camunda:inputOutput><camunda:inputParameter name="x">1</camunda:inputParameter>' +
        '</camunda:inputOutput></bpmn:extensionElements></bpmn:userTask></bpmn:process>',
      ' xmlns:camunda="http://camunda.org/schema/1.0/bpmn"',
    );
    const def = fromXmlSync(xml);
    const snap = (def.processes[0]!.nodes[0]!.extension?.['_extensionElements'] as string[])[0]!;
    expect(snap.match(/xmlns:camunda/g)).toHaveLength(1);
  });
});
