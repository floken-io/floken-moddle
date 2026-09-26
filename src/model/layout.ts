/**
 * `layout` —— 图形坐标层（§4.6）
 *
 * **引擎直接忽略这一层**，它存在的唯一理由是让导出的 XML 能被标准工具渲染。
 * 缺失时由 `autoLayout()` 兜底补出（M2 实现；AC-S7：同输入多次结果一致）。
 *
 * 为什么在顶层而不内联进节点：BPMN 规范本身就把图形与语义分成两块平级的东西 ——
 * `<definitions>` 下 `process`（语义）与 `bpmndi:BPMNDiagram`（图形）并列，坐标在
 * `BPMNShape@bounds` / `BPMNEdge@waypoint` 上，靠 `@bpmnElement` 指回语义元素，
 * **从来不在 `<userTask>` 身上**。JSON 侧照抄这个分工。
 *
 * ⚠️ 与 warm-flow 的内联 `Node.coordinate` 字符串刻意不同（§4.4.2）：它内联是因为它是
 * 仿钉钉节点列表式建模、不产出 BPMN DI；我们承诺 `toXml` 出**合法 BPMNDI**。
 */

import { z } from 'zod';

import { MODDLE_DIAGNOSTIC_CODES, diagnostic, joinPath, type Diagnostic } from '../core/errors.js';

/** 矩形（对应 `dc:Bounds`） */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/*
 * ⚠️ 可选字段统一写 `?: T | undefined`：本仓开了 `exactOptionalPropertyTypes`，
 * 而 zod 的 `.optional()` 产出就是 `T | undefined`（同 `model/approval.ts` 的说明）。
 */
export interface ShapeLayout extends Bounds {
  /** 子流程内元素指向其容器；缺省 = 直属 plane */
  parentId?: string | undefined;
  /** 子流程展开 / 折叠 */
  isExpanded?: boolean | undefined;
  /** 池道方向 */
  isHorizontal?: boolean | undefined;
  /**
   * 原文件里 `bpmndi:BPMNShape@id`（导入时记下，缺省由导出侧生成）。
   *
   * ★ 为什么要记它：XML 的 `id` 是 `xsd:ID`，**全文档唯一**。凭空生成 `${元素id}_di`
   * 会撞上原文件里本来就存在的 `xxx_di` —— 那产出的是**非法 XML**
   * （互操作实证抓到：bpmn-moddle 报 `duplicate ID`，bpmn-js 会丢图形）。
   */
  diId?: string | undefined;
}

export interface EdgeLayout {
  /** `di:waypoint`，至少 2 点 */
  waypoints: { x: number; y: number }[];
  label?: Bounds | undefined;
  /** 同 {@link ShapeLayout.diId}（对应 `bpmndi:BPMNEdge@id`） */
  diId?: string | undefined;
}

/** 对齐 `bpmndi:BPMNPlane`：一个 plane 对应一个 process（或展开的 subProcess） */
export interface PlaneLayout {
  id: string;
  /** `@bpmnElement` → process（或 subProcess） */
  elementId: string;
  /** key = 元素 id（含子流程内部元素） */
  shapes: Record<string, ShapeLayout>;
  edges: Record<string, EdgeLayout>;
}

/** 对齐 `bpmndi:BPMNDiagram`，允许不止一张图 */
export interface Layout {
  planes: PlaneLayout[];
}

// ─────────────────────────────────────────────────────────────────
// schema
// ─────────────────────────────────────────────────────────────────

const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
}).strict();

const PointSchema = z.object({ x: z.number(), y: z.number() }).strict();

const ShapeLayoutSchema = BoundsSchema.extend({
  parentId: z.string().min(1).optional(),
  isExpanded: z.boolean().optional(),
  isHorizontal: z.boolean().optional(),
  diId: z.string().min(1).optional(),
}).strict();

const EdgeLayoutSchema = z.object({
  waypoints: z.array(PointSchema).min(2),
  label: BoundsSchema.optional(),
  diId: z.string().min(1).optional(),
}).strict();

const PlaneLayoutSchema = z.object({
  id: z.string().min(1),
  elementId: z.string().min(1),
  shapes: z.record(z.string(), ShapeLayoutSchema),
  edges: z.record(z.string(), EdgeLayoutSchema),
}).strict();

export const LayoutSchema = z.object({ planes: z.array(PlaneLayoutSchema) })
  .strict() satisfies z.ZodType<Layout>;

// ─────────────────────────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────────────────────────

export interface LayoutValidateOptions {
  /** 模型里已存在的元素 id 集合；给了才查悬空引用 */
  knownIds?: ReadonlySet<string> | undefined;
  /** 路径前缀 */
  path?: string | undefined;
}

/**
 * 校验 `layout`。
 *
 * ⚠️ 引用未知元素只给 **warn 不是 error**：坐标层缺失/多出是**渲染问题**
 * （`autoLayout()` 能补、多余项渲染器会跳过），不该拦住模型导入。
 * 反过来，结构不合法（waypoints < 2）是 error —— 那补不出来。
 */
export function validateLayout(input: unknown, opts: LayoutValidateOptions = {}): Diagnostic[] {
  const base = opts.path ?? 'layout';
  const out: Diagnostic[] = [];

  const parsed = LayoutSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const p = issue.path.map((s) => String(s)).join('.');
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE, issue.message, {
          node: { path: joinPath(base, p) },
        }),
      );
    }
    return out;
  }

  const layout = parsed.data;
  const seenPlaneIds = new Set<string>();
  for (const [i, plane] of layout.planes.entries()) {
    if (seenPlaneIds.has(plane.id)) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DUPLICATE_ID, `plane id 重复：${plane.id}`, {
          node: { path: joinPath(base, 'planes', i, 'id') },
        }),
      );
    }
    seenPlaneIds.add(plane.id);

    for (const [id, shape] of Object.entries(plane.shapes)) {
      if (opts.knownIds && !opts.knownIds.has(id)) {
        out.push(
          diagnostic('warn', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF, `shape 指向不存在的元素：${id}`, {
            node: { path: joinPath(base, 'planes', i, 'shapes', id) },
          }),
        );
      }
      if (opts.knownIds && shape.parentId && !opts.knownIds.has(shape.parentId)) {
        out.push(
          diagnostic('warn', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF, `parentId 指向不存在的元素：${shape.parentId}`, {
            node: { path: joinPath(base, 'planes', i, 'shapes', id, 'parentId') },
          }),
        );
      }
    }
    for (const [id] of Object.entries(plane.edges)) {
      if (opts.knownIds && !opts.knownIds.has(id)) {
        out.push(
          diagnostic('warn', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF, `edge 指向不存在的元素：${id}`, {
            node: { path: joinPath(base, 'planes', i, 'edges', id) },
          }),
        );
      }
    }
  }
  return out;
}
