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
 * 子流程：内层**先**递归量出尺寸（外层据此把盒子撑大），再按 `parentId` 写回扁平 map。
 * 边界事件不参与分层（它没有独立的拓扑位置，必须贴着宿主）。
 */

import type { Flow, FlowNode, Lane, ProcessDefinition } from '../model/definition.js';
import type { EdgeLayout, Layout, PlaneLayout, ShapeLayout } from '../model/layout.js';

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
// 泳道 / 池的图形
// ─────────────────────────────────────────────────────────────────

/** 泳道矩形在其内容之外的留白；池再外扩一圈；池左侧标签区宽度 */
const LANE_MARGIN = 20;
const POOL_MARGIN = 10;
const POOL_LABEL_WIDTH = 30;

/** 一条泳道名下的**全部**节点 id（含嵌套子泳道） */
function laneNodeIds(lane: Lane): string[] {
  const out: string[] = [...(lane.nodeIds ?? [])];
  for (const child of lane.lanes ?? []) out.push(...laneNodeIds(child));
  return out;
}

/** 若干矩形的并集；全空则 undefined */
function unionOf(boxes: (Box | undefined)[]): Box | undefined {
  let r: Box | undefined;
  for (const b of boxes) {
    if (!b) continue;
    r = r
      ? {
          x: Math.min(r.x, b.x),
          y: Math.min(r.y, b.y),
          width:
            Math.max(r.x + r.width, b.x + b.width) - Math.min(r.x, b.x),
          height:
            Math.max(r.y + r.height, b.y + b.height) - Math.min(r.y, b.y),
        }
      : { ...b };
  }
  return r;
}

const unionOfBoxes = (boxes: readonly Box[]): Box | undefined => unionOf([...boxes]);

function padded(box: Box | undefined, m: number): Box | undefined {
  if (!box) return undefined;
  return { x: box.x - m, y: box.y - m, width: box.width + 2 * m, height: box.height + 2 * m };
}

const boxToShape = (b: Box): ShapeLayout => ({
  x: round(b.x),
  y: round(b.y),
  width: round(b.width),
  height: round(b.height),
});

// ─────────────────────────────────────────────────────────────────
// 对外 API
// ─────────────────────────────────────────────────────────────────

/**
 * 给整份定义补出 `layout`。
 *
 * ⚠️ **不读已有的 layout** —— 它是"从零铺一遍"的入口；
 * 要"缺哪补哪"用 {@link ensureLayout}。
 */
export function autoLayout(def: ProcessDefinition): Layout {
  if (!def || typeof def !== 'object' || !Array.isArray(def.processes)) {
    throw new Error('autoLayout: definition must be a ProcessDefinition');
  }
  const planes: PlaneLayout[] = [];

  for (const proc of def.processes) {
    const sink = new Map<string, Box>();
    place(proc.nodes, proc.flows, LAYOUT_METRICS.originX, LAYOUT_METRICS.originY, undefined, sink);

    const shapes: Record<string, ShapeLayout> = {};
    for (const [id, box] of [...sink.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const isSub = CONTAINER_TYPES.includes(typeOfNode(proc.nodes, id) ?? '');
      shapes[id] = {
        x: round(box.x),
        y: round(box.y),
        width: round(box.width),
        height: round(box.height),
        ...(box.parent ? { parentId: box.parent } : {}),
        ...(isSub ? { isExpanded: true } : {}),
      };
    }

    /*
     * ★ 泳道与池的图形 —— 只给节点/连线生成坐标、不给泳道 shape 的话：
     * 导出的泳道图在画布上**看不到泳道**（bpmn-visualization 只认得出节点，
     * 实测「两条泳道 + 池」只识别出 2 个图元）。泳道是中国式审批的高频需求（L1 必开），
     * 没有图形等于没兑现。
     *
     * 算法：泳道 = 它名下节点包围盒 + padding；池 = 所有泳道包围盒 + 左侧标签区。
     * （真实场景多数是**导入别人的泳道图**，那时坐标来自原文件 DI；这里兜的是「新建的泳道流程」。）
     */
    const laneBoxes: Box[] = [];
    for (const ls of proc.laneSets ?? []) {
      for (const lane of ls.lanes) {
        const box = padded(unionOf(laneNodeIds(lane).map((id) => sink.get(id))), LANE_MARGIN);
        if (!box) continue;
        laneBoxes.push(box);
        shapes[lane.id] = boxToShape(box);
      }
    }
    for (const collab of def.collaborations ?? []) {
      for (const p of collab.participants) {
        if (p.processRef !== undefined && p.processRef !== proc.id) continue;
        const inner = unionOfBoxes(laneBoxes) ?? unionOf(proc.nodes.map((n) => sink.get(n.id)));
        const box = padded(inner, POOL_MARGIN);
        if (!box) continue;
        // 池的标签在左侧：整体向左让出一条
        shapes[p.id] = boxToShape({
          x: box.x - POOL_LABEL_WIDTH,
          y: box.y,
          width: box.width + POOL_LABEL_WIDTH,
          height: box.height,
        });
      }
    }

    const edges: Record<string, EdgeLayout> = {};
    const containers = [{ nodes: proc.nodes, flows: proc.flows }, ...walkContainers(proc.nodes)];
    for (const container of containers) {
      for (const f of container.flows) {
        const wps = edgeOf(sink.get(f.from), sink.get(f.to));
        if (wps.length === 0) continue;
        const xs = wps.map((p) => p.x);
        const ys = wps.map((p) => p.y);
        edges[f.id] = {
          waypoints: wps.map((p) => ({ x: round(p.x), y: round(p.y) })),
          ...(f.name
            ? {
                label: {
                  x: round((Math.min(...xs) + Math.max(...xs)) / 2),
                  y: round(Math.min(...ys) - 10),
                  width: 60,
                  height: 14,
                },
              }
            : {}),
        };
      }
    }

    planes.push({
      id: `${proc.id}_plane`,
      elementId: proc.id,
      shapes: sortRecord(shapes),
      edges: sortRecord(edges),
    });
  }

  return { planes };
}

/**
 * `toXml` 的布局入口。
 *
 * ★ 口径（第二十道门禁跨解析器比对改定的，理由写在下面，别改回去）：
 *
 *   **layout 一份都没有 → 全量生成**（新建模型的正常路径）
 *   **layout 已经有了 → 原样返回，一个坐标都不动**
 *
 * 旧行为是"缺哪补哪"：把 `autoLayout()` 的全量结果与已有 layout 合并
 * （`{...gen.shapes, ...cur.shapes}`），结果两个问题：
 *
 *   ① **凭空多图**：`autoLayout` 生成的 plane 以 **process** 为 `bpmnElement`，
 *      而别人的文件里 plane 往往挂在 **collaboration** 上 → 对不上就整份追加出去。
 *      MIWG A.4.0 实测：原 1 张图，转到我们手里变成 3 张（多出来的 2 张还是重复的）。
 *   ② **给作者没画的元素补框**：`dataObject` 之类作者故意不给坐标的元素会被画上去，
 *      于是每一家 parser 都看得出"这文件被人加工过"。
 *
 * 二者都直接违反 `fromXml → toXml` 的**恒等性**，而恒等性是比"每个元素都有坐标"
 * 重要得多的承诺：坐标补不出来只是某元素没有图形，恒等不成立则意味着我们在
 * 静默改写用户的排版资产。要补，请显式调用 `autoLayout()`；导出时不想补可传
 * `{ autoLayout: false }`。
 */
export function ensureLayout(def: ProcessDefinition): Layout {
  const existing = def.layout;
  if (!existing || existing.planes.length === 0) return autoLayout(def);
  return { planes: existing.planes };
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

function typeOfNode(nodes: readonly FlowNode[], id: string): string | undefined {
  for (const n of nodes) {
    if (n.id === id) return n.type;
    if (n.nodes) {
      const inner = typeOfNode(n.nodes, id);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** 递归列出所有带 flows 的容器（process 本身 + 子流程） */
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
