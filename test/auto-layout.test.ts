/**
 * `autoLayout()` / `ensureLayout()` 测试（§8 / AC-S7）
 *
 * 三条硬要求：**确定性**（同输入 10 次完全一致）、**不重叠**、**能被标准工具渲染**。
 * 确定性靠「一切集合先按 id 排序、不含随机数与时间戳」保证 —— 这里用 10 次重跑把它钉死。
 */

import { describe, expect, it } from 'vitest';

import type { ProcessDefinition } from '../src/model/definition.js';
import { LAYOUT_METRICS, autoLayout, ensureLayout } from '../src/layout/auto-layout.js';
import { toXmlSync } from '../src/xml/to-xml.js';
import { fromXmlSync } from '../src/xml/from-xml.js';

function model(): ProcessDefinition {
  return {
    schemaVersion: '1.0.0',
    id: 'Definitions_1',
    processes: [
      {
        id: 'Process_1',
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
        ],
      },
    ],
  };
}

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

describe('autoLayout · 确定性（AC-S7）', () => {
  it('★ 同输入跑 10 次，结果逐字节一致', () => {
    const first = JSON.stringify(autoLayout(model()));
    for (let i = 0; i < 10; i += 1) {
      expect(JSON.stringify(autoLayout(model()))).toBe(first);
    }
  });

  it('★ 打乱输入顺序不影响结果（排序按 id，不按输入顺序）', () => {
    const m = model();
    const proc = m.processes[0]!;
    proc.nodes = [...proc.nodes].reverse();
    proc.flows = [...proc.flows].reverse();
    const a = JSON.stringify(autoLayout(m));
    proc.nodes = [...proc.nodes].reverse();
    proc.flows = [...proc.flows].reverse();
    expect(a).toBe(JSON.stringify(autoLayout(m)));
  });

  it('导出→导入→再导出的 DI 完全一致（坐标也是确定性的）', () => {
    const xml = toXmlSync(model());
    expect(toXmlSync(fromXmlSync(xml))).toBe(xml);
  });
});

describe('autoLayout · 几何', () => {
  const layout = autoLayout(model());
  const shapes = layout.planes[0]!.shapes;

  it('每个节点都有坐标，尺寸取自默认表', () => {
    expect(Object.keys(shapes).sort()).toEqual(['B1', 'E', 'G', 'I1', 'I2', 'S', 'Sub', 'T1', 'T2']);
    expect(shapes['S']).toMatchObject({ width: 36, height: 36 });
    expect(shapes['G']).toMatchObject({ width: 50, height: 50 });
    expect(shapes['T1']).toMatchObject({ width: 100, height: 80 });
  });

  it('★ 起点固定在 LAYOUT_METRICS 的原点', () => {
    expect(shapes['S']!.x).toBe(LAYOUT_METRICS.originX);
  });

  it('★ 非边界节点两两不重叠', () => {
    const mains = Object.entries(shapes).filter(([id]) => id !== 'B1');
    for (let i = 0; i < mains.length; i += 1) {
      for (let j = i + 1; j < mains.length; j += 1) {
        const a = mains[i]!;
        const b = mains[j]!;
        // 子流程与其内部节点是包含关系，跳过
        const nested = a[0] === 'Sub' || b[0] === 'Sub';
        if (nested) continue;
        expect(overlaps(a[1] as Box, b[1] as Box), `${a[0]} 与 ${b[0]} 重叠`).toBe(false);
      }
    }
  });

  it('★ 左→右分层：后继一定在前驱右边', () => {
    expect(shapes['T1']!.x).toBeGreaterThan(shapes['S']!.x);
    expect(shapes['T2']!.x).toBeGreaterThan(shapes['T1']!.x);
    expect(shapes['Sub']!.x).toBeGreaterThan(shapes['T2']!.x);
    expect(shapes['G']!.x).toBeGreaterThan(shapes['Sub']!.x);
    expect(shapes['E']!.x).toBeGreaterThan(shapes['G']!.x);
  });

  it('★ 子流程：内层带 parentId 且完全落在宿主盒子内', () => {
    const host = shapes['Sub']!;
    for (const id of ['I1', 'I2']) {
      const inner = shapes[id]!;
      expect(inner.parentId).toBe('Sub');
      expect(inner.x).toBeGreaterThanOrEqual(host.x);
      expect(inner.y).toBeGreaterThanOrEqual(host.y);
      expect(inner.x + inner.width).toBeLessThanOrEqual(host.x + host.width);
      expect(inner.y + inner.height).toBeLessThanOrEqual(host.y + host.height);
    }
    expect(host.isExpanded).toBe(true);
  });

  it('★ 边界事件贴在宿主底边、水平居中', () => {
    const host = shapes['T1']!;
    const b = shapes['B1']!;
    expect(b.x + b.width / 2).toBeCloseTo(host.x + host.width / 2, 6);
    expect(b.y + b.height / 2).toBeCloseTo(host.y + host.height, 6);
  });
});

describe('autoLayout · 连线', () => {
  const layout = autoLayout(model());
  const edges = layout.planes[0]!.edges;

  it('每条连线至少两个 waypoint', () => {
    expect(Object.keys(edges).sort()).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'IF']);
    for (const e of Object.values(edges)) expect(e.waypoints.length).toBeGreaterThanOrEqual(2);
  });

  it('起点贴源节点右边、终点贴目标节点左边', () => {
    const shapes = layout.planes[0]!.shapes;
    const f1 = edges['F1']!;
    expect(f1.waypoints[0]!.x).toBeCloseTo(shapes['S']!.x + shapes['S']!.width, 6);
    expect(f1.waypoints[f1.waypoints.length - 1]!.x).toBeCloseTo(shapes['T1']!.x, 6);
  });

  it('坐标取整到 1 位小数（不留浮点噪声）', () => {
    for (const s of Object.values(layout.planes[0]!.shapes)) {
      for (const v of [s.x, s.y]) expect(Number.isInteger(v * 10)).toBe(true);
    }
  });
});

describe('autoLayout · 边界情况', () => {
  it('空 process 不崩，产出空 plane', () => {
    const l = autoLayout({
      schemaVersion: '1.0.0',
      id: 'D',
      processes: [{ id: 'P', nodes: [], flows: [] }],
    });
    expect(l.planes).toHaveLength(1);
    expect(l.planes[0]!.shapes).toEqual({});
  });

  it('成环的脏模型不崩，且仍然确定', () => {
    const m: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D',
      processes: [
        {
          id: 'P',
          nodes: [
            { id: 'A', type: 'userTask' },
            { id: 'B', type: 'userTask' },
          ],
          flows: [
            { id: 'F1', from: 'A', to: 'B' },
            { id: 'F2', from: 'B', to: 'A' },
          ],
        },
      ],
    };
    const a = JSON.stringify(autoLayout(m));
    expect(a).toBe(JSON.stringify(autoLayout(m)));
    expect(Object.keys(autoLayout(m).planes[0]!.shapes).sort()).toEqual(['A', 'B']);
  });

  it('入参不是定义 → 抛错', () => {
    expect(() => autoLayout({} as never)).toThrow();
  });

  /*
   * ★ 回边会让最长路径分层**跳层**（A=0、C=2、B=3，中间没有 1）。
   * 早先按 `layers[depth]` 直接当下标用，数组成了稀疏数组，
   * `layer.map(...)` 直接炸 `Cannot read properties of undefined`
   * —— MIWG 的 C.1.0 / C.1.1 / C.2.0 / C.4.0 / C.7.0 第一刀就砍在这里。
   */
  it('★ 回边造成的「跳层」不崩（分层必须是连续数组）', () => {
    const m: ProcessDefinition = {
      schemaVersion: '1.0.0',
      id: 'D',
      processes: [
        {
          id: 'P',
          nodes: [
            { id: 'A', type: 'startEvent' },
            { id: 'B', type: 'userTask' },
            { id: 'C', type: 'userTask' },
          ],
          flows: [
            { id: 'F1', from: 'A', to: 'B' },
            { id: 'F2', from: 'B', to: 'C' },
            { id: 'F3', from: 'C', to: 'B' }, // 回边
          ],
        },
      ],
    };
    const l = autoLayout(m);
    const shapes = l.planes[0]!.shapes;
    expect(Object.keys(shapes).sort()).toEqual(['A', 'B', 'C']);
    for (const s of Object.values(shapes)) {
      expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
    }
  });
});

/*
 * 口径：**没有 layout 才生成；有 layout 就一字不改地用。**
 *
 * 改成这样是第二十道门禁（跨解析器结构比对）逼出来的，两条实打实的证据：
 *   ① 追加成多余的图 —— plane 是以 **process** 为 `bpmnElement` 生成的，
 *      而别人的文件里 plane 常挂在 **collaboration** 上，对不上就整份追加：
 *      MIWG A.4.0 原 1 张图，转一圈变 3 张。
 *   ② 给作者没画的元素补框（`dataObject` …）—— 每一家 parser 都看得出文件被加工过。
 * 所以不再合并，只保留"从零布局"这一条路径。
 */
describe('ensureLayout · 有则原样，无则生成', () => {
  it('没有 layout 时整体生成', () => {
    const m = model();
    expect(ensureLayout(m)).toEqual(autoLayout(m));
  });

  it('planes 为空数组时也算"没有"，照旧整体生成', () => {
    const m = model();
    m.layout = { planes: [] };
    expect(ensureLayout(m).planes.length).toBe(autoLayout(m).planes.length);
  });

  it('★ 已有 layout 一字不改：既不动已摆的坐标，也不给没摆的元素补框', () => {
    const m = model();
    m.layout = {
      planes: [
        {
          id: 'Process_1_plane',
          elementId: 'Process_1',
          shapes: { T1: { x: 999, y: 888, width: 100, height: 80 } },
          edges: {},
        },
      ],
    };
    const l = ensureLayout(m);
    expect(l.planes.length).toBe(1); // 没有多出来的自动布局图
    expect(l.planes[0]!.shapes['T1']).toMatchObject({ x: 999, y: 888 });
    // 作者没摆的元素**不替他摆**（缺少坐标应由调用方显式调用 autoLayout 决定）
    expect(l.planes[0]!.shapes['S']).toBeUndefined();
  });

  it('自定义 plane 原样保留，且不夹带 process 的自动布局 plane', () => {
    const m = model();
    m.layout = {
      planes: [{ id: 'custom', elementId: 'Other_Process', shapes: {}, edges: {} }],
    };
    const ids = ensureLayout(m).planes.map((p) => p.elementId);
    expect(ids).toEqual(['Other_Process']);
  });

  it('★ 幂等：自己的导出再导一次，plan 数与 shape 数都不变', () => {
    const m = model();
    const once = ensureLayout(m);
    const twice = ensureLayout({ ...m, layout: once });
    expect(twice).toEqual(once);
  });
});
