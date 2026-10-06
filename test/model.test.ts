/**
 * Model JSON v2 顶层（§4.2 / §4.3 / §4.5 / §4.6）+ 整模型校验（§5）。
 *
 * ★ 两条纪律：
 * 1. **数字一律从常量算**（`NODE_TYPES.length`），不在测试里手列 —— 手列错过三次（25 → 26 → 27）；
 * 2. 每条 `it` 对齐一条 AC（AC-M1 ~ AC-M8），改坏哪条一眼就看得出。
 */

import { describe, expect, it } from 'vitest';

import {
  EXECUTABLE_NODE_TYPES,
  MODEL_SCHEMA_VERSION,
  ModdleValidationError,
  NODE_RESERVED_KEYS,
  NODE_TYPES,
  NODE_TYPE_GROUPS,
  UNIMPLEMENTED_NODE_TYPES,
  assertValidDefinition,
  autoLayout,
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
  nodes: [
    { id: 'start', type: 'startEvent', name: '发起' },
    {
      id: 't1',
      type: 'userTask',
      name: '主管审批',
      formKey: 'expense-form',
      approval,
      extension: { 'camunda:assignee': 'u1', priority: 'high', level: 3 },
    },
    { id: 'end', type: 'endEvent' },
  ],
  flows: [
    { id: 'f1', from: 'start', to: 't1' },
    { id: 'f2', from: 't1', to: 'end', condition: 'amount > 5000' },
  ],
});

describe('顶层结构（§4.2）', () => {
  it('最小模型通过校验（★ 节点与连线在顶层，没有 processes[]）', () => {
    expect(errorsOf(minimal())).toEqual([]);
  });

  it('schemaVersion 是 2.0.0（v2 = JSON-only 重做后的形状）', () => {
    expect(MODEL_SCHEMA_VERSION).toBe('2.0.0');
  });

  it('major 不是 2 → VALIDATE_SCHEMA_VERSION（不静默兼容、不迁移）', () => {
    const def = { ...minimal(), schemaVersion: '1.0.0' };
    expect(codesOf(def)).toContain('error:MODDLE_VALIDATE_SCHEMA_VERSION');
  });

  it('★ 未知顶层键保留不丢（FR-M8：放开 .strict()，但**不解读**）', () => {
    const def = { ...minimal(), acmeTop: { a: 1 } } as unknown;
    expect(errorsOf(def)).toEqual([]);
    expect((def as Record<string, unknown>)['acmeTop']).toEqual({ a: 1 });
  });

  it('顶层 extensions 袋：任意 JSON 都收', () => {
    const def = { ...minimal(), extensions: { tenant: 'acme', flags: [1, 2] } };
    expect(errorsOf(def)).toEqual([]);
  });
});

describe('节点类型白名单（§3 · AC-M1 / AC-M2）', () => {
  it('★ NODE_TYPES.length === 21，EXECUTABLE_NODE_TYPES.length === 17（数字从常量算）', () => {
    expect(NODE_TYPES.length).toBe(21);
    expect(EXECUTABLE_NODE_TYPES.length).toBe(17);
    expect(UNIMPLEMENTED_NODE_TYPES.length).toBe(4);
  });

  it('四族之和 = 总数（分组表没有漏项也没有多项）', () => {
    const sum = Object.values(NODE_TYPE_GROUPS).reduce((n, g) => n + g.length, 0);
    expect(sum).toBe(NODE_TYPES.length);
    expect(NODE_TYPE_GROUPS['task']?.length).toBe(8);
    expect(NODE_TYPE_GROUPS['gateway']?.length).toBe(5);
    expect(NODE_TYPE_GROUPS['event']?.length).toBe(6);
    expect(NODE_TYPE_GROUPS['structure']?.length).toBe(2);
  });

  it('可执行 = 总数 − 未实现（不另写一份清单）', () => {
    expect(EXECUTABLE_NODE_TYPES).toEqual(
      NODE_TYPES.filter((t) => !UNIMPLEMENTED_NODE_TYPES.includes(t)),
    );
  });

  it('★ 拼错类型 → error（AC-M3：不能等运行期才发现）', () => {
    const def = minimal();
    def.nodes[1] = { ...def.nodes[1]!, type: 'userTaks' };
    expect(codesOf(def)).toContain('error:MODDLE_VALIDATE_NODE_TYPE');
  });

  it('★ 未实现的 4 类：建模期**放行**（warn），引擎令牌到达时抛错（AC-M2）', () => {
    for (const t of UNIMPLEMENTED_NODE_TYPES) {
      const def = minimal();
      def.nodes[1] = { id: 't1', type: t, name: 'x' };
      const ds = validateDefinition(def);
      expect(ds.filter((d) => d.severity === 'error').map((d) => d.code)).not.toContain(
        'MODDLE_VALIDATE_NODE_TYPE',
      );
      expect(ds.map((d) => d.code)).toContain('MODDLE_VALIDATE_NODE_UNIMPLEMENTED');
    }
  });

  it('customNodeTypes 内的类型通过校验；不在里头的照样 error（AC-M3）', () => {
    const def = minimal();
    def.nodes[1] = { id: 't1', type: 'robotTask', name: '机器人' };
    expect(errorsOf(def).length).toBeGreaterThan(0);
    expect(validateDefinition(def, { customNodeTypes: ['robotTask'] }).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('★ 未知类型要给全量合法取值（§5.4：期望类诊断必须带 expected）', () => {
    const def = minimal();
    def.nodes[1] = { ...def.nodes[1]!, type: 'userTaks' };
    const d = validateDefinition(def).find((x) => x.code === 'MODDLE_VALIDATE_NODE_TYPE');
    expect(d?.expected).toEqual([...NODE_TYPES]);
  });
});

describe('引用完整性（§5 层③）', () => {
  it('节点 id 重复 → DUPLICATE_ID', () => {
    const def = minimal();
    def.nodes[2] = { id: 't1', type: 'endEvent' };
    expect(codesOf(def)).toContain('error:MODDLE_VALIDATE_DUPLICATE_ID');
  });

  it('flow.from 指向不存在的节点 → DANGLING_REF', () => {
    const def = minimal();
    def.flows[0] = { ...def.flows[0]!, from: 'nope' };
    expect(codesOf(def)).toContain('error:MODDLE_VALIDATE_DANGLING_REF');
  });

  it('连线用 from / to，不是 sourceRef / targetRef（§4.3）', () => {
    const def = minimal();
    expect(Object.keys(def.flows[0]!)).toContain('from');
    expect(Object.keys(def.flows[0]!)).toContain('to');
  });

  it('子流程里的节点同样是合法引用目标（递归收集）', () => {
    const def = minimal();
    def.nodes.splice(2, 0, {
      id: 'sub',
      type: 'subProcess',
      nodes: [{ id: 'inner', type: 'userTask', approval }],
      flows: [],
    });
    def.flows.push({ id: 'f3', from: 't1', to: 'inner' });
    expect(errorsOf(def)).toEqual([]);
  });
});

describe('自定义扩展（§4.5 · AC-M4 / AC-M5）', () => {
  it('★ 结构化值**不再抛错**（v1 的 `toXml` 会抛「第三方扩展的结构化内容无法写成属性」）', () => {
    const def = minimal();
    def.nodes[1] = {
      ...def.nodes[1]!,
      extension: { a: 1, b: [1, 2], c: { d: true }, e: null },
    };
    expect(errorsOf(def)).toEqual([]);
  });

  it('★ JSON 深拷贝往返零丢失（AC-M4）', () => {
    const def = minimal();
    def.nodes[1] = {
      ...def.nodes[1]!,
      extension: { a: 1, b: [1, 2], c: { d: true }, e: null, f: 's' },
    };
    const back = JSON.parse(JSON.stringify(def)) as ProcessDefinition;
    expect(back.nodes[1]!.extension).toEqual(def.nodes[1]!.extension);
    expect(errorsOf(back)).toEqual([]);
  });

  it('★ 节点级未知键保留不丢（AC-M5）', () => {
    const def = minimal();
    const node = { ...def.nodes[1]!, acmeWhatever: { x: 1 } } as Record<string, unknown>;
    def.nodes[1] = node as ProcessDefinition['nodes'][number];
    expect(errorsOf(def)).toEqual([]);
    expect(node['acmeWhatever']).toEqual({ x: 1 });
  });

  it('★ 保留键不许塞进 extension（§4.5 硬边界）', () => {
    const def = minimal();
    def.nodes[1] = { ...def.nodes[1]!, extension: { approval: { approvers: [] } } };
    expect(codesOf(def)).toContain('error:MODDLE_VALIDATE_RESERVED_KEY');
  });

  it('NODE_RESERVED_KEYS 覆盖全部一等字段（引擎侧 ADR-009 排除判据的数据源）', () => {
    for (const k of ['id', 'type', 'approval', 'call', 'eventDefinition', 'timeout']) {
      expect(NODE_RESERVED_KEYS).toContain(k);
    }
  });
});

describe('审批语义是一等字段（§4.4）', () => {
  it('★ node.approval 直接给，不用 extension[\'floken:approval\']', () => {
    const def = minimal();
    expect(def.nodes[1]!.approval).toBe(approval);
    expect(errorsOf(def)).toEqual([]);
  });

  it('坏审批配置会带着**节点定位**报出来（§5.4：禁止只给一句校验失败）', () => {
    const def = minimal();
    def.nodes[1] = {
      id: 't1',
      type: 'userTask',
      approval: { approvers: [], approverPolicy: 'first' } as unknown as Approval,
    };
    const ds = validateDefinition(def);
    const d = ds.find((x) => x.node?.path?.includes('approval'));
    expect(d).toBeDefined();
    expect(d?.node?.id).toBe('t1');
  });
});

describe('layout（§4.6）', () => {
  it('★ v2 是扁平字典（nodes / edges），不再是 planes[]', () => {
    const def = minimal();
    def.layout = { nodes: { t1: { x: 10, y: 20, width: 100, height: 80 } }, edges: { f1: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } };
    expect(errorsOf(def)).toEqual([]);
  });

  it('结构合法 → 无诊断', () => {
    expect(validateLayout({ nodes: { a: { x: 0, y: 0 } } })).toEqual([]);
  });

  it('引用未知元素只 warn（坐标层不参与执行语义）', () => {
    const ds = validateLayout({ nodes: { ghost: { x: 0, y: 0 } } }, { knownIds: new Set(['t1']) });
    expect(ds.filter((d) => d.severity === 'error')).toEqual([]);
    expect(ds.map((d) => d.code)).toContain('MODDLE_VALIDATE_DANGLING_REF');
  });

  it('折点少于 2 点 → error（补不出来的才是硬错）', () => {
    const ds = validateLayout({ edges: { f1: [{ x: 0, y: 0 }] } });
    expect(ds.filter((d) => d.severity === 'error').map((d) => d.code)).toContain(
      'MODDLE_VALIDATE_DI_INCOMPLETE',
    );
  });

  it('可缺：不配 layout 完全合法（autoLayout 兜底）', () => {
    expect(errorsOf(minimal())).toEqual([]);
  });

  it('autoLayout 产出扁平字典，且**确定性**（同输入两次完全一致）', () => {
    const def = minimal();
    const a = autoLayout(def);
    const b = autoLayout(def);
    expect(a).toEqual(b);
    expect(Object.keys(a.nodes ?? {}).sort()).toEqual(['end', 'start', 't1']);
    expect(a.edges?.['f1']?.length).toBeGreaterThanOrEqual(2);
  });

  it('autoLayout 的结果能通过 layout 校验（layout 与节点 id 对得上）', () => {
    const def = minimal();
    def.layout = autoLayout(def);
    expect(errorsOf(def)).toEqual([]);
  });
});

describe('严格模式（§5）', () => {
  it('assertValidDefinition：干净模型不抛', () => {
    expect(() => assertValidDefinition(minimal())).not.toThrow();
  });

  it('assertValidDefinition：有 error 就抛，且一次带全（不是报第一个就停 · AC-M8）', () => {
    const def = minimal();
    def.nodes[1] = { ...def.nodes[1]!, type: 'userTaks' };
    def.flows[1] = { ...def.flows[1]!, to: 'ghost' };
    try {
      assertValidDefinition(def);
      expect.unreachable('应当抛错');
    } catch (e) {
      const err = e as ModdleValidationError;
      expect(err.code).toBe('MODDLE_MODEL_VALIDATION_FAILED');
      expect((err.details?.['count'] as number) ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('★ 收集**全部**诊断：一份定义 3 处错 → 至少 3 条（AC-M8）', () => {
    const def = minimal();
    def.nodes[1] = { ...def.nodes[1]!, type: 'userTaks' };
    def.nodes[2] = { id: 't1', type: 'endEvent' };
    def.flows[1] = { ...def.flows[1]!, to: 'ghost' };
    expect(errorsOf(def).length).toBeGreaterThanOrEqual(3);
  });

  it('拼错选项名 → 诊断（禁止静默忽略）', () => {
    const ds = validateDefinition(minimal(), { customNodeTypo: [] } as never);
    expect(ds.map((d) => d.code)).toContain('MODDLE_VALIDATE_UNKNOWN_OPTION');
  });
});
