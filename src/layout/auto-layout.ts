/**
 * ★ `autoLayout()` —— 确定性自动布局（§8 / AC-S7）
 *
 * 三条要求：**确定性**（同输入 10 次结果完全一致）、**不重叠**、**能被标准工具渲染**。
 *
 * 算法刻意选最笨的「分层 + 堆叠」：
 * - 分层：**最长路径**分层（节点深度 = 前驱最大深度 + 1），方向左→右，与 BPMN 惯例一致；
 * - 层内：按 **id 排序**堆叠（不按输入顺序 —— 顺序是偶然的，id 是模型的一部分）；
 * - 跨层：列宽取该层最宽节点，行高按实际尺寸累加，最后各层**垂直居中**对齐。
 *
 * ★ 确定性靠两条纪律保证，改代码时别破：
 * 1. **一切集合先按 id 排序再遍历**，不依赖 `Map` / 对象键的偶然顺序；
 * 2. **不含随机数、不含 `Date.now()`、不含 `Math.random()`** —— 纯函数。
 *
 * 子流程：内层**先**递归量出尺寸（外层据此把盒子撑大），再直接落位成**绝对坐标**。
 * 边界事件不参与分层（它没有独立的拓扑位置，必须贴着宿主）。
 *
 * ★ v2 起产出**扁平字典**（`layout.nodes` / `layout.edges`），不再是 BPMN DI 的 `planes[]`
 * —— `plane` 是「一张图一个图层」的 DI 概念，JSON-only 后没有对应需求（§4.6）。
 */

import type { Flow, FlowNode, ProcessDefinition } from '../model/definition.js';
import type { Layout, NodeLayout, Point } from '../model/layout.js';

/** 每类元素的默认几何尺寸（设计器 palette 与自动布局共用同一张表） */
export const DEFAULT_NODE_SIZE: Readonly<Record<string, { width: number; height: number }>> =
  Object.freeze({
    // 事件：规范图标一律 36×36
    startEvent: { width: 36, height: 36 },
    endEvent: { width: 36, height: 36 },
    intermediateCatchEvent: { width: 36, height: 36 },
    intermediateThrowEvent: { width: 36, height: 36 },
    implicitThrowEvent: { width: 36, height: 36 },
    boundaryEvent: { width: 36, height: 36 },
    // 网关：菱形 50×50
    exclusiveGateway: { width: 50, height: 50 },
    inclusiveGateway: { width: 50, height: 50 },
    parallelGateway: { width: 50, height: 50 },
    eventBasedGateway: { width: 50, height: 50 },
    complexGateway: { width: 50, height: 50 },
    // 容器：默认展开态
    subProcess: { width: 350, height: 200 },
    adHocSubProcess: { width: 350, height: 200 },
    transaction: { width: 350, height: 200 },
    callActivity: { width: 100, height: 80 },
    // 任务
    task: { width: 100, height: 80 },
    userTask: { width: 100, height: 80 },
    serviceTask: { width: 100, height: 80 },
    scriptTask: { width: 100, height: 80 },
    sendTask: { width: 100, height: 80 },
    receiveTask: { width: 100, height: 80 },
    manualTask: { width: 100, height: 80 },
    businessRuleTask: { width: 100, height: 80 },
    // 数据
    dataObject: { width: 36, height: 50 },
    dataObjectReference: { width: 36, height: 50 },
    dataStoreReference: { width: 50, height: 50 },
  });

/** 未登记类型的兜底尺寸 */
export const FALLBACK_NODE_SIZE: Readonly<{ width: number; height: number }> = Object.freeze({
  width: 100,
  height: 80,
});

/** 起点、列间距、行间距、子流程内边距 */
export const LAYOUT_METRICS = Object.freeze({
  originX: 150,
  originY: 100,
  gapX: 80,
  gapY: 40,
  padX: 30,
  padY: 30,
  /** 回边（target 在 source 左边）绕行时下沉的距离 */
  backEdgeDrop: 30,
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 所属容器（子流程内元素才有） */
  parent?: string;
}

function sizeOf(type: string): { width: number; height: number } {
  return DEFAULT_NODE_SIZE[type] ?? FALLBACK_NODE_SIZE;
}

/** 容器类型（能装 nodes/flows 的） */
const CONTAINER_TYPES: readonly string[] = Object.freeze([
  'subProcess',
  'adHocSubProcess',
  'transaction',
]);

function isContainer(node: FlowNode): boolean {
  return CONTAINER_TYPES.includes(node.type) && (node.nodes?.length ?? 0) > 0;
}

function isBoundary(node: FlowNode): boolean {
  return node.type === 'boundaryEvent';
}

/** id 升序 —— 所有遍历都先过它，是确定性的根 */
function sortedById(nodes: readonly FlowNode[]): FlowNode[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ─────────────────────────────────────────────────────────────────
// 量尺寸（递归：容器的尺寸由内层撑大）
// ─────────────────────────────────────────────────────────────────

const measureCache = new WeakMap<FlowNode, { width: number; height: number }>();

function measure(node: FlowNode): { width: number; height: number } {
  const cached = measureCache.get(node);
  if (cached) return cached;
  const base = sizeOf(node.type);
  let out = base;
  if (isContainer(node)) {
    const inner = arrange(node.nodes ?? [], node.flows ?? []);
    out = {
      width: Math.max(base.width, inner.width + 2 * LAYOUT_METRICS.padX),
      height: Math.max(base.height, inner.height + 2 * LAYOUT_METRICS.padY),
    };
  }
  measureCache.set(node, out);
  return out;
}

// ─────────────────────────────────────────────────────────────────
// 分层排布（相对坐标，返回包围盒）
// ─────────────────────────────────────────────────────────────────

interface Arrangement {
  /** 相对 (0,0) 的位置 */
  pos: Map<string, Box>;
  width: number;
  height: number;
}

function arrange(nodes: readonly FlowNode[], flows: readonly Flow[]): Arrangement {
  const main = sortedById(nodes).filter((n) => !isBoundary(n));
  const boundaries = sortedById(nodes).filter(isBoundary);
  const pos = new Map<string, Box>();
  if (main.length === 0) {
    return { pos, width: 0, height: 0 };
  }

  const ids = main.map((n) => n.id);
  const idSet = new Set(ids);
  const index = new Map(ids.map((id, i) => [id, i]));

  // 只统计两端都在本层的连线（跨容器的连线不参与本层排布）
  const inDegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const f of flows) {
    if (!idSet.has(f.from) || !idSet.has(f.to) || f.from === f.to) continue;
    inDegree.set(f.to, (inDegree.get(f.to) ?? 0) + 1);
    succ.get(f.from)?.push(f.to);
  }
  // ★ 后继去重后排序：邻接表有序 → 整个算法与输入顺序无关
  for (const [id, list] of succ) succ.set(id, [...new Set(list)].sort());

  // 最长路径分层（Kahn；不可达的环内节点在收尾阶段按 id 顺序补到最后一列之后）
  const depth = new Map<string, number>();
  const ready = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const pending = new Set(ids);
  while (ready.length) {
    const id = ready.shift() as string;
    pending.delete(id);
    const d = depth.get(id) ?? 0;
    for (const to of succ.get(id) ?? []) {
      const next = Math.max(depth.get(to) ?? 0, d + 1);
      depth.set(to, next);
      const left = (inDegree.get(to) ?? 0) - 1;
      inDegree.set(to, left);
      if (left === 0) ready.push(to);
    }
  }
  // 收尾：环里的节点（模型不该有，但脏模型存在）按 id 顺序排在最后
  let maxDepth = -1;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  for (const id of [...pending].sort()) {
    maxDepth += 1;
    depth.set(id, maxDepth);
  }

  /*
   * 分层（层内按 id，main 已排好序）。
   *
   * ★ **不能用 `layers[depth] = …` 直接当下标用**：最长路径分层会**跳层**
   * （一条长链旁边挂个短分支时，中间某一层可能一个节点都没有），
   * 数组就成了稀疏数组，`for...of` 遍历会拿到 `undefined`，
   * 后面 `layer.map(...)` 直接 `Cannot read properties of undefined`
   * —— MIWG 真实语料（C.1.0 / C.2.0 / C.4.0 …）第一刀就砍在这里。
   * 先按 depth 收进 Map，再按 depth 排序摊成**连续**数组。
   */
  const byDepth = new Map<number, FlowNode[]>();
  for (const n of main) {
    const d = depth.get(n.id) ?? 0;
    const list = byDepth.get(d) ?? [];
    list.push(n);
    byDepth.set(d, list);
  }
  const layers: FlowNode[][] = [...byDepth.keys()]
    .sort((a, b) => a - b)
    .map((d) => byDepth.get(d) as FlowNode[]);

  // 列 x：前一列最宽 + 间距
  const colX: number[] = [];
  let x = 0;
  for (const layer of layers) {
    colX.push(x);
    x += Math.max(...layer.map((n) => measure(n).width)) + LAYOUT_METRICS.gapX;
  }

  // 行 y：层内堆叠，再按最高层垂直居中
  const layerHeights = layers.map((layer) =>
    layer.reduce((h, n) => h + measure(n).height, 0) + LAYOUT_METRICS.gapY * (layer.length - 1),
  );
  const maxH = Math.max(...layerHeights);
  layers.forEach((layer, d) => {
    const x0 = colX[d] ?? 0;
    let y = (maxH - (layerHeights[d] ?? 0)) / 2;
    for (const n of layer) {
      const { width, height } = measure(n);
      pos.set(n.id, { x: x0, y, width, height });
      y += height + LAYOUT_METRICS.gapY;
    }
  });

  let width = 0;
  let height = maxH;
  layers.forEach((layer, d) => {
    const x0 = colX[d] ?? 0;
    for (const n of layer) width = Math.max(width, x0 + measure(n).width);
  });

  // 边界事件贴宿主底边；没有宿主（模型不合法）时排到包围盒下方
  boundaries.forEach((n, i) => {
    const { width: w, height: h } = measure(n);
    const host = n.attachedTo ? pos.get(n.attachedTo) : undefined;
    if (host) {
      const group = boundaries.filter((b) => b.attachedTo === n.attachedTo);
      const gi = group.findIndex((b) => b.id === n.id);
      const spread = (gi - (group.length - 1) / 2) * (w + 8);
      pos.set(n.id, {
        x: host.x + host.width / 2 - w / 2 + spread,
        y: host.y + host.height - h / 2,
        width: w,
        height: h,
      });
    } else {
      pos.set(n.id, { x: i * (w + 8), y: height + LAYOUT_METRICS.gapY, width: w, height: h });
      height = Math.max(height, height + LAYOUT_METRICS.gapY + h);
    }
  });

  return { pos, width, height };
}

// ─────────────────────────────────────────────────────────────────
// 落位（递归进子流程）
// ─────────────────────────────────────────────────────────────────

function place(
  nodes: readonly FlowNode[],
  flows: readonly Flow[],
  ox: number,
  oy: number,
  parentId: string | undefined,
  sink: Map<string, Box>,
): void {
  const { pos } = arrange(nodes, flows);
  for (const [id, box] of pos) {
    const placed: Box = { ...box, x: box.x + ox, y: box.y + oy };
    if (parentId) placed.parent = parentId;
    sink.set(id, placed);
  }
  for (const n of nodes) {
    if (!isContainer(n)) continue;
    const box = pos.get(n.id);
    if (!box) continue;
    place(
      n.nodes ?? [],
      n.flows ?? [],
      ox + box.x + LAYOUT_METRICS.padX,
      oy + box.y + LAYOUT_METRICS.padY,
      n.id,
      sink,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 连线
// ─────────────────────────────────────────────────────────────────

function edgeOf(from: Box | undefined, to: Box | undefined): { x: number; y: number }[] {
  if (!from || !to) return [];
  const start = { x: from.x + from.width, y: from.y + from.height / 2 };
  const end = { x: to.x, y: to.y + to.height / 2 };
  if (end.x >= start.x - 1) return [start, end];
  // 回边：从下方绕过去，避免连线压在节点上
  const y = Math.max(from.y + from.height, to.y + to.height) + LAYOUT_METRICS.backEdgeDrop;
  return [start, { x: start.x, y }, { x: end.x, y }, end];
}

// ─────────────────────────────────────────────────────────────────
// 对外 API
// ─────────────────────────────────────────────────────────────────

/**
 * 给整份定义补出 `layout`（§6）。
 *
 * 三条规则（§6 表）：
 * - **已有坐标的节点不动** —— 这是 {@link ensureLayout} 的事，本函数是"从零铺一遍"；
 * - 分层方向**从左到右**（中式审批流的阅读习惯）；
 * - 网关分叉对称（分支按出线数均分纵向空间 —— 由层内堆叠 + 垂直居中自然达成）。
 */
export function autoLayout(def: ProcessDefinition): Layout {
  if (!def || typeof def !== 'object' || !Array.isArray(def.nodes)) {
    throw new Error('autoLayout: definition must be a ProcessDefinition');
  }

  const sink = new Map<string, Box>();
  place(def.nodes, def.flows, LAYOUT_METRICS.originX, LAYOUT_METRICS.originY, undefined, sink);

  const nodes: Record<string, NodeLayout> = {};
  for (const [id, box] of [...sink.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    nodes[id] = { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
  }

  const edges: Record<string, Point[]> = {};
  const containers = [{ nodes: def.nodes, flows: def.flows }, ...walkContainers(def.nodes)];
  for (const container of containers) {
    for (const f of container.flows) {
      const wps = edgeOf(sink.get(f.from), sink.get(f.to));
      if (wps.length === 0) continue;
      edges[f.id] = wps.map((p) => ({ x: round(p.x), y: round(p.y) }));
    }
  }

  return { nodes: sortRecord(nodes), edges: sortRecord(edges) };
}

/**
 * 「缺哪补哪」的入口：已有坐标的**一个都不动**，只补缺失的（§6 规则一）。
 *
 * ⚠️ **绝不重排用户的图** —— 静默改写排版资产比"某元素没有坐标"严重得多。
 * 要全量重铺请显式调用 {@link autoLayout}。
 */
export function ensureLayout(def: ProcessDefinition): Layout {
  const existing = def.layout;
  const hasAny = (existing?.nodes !== undefined && Object.keys(existing.nodes).length > 0)
    || (existing?.edges !== undefined && Object.keys(existing.edges).length > 0);
  if (!hasAny) return autoLayout(def);

  const generated = autoLayout(def);
  const nodes: Record<string, NodeLayout> = { ...(generated.nodes ?? {}) };
  for (const [id, box] of Object.entries(existing?.nodes ?? {})) nodes[id] = box;
  const edges: Record<string, Point[]> = { ...(generated.edges ?? {}) };
  for (const [id, wps] of Object.entries(existing?.edges ?? {})) edges[id] = wps;

  return { nodes: sortRecord(nodes), edges: sortRecord(edges) };
}

// ─────────────────────────────────────────────────────────────────

/** 坐标取整到 1 位小数 —— 浮点累加会产出 `150.00000000000003` 这种噪声，往返比对会被它坑 */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function sortRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k] as T;
  return out;
}

/** 递归列出所有带 flows 的容器（顶层 + 子流程） */
function walkContainers(nodes: readonly FlowNode[]): { nodes: FlowNode[]; flows: Flow[] }[] {
  const out: { nodes: FlowNode[]; flows: Flow[] }[] = [];
  const walk = (list: readonly FlowNode[]): void => {
    for (const n of list) {
      if (!n.nodes?.length) continue;
      out.push({ nodes: n.nodes, flows: n.flows ?? [] });
      walk(n.nodes);
    }
  };
  walk(nodes);
  return out;
}
