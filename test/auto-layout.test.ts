/**
 * `autoLayout()` / `ensureLayout()` 测试（§6 / AC-S7）
 *
 * 三条硬要求：**确定性**（同输入 10 次完全一致）、**不重叠**、**已有坐标不动**。
 * 确定性靠「一切集合先按 id 排序、不含随机数与时间戳」保证 —— 这里用 10 次重跑把它钉死。
 *
 * ★ v2 起结果是扁平字典（`layout.nodes` / `layout.edges`），不再有 `planes[]`。
 */

import { describe, expect, it } from 'vitest';

import type { ProcessDefinition } from '../src/model/definition.js';
import { MODEL_SCHEMA_VERSION, validateDefinition } from '../src/model/definition.js';
import { autoLayout, ensureLayout } from '../src/layout/auto-layout.js';

function model(): ProcessDefinition {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: 'def_1',
    nodes: [
      { id: 'S', type: 'startEvent' },
      { id: 'T1', type: 'userTask', name: '审批' },
      { id: 'T2', type: 'userTask', name: '复核' },
      {
        id: 'Sub',
        type: 'subProcess',
        nodes: [
          { id: 'I1', type: 'startEvent' },
          { id: 'I2', type: 'userTask' },
        ],
        flows: [{ id: 'IF', from: 'I1', to: 'I2' }],
      },
      { id: 'G', type: 'exclusiveGateway' },
      { id: 'E', type: 'endEvent' },
      { id: 'B1', type: 'boundaryEvent', attachedTo: 'T1' },
    ],
    flows: [
      { id: 'F1', from: 'S', to: 'T1' },
      { id: 'F2', from: 'T1', to: 'T2' },
      { id: 'F3', from: 'T2', to: 'Sub' },
      { id: 'F4', from: 'Sub', to: 'G' },
      { id: 'F5', from: 'G', to: 'E' },
      { id: 'F6', from: 'G', to: 'T1' }, // 回边
    ],
  };
}

describe('autoLayout（§6）', () => {
  it('★ 确定性：同输入 10 次结果完全一致（AC-S7）', () => {
    const first = autoLayout(model());
    for (let i = 0; i < 10; i += 1) {
      expect(autoLayout(model())).toEqual(first);
    }
  });

  it('★ 产出扁平字典：有 nodes / edges，没有 planes', () => {
    const out = autoLayout(model());
    expect(out.nodes).toBeDefined();
    expect(out.edges).toBeDefined();
    expect((out as Record<string, unknown>)['planes']).toBeUndefined();
  });

  it('所有节点都有坐标（含子流程内层与边界事件）', () => {
    const out = autoLayout(model());
    for (const id of ['S', 'T1', 'T2', 'Sub', 'G', 'E', 'B1', 'I1', 'I2']) {
      const box = out.nodes?.[id];
      expect(box, id).toBeDefined();
      expect(typeof box?.x).toBe('number');
      expect(typeof box?.y).toBe('number');
    }
  });

  it('所有连线至少有 2 个折点', () => {
    const out = autoLayout(model());
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']) {
      expect((out.edges?.[id]?.length ?? 0), id).toBeGreaterThanOrEqual(2);
    }
  });

  it('★ 不重叠：顶层节点两两不相交', () => {
    const out = autoLayout(model());
    const boxes = ['S', 'T1', 'T2', 'Sub', 'G', 'E'].map((id) => out.nodes?.[id]!);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap =
          a.x < b.x + (b.width ?? 0) &&
          b.x < a.x + (a.width ?? 0) &&
          a.y < b.y + (b.height ?? 0) &&
          b.y < a.y + (a.height ?? 0);
        expect(overlap, `${i}×${j} 重叠`).toBe(false);
      }
    }
  });

  it('子流程内层坐标落在子流程框内', () => {
    const out = autoLayout(model());
    const sub = out.nodes?.['Sub']!;
    const inner = out.nodes?.['I2']!;
    expect(inner.x).toBeGreaterThanOrEqual(sub.x);
    expect(inner.y).toBeGreaterThanOrEqual(sub.y);
    expect(inner.x).toBeLessThanOrEqual(sub.x + (sub.width ?? 0));
  });

  it('★ 从左到右：起点在最左、终点在最右', () => {
    const out = autoLayout(model());
    expect(out.nodes?.['S']!.x).toBeLessThan(out.nodes?.['T1']!.x);
    expect(out.nodes?.['T1']!.x).toBeLessThan(out.nodes?.['T2']!.x);
  });

  it('坐标取整到 1 位小数（浮点累加噪声会让往返比对失败）', () => {
    const out = autoLayout(model());
    for (const box of Object.values(out.nodes ?? {})) {
      expect(box.x * 10).toBe(Math.round(box.x * 10));
      expect(box.y * 10).toBe(Math.round(box.y * 10));
    }
  });

  /**
   * ★ 钉死一个真 bug（2026-10-06）：
   * `validateLayout` 只收到**节点 id 集**，却拿它去比对 `layout.edges` 的键 ——
   * 而 `layout.edges` 的键是 **flow id**。结果：**任何写了坐标的边都被误报成悬空引用**，
   * 也就是说 `autoLayout()` 自己产出的坐标，回填进定义后**自己校验不过**。
   *
   * 修法：`validateLayout` 新增 `knownEdgeIds`（与 `knownIds` 分开），
   * `validateDefinition` 递归收齐 flow id 后传入。
   */
  it('★ autoLayout 产出的坐标回填进定义后，校验零诊断（自己生成的自己能过）', () => {
    const def = model();
    const withLayout: ProcessDefinition = { ...def, layout: autoLayout(def) };

    // 先确认回填的确实有边坐标（否则这条测试会变成空转）
    expect(Object.keys(withLayout.layout?.edges ?? {}).length).toBeGreaterThan(0);

    const diags = validateDefinition(withLayout);
    expect(diags).toEqual([]);
  });

  it('★ layout.edges 指向不存在的 flow → warn；指向真实 flow → 不报（含子流程内的边）', () => {
    const def = model();
    // 'F1' 是顶层连线，'IF' 是 subProcess **内嵌**的连线 —— 两者都必须是合法引用目标
    const good = validateDefinition({
      ...def,
      layout: {
        edges: {
          F1: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
          IF: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        },
      },
    });
    expect(good).toEqual([]);

    const bad = validateDefinition({
      ...def,
      layout: { edges: { Flow_nope: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } },
    });
    expect(bad.filter((d) => d.code === 'MODDLE_VALIDATE_DANGLING_REF')).toHaveLength(1);
  });
});

describe('ensureLayout（§6 规则一：已有坐标不动）', () => {
  it('完全没有 layout → 全量生成', () => {
    const def = model();
    const out = ensureLayout(def);
    expect(Object.keys(out.nodes ?? {}).length).toBeGreaterThan(0);
  });

  it('★ 已有的坐标**一个都不动**（绝不重排用户的图）', () => {
    const def = model();
    def.layout = { nodes: { T1: { x: 999, y: 888 } }, edges: {} };
    const out = ensureLayout(def);
    expect(out.nodes?.['T1']).toEqual({ x: 999, y: 888 });
  });

  it('只补缺失的：给了 T1，其余仍由算法补出', () => {
    const def = model();
    def.layout = { nodes: { T1: { x: 999, y: 888 } }, edges: {} };
    const out = ensureLayout(def);
    expect(out.nodes?.['T1']).toEqual({ x: 999, y: 888 });
    expect(out.nodes?.['T2']).toBeDefined();
    expect(out.nodes?.['T2']?.x).not.toBe(999);
  });
});
