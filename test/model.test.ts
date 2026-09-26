/**
 * Model JSON 顶层（§4.2 / §4.3 / §4.5 / §4.6）+ 整模型校验。
 *
 * ★ 数字一律从 `spec/` 推导后断言，不在测试里手列（手列错过三次：25 → 26 → 27）。
 */

import { describe, expect, it } from 'vitest';

import {
  COVERED_ELEMENT_NAMES,
  COVERAGE_STATS,
  EVENT_DEFINITION_TYPES,
  FEEL_EXPRESSION_LANGUAGE,
  MODEL_SCHEMA_VERSION,
  ModdleValidationError,
  assertValidDefinition,
  validateDefinition,
  validateLayout,
  type Approval,
  type ProcessDefinition,
} from '../src/index.js';

const errorsOf = (d: unknown) => validateDefinition(d).filter((x) => x.severity === 'error');
const codesOf = (d: unknown) => validateDefinition(d).map((x) => `${x.severity}:${x.code}`);

/** 一份最小可跑的模型：start → userTask（带审批）→ end */
const approval: Approval = {
  approvers: [{ type: 'starterLeader', level: 1 }],
  approverPolicy: 'first',
  reject: { allowed: true },
};

const minimal = (): ProcessDefinition => ({
  schemaVersion: MODEL_SCHEMA_VERSION,
  id: 'def-expense',
  name: '报销流程',
  processes: [
    {
      id: 'p1',
      executable: true,
      nodes: [
        { id: 'start', type: 'startEvent', name: '发起' },
        {
          id: 't1',
          type: 'userTask',
          name: '主管审批',
          formKey: 'expense-form',
          extension: { 'floken:approval': approval, 'camunda:assignee': 'u1' },
        },
        { id: 'end', type: 'endEvent' },
      ],
      flows: [
        { id: 'f1', from: 'start', to: 't1' },
        { id: 'f2', from: 't1', to: 'end', condition: 'amount > 5000' },
      ],
    },
  ],
});

describe('顶层结构（§4.2）', () => {
  it('最小模型通过校验', () => {
    expect(errorsOf(minimal())).toEqual([]);
  });

  it('condition 简写与全写都接受', () => {
    const d = minimal();
    d.processes[0]!.flows[1]!.condition = {
      body: 'amount > 5000',
      language: FEEL_EXPRESSION_LANGUAGE,
    };
    expect(errorsOf(d)).toEqual([]);
  });

  it('processes 至少一个', () => {
    const d = minimal();
    d.processes = [];
    expect(errorsOf(d).length).toBeGreaterThan(0);
  });

  it('★ extension 是保全袋：第三方属性必须留着（纪律一）', () => {
    const d = minimal();
    // 'camunda:assignee' 不是我们的字段，但 schema 不能拒绝它
    expect(errorsOf(d)).toEqual([]);
    expect(d.processes[0]!.nodes[1]!.extension?.['camunda:assignee']).toBe('u1');
  });
});

describe('引用完整性', () => {
  it('节点 id 重复 → DUPLICATE_ID', () => {
    const d = minimal();
    d.processes[0]!.nodes[1]!.id = 'start';
    expect(codesOf(d)).toContain('error:MODDLE_VALIDATE_DUPLICATE_ID');
  });

  it('flow.from 指向不存在的节点 → DANGLING_REF', () => {
    const d = minimal();
    d.processes[0]!.flows[0]!.from = 'nope';
    expect(codesOf(d)).toContain('error:MODDLE_VALIDATE_DANGLING_REF');
  });

  it('连线用 from / to，不是 sourceRef / targetRef（§4.3）', () => {
    const d = minimal();
    const flow = d.processes[0]!.flows[0]!;
    expect(Object.keys(flow)).toContain('from');
    expect(Object.keys(flow)).toContain('to');
    expect(Object.keys(flow)).not.toContain('sourceRef');
  });
});

describe('元素覆盖（§5）', () => {
  it('★ 覆盖表总数 = 27 可执行 + 21 不可执行，且**由数据算出**', () => {
    expect(COVERAGE_STATS['executable']).toBe(27);
    expect(COVERAGE_STATS['nonExecutable']).toBe(21);
    expect(COVERED_ELEMENT_NAMES).toHaveLength(48);
  });

  it('未承诺的元素类型只 warn —— 保全优先，绝不静默丢弃', () => {
    const d = minimal();
    d.processes[0]!.nodes.push({ id: 'x', type: 'someVendorTask' });
    const ds = validateDefinition(d);
    expect(ds.filter((x) => x.severity === 'error')).toEqual([]);
    const w = ds.find((x) => x.code === 'MODDLE_VALIDATE_ELEMENT_UNSUPPORTED');
    expect(w?.severity).toBe('warn');
    expect(w?.node?.id).toBe('x');
  });

  it('★ eventDefinition.type 由类型表推导（不手列）', () => {
    expect(EVENT_DEFINITION_TYPES).toContain('timer');
    expect(EVENT_DEFINITION_TYPES).toContain('message');
    expect(EVENT_DEFINITION_TYPES).toContain('compensate');
    expect(EVENT_DEFINITION_TYPES).not.toContain('eventDefinition');
    expect(EVENT_DEFINITION_TYPES.length).toBeGreaterThan(5);
  });

  it('boundaryEvent 的 eventDefinition 走规范结构，不是我们的发明', () => {
    const d = minimal();
    d.processes[0]!.nodes.push({
      id: 'b1',
      type: 'boundaryEvent',
      attachedTo: 't1',
      eventDefinition: { type: 'timer', duration: 'P3D' },
    });
    expect(errorsOf(d)).toEqual([]);
  });

  it('越界的 eventDefinition.type → warn + 列出合法取值', () => {
    const d = minimal();
    d.processes[0]!.nodes.push({
      id: 'b2',
      type: 'boundaryEvent',
      attachedTo: 't1',
      eventDefinition: { type: 'wechat' },
    });
    const w = validateDefinition(d).find((x) => x.code === 'MODDLE_VALIDATE_ELEMENT_UNSUPPORTED');
    expect(w?.expected).toEqual([...EVENT_DEFINITION_TYPES]);
  });
});

describe('layout（§4.6）', () => {
  const layout = {
    planes: [
      {
        id: 'plane1',
        elementId: 'p1',
        shapes: {
          start: { x: 0, y: 0, width: 36, height: 36 },
          t1: { x: 120, y: 0, width: 100, height: 80 },
          end: { x: 280, y: 0, width: 36, height: 36 },
        },
        edges: { f1: { waypoints: [{ x: 36, y: 18 }, { x: 120, y: 40 }] } },
      },
    ],
  };

  it('结构合法 → 无诊断', () => {
    expect(validateLayout(layout)).toEqual([]);
  });

  it('引擎零耦合：校验整模型时 layout 引用未知元素只 warn', () => {
    const d = minimal();
    d.layout = layout;
    expect(errorsOf(d)).toEqual([]); // 三个 shape 都指向真实节点

    const bad = minimal();
    bad.layout = { planes: [{ id: 'p', elementId: 'p1', shapes: { ghost: { x: 0, y: 0, width: 1, height: 1 } }, edges: {} }] };
    expect(codesOf(bad)).toContain('warn:MODDLE_VALIDATE_DANGLING_REF');
  });

  it('waypoints 少于 2 点 → error（补不出来的才是硬错）', () => {
    const bad = {
      planes: [{ id: 'p', elementId: 'p1', shapes: {}, edges: { f: { waypoints: [{ x: 0, y: 0 }] } } }],
    };
    expect(validateLayout(bad).some((x) => x.severity === 'error')).toBe(true);
  });

  it('可缺：不配 layout 完全合法（autoLayout 兜底）', () => {
    const d = minimal();
    expect(d.layout).toBeUndefined();
    expect(errorsOf(d)).toEqual([]);
  });
});

describe('审批语义挂到节点上（§4.4）', () => {
  it('坏审批配置会带着**节点定位**报出来（§5.4：禁止只给一句校验失败）', () => {
    const d = minimal();
    const t1 = d.processes[0]!.nodes[1]!;
    t1.extension = { 'floken:approval': { approvers: [] } };
    const e = validateDefinition(d).find((x) => x.code === 'MODDLE_VALIDATE_APPROVER_REQUIRED');
    expect(e?.node?.id).toBe('t1');
    expect(e?.node?.path).toContain("extension['floken:approval']");
  });
});

describe('严格模式', () => {
  it('assertValidDefinition：干净模型原样返回', () => {
    const d = minimal();
    expect(assertValidDefinition(d)).toBe(d);
  });

  it('assertValidDefinition：有 error 就抛', () => {
    const d = minimal();
    d.processes[0]!.flows[0]!.to = 'ghost';
    expect(() => assertValidDefinition(d)).toThrow(ModdleValidationError);
  });

  it('strict 模式下 warn 也算不合格', () => {
    const d = minimal();
    d.processes[0]!.nodes.push({ id: 'x', type: 'vendorOnly' });
    expect(() => assertValidDefinition(d)).not.toThrow();
    expect(() => assertValidDefinition(d, { strict: true })).toThrow(ModdleValidationError);
  });
});

describe('FEEL 语言 URI（D18 / Q35）', () => {
  it('★ 取 OMG 官方值，不自造；权威版本是 DMN 1.5', () => {
    expect(FEEL_EXPRESSION_LANGUAGE).toBe('https://www.omg.org/spec/DMN/20230324/FEEL/');
  });
});
