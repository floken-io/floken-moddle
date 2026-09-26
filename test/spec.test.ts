import { describe, it, expect } from 'vitest';
import {
  BPMN_TYPES,
  BPMN_ABSTRACT_TYPES,
  DI_TYPES,
  ENUMERATIONS,
  DUPLICATE_TYPE_NAMES,
  SPEC_STATS,
  getSpec,
  resolveSpec,
  isAbstract,
  ancestorsOf,
  isSubtypeOf,
  effectiveProperties,
  xmlNameOf,
  typeNameOf,
  instantiableSpecs,
  EXECUTABLE_ELEMENTS,
  NON_EXECUTABLE_ELEMENTS,
  ALL_COVERED_ELEMENTS,
  COVERAGE_STATS,
  deriveExecutableTypeNames,
  familyOf,
  findCoverage,
  coverageOf,
  auditCoverage,
  coverageReport,
} from '../src/index.js';

describe('S0 · BPMN 类型表规模（钉死对外契约）', () => {
  it('语义层 137 类型 / 318 属性', () => {
    expect(SPEC_STATS.semanticTypes).toBe(137);
    expect(SPEC_STATS.semanticProperties).toBe(318);
  });

  it('图形交换层 24 类型 —— 与语义层分开记账，不得混进 137', () => {
    expect(SPEC_STATS.graphicTypes).toBe(24);
    expect(SPEC_STATS.totalTypes).toBe(161);
    // 图形层的 Graph types 必须能按 ns 拆开取
    expect(DI_TYPES.filter((t) => t.ns === 'bpmndi')).toHaveLength(6);
    expect(DI_TYPES.filter((t) => t.ns === 'di')).toHaveLength(11);
    expect(DI_TYPES.filter((t) => t.ns === 'dc')).toHaveLength(7);
  });

  it('abstract 清单与实际计算互为交叉校验', () => {
    expect(BPMN_ABSTRACT_TYPES).toHaveLength(17);
    expect(SPEC_STATS.abstractListLength).toBe(SPEC_STATS.semanticAbstract);
  });

  it('自有属性之和能从每个类型逐条加回 318', () => {
    const sum = BPMN_TYPES.reduce((n, t) => n + t.properties.length, 0);
    expect(sum).toBe(318);
  });
});

describe('S0 · isAbstract 裁定（过去把 SubProcess 误判成抽象，导致 26 算成 25）', () => {
  it('★ SubProcess **不是**抽象类型', () => {
    expect(isAbstract('SubProcess')).toBe(false);
    expect(getSpec('SubProcess')?.existsInXsd).toBeUndefined(); // XSD 里有 tSubProcess
  });

  it('★ Activity / FlowNode / Task 的抽象性', () => {
    expect(isAbstract('Activity')).toBe(true);
    expect(isAbstract('FlowNode')).toBe(true);
    expect(isAbstract('Task')).toBe(false);
    expect(isAbstract('UserTask')).toBe(false);
  });

  it('继承树符合 BPMN 规范', () => {
    // ⚠️ BPMN 是**多重继承**：Task 同时继承 Activity 与 InteractionNode（XSD 里没有 interactionNode，
    //    它是描述符为了复用聊天/message 相关 IIO 而引入的中间类型），所以祖先链里会出现它。
    expect(ancestorsOf('UserTask')).toEqual([
      'Task', 'Activity', 'InteractionNode', 'FlowNode', 'FlowElement', 'BaseElement',
    ]);
    expect(isSubtypeOf('UserTask', 'FlowNode')).toBe(true);
    expect(isSubtypeOf('UserTask', 'Activity')).toBe(true);
    expect(isSubtypeOf('UserTask', 'Gateway')).toBe(false);
    expect(isSubtypeOf('SubProcess', 'Activity')).toBe(true);
  });

  it('所有 superClass 引用都必须能解析到实体（悬空引用从这里开始炸）', () => {
    for (const t of [...BPMN_TYPES, ...DI_TYPES]) {
      for (const parent of t.superClass ?? []) {
        // 父类引用可能是裸名（同 ns）或 `ns:Name`（跨命名空间，如 bpmndi:BPMNDiagram → di:Diagram）
        const ref = parent.includes(':') ? parent : `${t.ns}:${parent}`;
        expect(resolveSpec(ref), `${t.name} 的父类 ${ref} 不存在`).toBeDefined();
      }
    }
  });

  it('★ 跨命名空间继承：bpmndi 层继承 di 层，祖先要带 ns 前缀', () => {
    expect(ancestorsOf('BPMNDiagram')).toEqual(['di:Diagram']);
    expect(getSpec('BPMNDiagram')?.superClass).toEqual(['di:Diagram']);
    // 属性展开必须能把 di:Diagram 那边的属性也带过来
    expect(effectiveProperties('BPMNDiagram').has('name')).toBe(true); // Diagram ↔ name
  });
});

/* ─────────────────────────────────────────────────────────────────
 * ★ 类型表一成型，「支持多少元素」就可以从数据算 —— 不再靠手列。
 *   下面这组断言把 `01-moddle` §5.1 的漏斗**逐个环节**算一遍。
 * ───────────────────────────────────────────────────────────────── */
describe('S0 · 从 137 到「可执行元素」的漏斗（全部由数据算出）', () => {
  const flowElements = BPMN_TYPES.filter(
    (t) => t.name !== 'FlowElement' && isSubtypeOf(t.name, 'FlowElement'),
  );

  it('FlowElement 的后代 = 37（与 §5.1 一致）', () => {
    expect(flowElements).toHaveLength(37);
  });

  it('★ 其中抽象 = 7 —— §5.1 旧版写的是 8 个，多算了 Task', () => {
    expect(flowElements.filter((t) => t.isAbstract).map((t) => t.name).sort()).toEqual([
      'Activity', 'CatchEvent', 'ChoreographyActivity', 'Event', 'FlowNode', 'Gateway', 'ThrowEvent',
    ]);
    // Task **不是**抽象 —— BPMN 里裸 <task> 本身就能出现在流程图上
    expect(isAbstract('Task')).toBe(false);
  });

  it('于是非抽象后代 = 30；减编排族 3 → 27', () => {
    const concrete = flowElements.filter((t) => !t.isAbstract);
    expect(concrete).toHaveLength(30);
    const choreo = concrete.filter((t) => isSubtypeOf(t.name, 'ChoreographyActivity'));
    expect(choreo.map((t) => xmlNameOf(t.name)).sort()).toEqual([
      'callChoreography', 'choreographyTask', 'subChoreography',
    ]);
    expect(concrete.length - choreo.length).toBe(27);
  });

  it('★ 裁决记录：旧文档手列 26，机器算出 27，差的正是裸 `task`（已裁决为 27）', () => {
    const oldDocList = [
      'startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent', 'implicitThrowEvent',
      'userTask', 'serviceTask', 'scriptTask', 'sendTask', 'receiveTask', 'manualTask', 'businessRuleTask',
      'exclusiveGateway', 'inclusiveGateway', 'parallelGateway', 'eventBasedGateway', 'complexGateway',
      'subProcess', 'adHocSubProcess', 'transaction', 'callActivity',
      'sequenceFlow', 'dataObject', 'dataObjectReference', 'dataStoreReference',
    ];
    expect(oldDocList).toHaveLength(26); // 旧版 §5.2 手列确实是 26
    const computed = deriveExecutableTypeNames().map(xmlNameOf);
    // 唯一差异 = 裸 task；且 docs 没有多列任何一个（手列永远是这种错误的方向）
    expect(computed.filter((n) => !oldDocList.includes(n))).toEqual(['task']);
    expect(oldDocList.filter((n) => !computed.includes(n))).toEqual([]);
  });
});

describe('S0 · 查询 API', () => {
  it('属性展开：子类覆盖父类，祖先的也要带上', () => {
    const props = effectiveProperties('UserTask');
    // 自有
    expect(props.get('implementation')?.isAttr).toBe(true);
    // 继承来的（Task.processRef? no —— BaseElement.id + FlowElement.name）
    expect(props.has('id')).toBe(true);
    expect(props.has('name')).toBe(true);
    // 展开后的总数必须大于自有数
    expect(props.size).toBeGreaterThan(getSpec('UserTask')!.properties.length);
  });

  it('重名类型：bpmn:Extension 与 di:Extension 同名不同源', () => {
    expect(DUPLICATE_TYPE_NAMES).toEqual(['Extension']);
    expect(getSpec('Extension')?.ns).toBe('bpmn');
    expect(getSpec('Extension', 'di')?.ns).toBe('di');
  });

  it('XML 名 ⇄ 类型名：JSON 的 type 必须等于 BPMN 元素名', () => {
    expect(xmlNameOf('UserTask')).toBe('userTask');
    expect(xmlNameOf('ExclusiveGateway')).toBe('exclusiveGateway');
    expect(typeNameOf('userTask')).toBe('UserTask');
    expect(typeNameOf('审批节点')).toBeUndefined();
  });

  it('可实例化类型 = 137 − 17', () => {
    expect(instantiableSpecs()).toHaveLength(120);
    expect(SPEC_STATS.semanticInstantiable).toBe(120);
  });

  it('枚举：11 个，含 ProcessType 与 GatewayDirection', () => {
    expect(SPEC_STATS.enumerations).toBe(11);
    expect(ENUMERATIONS['bpmn:ProcessType']).toContain('Private');
    expect(ENUMERATIONS['bpmn:GatewayDirection']).toContain('Diverging');
  });
});

/* ─────────────────────────────────────────────────────────────────
 * S1 · 元素覆盖与三层承诺（`01-moddle` §5）
 *   这张表是「我们支持多少元素」的单一事实源。它此前被手列错过两次（25 / 26），
 *   所以规矩改成：**集合由类型表推导、手工只声明层级、两边由 auditCoverage 钉死**。
 * ───────────────────────────────────────────────────────────────── */
describe('S1 · 元素覆盖表', () => {
  it('★ 自检必须干净（缺(~)任何一条都意味着有人在单改一边）', () => {
    expect(auditCoverage()).toEqual([]);
  });

  it('可执行 27 类 / 不可执行 21 类', () => {
    expect(COVERAGE_STATS.executable).toBe(27);
    expect(COVERAGE_STATS.nonExecutable).toBe(21);
    expect(COVERAGE_STATS.coveredTotal).toBe(48);
  });

  it('★ L2 是本包的承诺：登记元素一个都不能落下', () => {
    expect(ALL_COVERED_ELEMENTS.every((e) => e.l2)).toBe(true);
    expect(COVERAGE_STATS.l2Count).toBe(COVERAGE_STATS.coveredTotal);
  });

  it('按族汇总（这个数字就是对外报数的口径）', () => {
    const byFamily = new Map<string, number>();
    for (const e of EXECUTABLE_ELEMENTS) {
      byFamily.set(e.family, (byFamily.get(e.family) ?? 0) + 1);
    }
    expect(Object.fromEntries(byFamily)).toEqual({
      event: 6, task: 8, gateway: 5, activity: 4, flow: 1, data: 3,
    });
  });

  it('Task 族 = 8 —— 旧文档的 7 漏了裸 `task`', () => {
    expect(EXECUTABLE_ELEMENTS.filter((e) => e.family === 'task').map((e) => e.xmlName).sort())
      .toEqual([
        'businessRuleTask', 'manualTask', 'receiveTask', 'scriptTask',
        'sendTask', 'serviceTask', 'task', 'userTask',
      ]);
  });

  it('裸 task 已纳入且可执行：规范里它是「未指定类型的任务」，非抽象', () => {
    const task = coverageOf('task');
    expect(task.typeName).toBe('Task');
    expect(isAbstract('Task')).toBe(false);
    expect(task.l3).toBe(true); // 引擎按直通处理，成本≈0
  });

  it('familyOf 的判定顺序不能反：Task 也是 Activity 的后代', () => {
    expect(isSubtypeOf('UserTask', 'Activity')).toBe(true);
    expect(familyOf('UserTask')).toBe('task');
    expect(familyOf('SubProcess')).toBe('activity');
    expect(familyOf('SequenceFlow')).toBe('flow');
    expect(familyOf('ExclusiveGateway')).toBe('gateway');
    expect(familyOf('StartEvent')).toBe('event');
    expect(familyOf('DataObject')).toBe('data');
  });

  it('不可执行族：编排 / 会话 / 协作泳道 / 工件 各自认祖归宗', () => {
    const n = NON_EXECUTABLE_ELEMENTS.map((e) => e.xmlName);
    expect(n.filter((x) => ['choreography', 'globalChoreographyTask', 'choreographyTask', 'callChoreography', 'subChoreography'].includes(x))).toHaveLength(5);
    expect(coverageOf('choreographyTask').family).toBe('choreography');
    expect(coverageOf('conversation').family).toBe('conversation');
    expect(coverageOf('association').family).toBe('artifact');
    expect(coverageOf('participant').family).toBe('collaboration');
  });

  it('编排族三个成员的父类是 ChoreographyActivity —— 它们也是 FlowElement 后代，靠这条挖掉', () => {
    for (const x of ['choreographyTask', 'callChoreography', 'subChoreography']) {
      const t = typeNameOf(x)!;
      expect(isSubtypeOf(t, 'ChoreographyActivity')).toBe(true);
      expect(isSubtypeOf(t, 'FlowElement')).toBe(true);
      expect(deriveExecutableTypeNames()).not.toContain(t);
    }
  });

  it('不可执行的一律不是 L3', () => {
    expect(NON_EXECUTABLE_ELEMENTS.some((e) => e.l3)).toBe(false);
  });

  it('★ L3 = 22 类 —— 对外说「引擎能跑多少种」的唯一合法出处', () => {
    // 27 − 5 排除 = 22。排除清单必须以 `03-engine` FR-E11 为准：L3 由 engine 兑现，
    // 本表不替它做决定。改任何一档都要同步改 §5.3 与 03 FR-E11，否则三处分叉。
    expect(COVERAGE_STATS.l3Target).toBe(22);
    expect(NON_EXECUTABLE_ELEMENTS.filter((e) => e.l3)).toHaveLength(0);
    expect(EXECUTABLE_ELEMENTS.filter((e) => !e.l3).map((e) => e.xmlName).sort()).toEqual([
      'adHocSubProcess', 'complexGateway', 'eventBasedGateway', 'implicitThrowEvent', 'transaction',
    ]);
    // 不进 L3 的每一类都必须写明理由 —— 不许出现「忘了做」的空白
    for (const e of EXECUTABLE_ELEMENTS.filter((x) => !x.l3)) {
      expect(e.note, `${e.xmlName} 缺少非 L3 的理由`).toBeTruthy();
      expect(e.note).toMatch(/FR-E/); // 理由要能追到 engine 的功能项
    }
  });

  it('查不到的元素名与「未登记为图面元素」要区分开', () => {
    expect(findCoverage('userTask')?.typeName).toBe('UserTask');
    expect(findCoverage('不存在的元素')).toBeUndefined();
    // 存在但不在覆盖表里的类型（它们是辅助类型，不是图面元素）
    expect(typeNameOf('definitions')).toBe('Definitions');
    expect(findCoverage('definitions')).toBeUndefined();
    expect(() => coverageOf('不存在的元素')).toThrow(/未知的 BPMN 元素名/);
  });
});

describe('coverageReport（AC-S5 引用的对外 API）', () => {
  /**
   * 数字必须与 `COVERAGE_STATS` **同源**：报告是「现算」的，不是另存一份统计。
   * 手列统计正是「25 / 26 / 27」那场事故的病根。
   */
  it('与 COVERAGE_STATS 完全一致', () => {
    const r = coverageReport();
    expect(r.total).toBe(COVERAGE_STATS['coveredTotal']);
    expect(r.executable).toBe(COVERAGE_STATS['executable']);
    expect(r.nonExecutable).toBe(COVERAGE_STATS['nonExecutable']);
    expect(r.byLevel.L1).toBe(COVERAGE_STATS['l1Target']);
    expect(r.byLevel.L2).toBe(COVERAGE_STATS['l2Count']);
    expect(r.byLevel.L3).toBe(COVERAGE_STATS['l3Target']);
    // 登记元素 100% 承诺 L2（本包职责）
    expect(r.byLevel.L2).toBe(r.total);
    // 键名以代码为准：`SPEC_STATS.semanticTypes`（文档曾误写成 `types`）
    expect(r.specTotal).toBe(SPEC_STATS.semanticTypes);
  });

  it('l3Gaps 正是「可执行但不承诺执行」的那几类（27 − 22 = 5）', () => {
    const r = coverageReport();
    expect(r.l3Gaps).toEqual(
      EXECUTABLE_ELEMENTS.filter((e) => !e.l3).map((e) => e.xmlName),
    );
    expect(r.executable - r.byLevel.L3).toBe(r.l3Gaps.length);
    expect(r.l3Gaps).toEqual(
      expect.arrayContaining(['complexGateway', 'eventBasedGateway']),
    );
  });

  it('byFamily 汇总后总数守恒', () => {
    const r = coverageReport();
    const sum = Object.values(r.byFamily).reduce((a, b) => a + b.total, 0);
    expect(sum).toBe(r.total);
  });
});
