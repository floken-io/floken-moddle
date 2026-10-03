/**
 * `layout` —— 图形坐标层（§4.6）
 *
 * **引擎直接忽略这一层**，它存在的唯一理由是让设计器能把流程画出来。
 * 缺失时由 `autoLayout()` 兜底补出（AC-S7：同输入多次结果一致）。
 *
 * 为什么在顶层而不内联进节点：坐标是**一张图的属性**，不是节点的属性 ——
 * 同一个节点在两张图里可以有不同位置；内联会让「复制节点」顺手复制坐标。
 *
 * ## ★ v2 扁平化（v1 是 BPMN DI 的 `planes[]`）
 *
 * | v1 | v2 |
 * |---|---|
 * | `layout.planes[].shapes[]` / `.edges[]` | 扁平 `nodes` / `edges` 字典 |
 *
 * `plane` 是 BPMN DI「一张图一个图层」的概念（还要靠 `@bpmnElement` 指回语义元素）。
 * JSON-only 之后没有 DI 这回事，字典按 id 直接取，O(1)。
 */

import { z } from 'zod';

import { MODDLE_DIAGNOSTIC_CODES, diagnostic, joinPath, type Diagnostic } from '../core/errors.js';

/** 点 */
export interface Point {
  x: number;
  y: number;
}

/*
 * ⚠️ 可选字段统一写 `?: T | undefined`：本仓开了 `exactOptionalPropertyTypes`，
 * 而 zod 的 `.optional()` 产出就是 `T | undefined`（同 `model/approval.ts` 的说明）。
 */
/** 节点的框 */
export interface NodeLayout {
  x: number;
  y: number;
  width?: number | undefined;
  height?: number | undefined;
}

/** ★ v2 形状：两个扁平字典，key = 元素 id */
export interface Layout {
  /** 节点坐标：key = 节点 id */
  nodes?: Record<string, NodeLayout> | undefined;
  /** 连线折点：key = 连线 id */
  edges?: Record<string, Point[]> | undefined;
}

// ─────────────────────────────────────────────────────────────────
// schema
// ─────────────────────────────────────────────────────────────────

const PointSchema = z.looseObject({ x: z.number(), y: z.number() });

const NodeLayoutSchema = z.looseObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

export const LayoutSchema = z.looseObject({
  nodes: z.record(z.string(), NodeLayoutSchema).optional(),
  edges: z.record(z.string(), z.array(PointSchema)).optional(),
}) satisfies z.ZodType<Layout>;

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
 * ⚠️ 指向不存在的元素只给 **warn 不是 error**：坐标多出/缺失是**渲染问题**
 * （`autoLayout()` 能补、多余项渲染器会跳过），不该拦住模型本身。
 * 反过来，结构不合法（折点不足 2 个、坐标非数字）是 error —— 那补不出来。
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

  for (const [id, box] of Object.entries(layout.nodes ?? {})) {
    if (opts.knownIds && !opts.knownIds.has(id)) {
      out.push(
        diagnostic('warn', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF, `layout.nodes['${id}'] points to an element that does not exist`, {
          node: { id, path: joinPath(base, 'nodes', id) },
        }),
      );
    }
    if (box.width !== undefined && box.width <= 0) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE, `layout.nodes['${id}'].width must be positive`, {
          node: { id, path: joinPath(base, 'nodes', id, 'width') },
        }),
      );
    }
    if (box.height !== undefined && box.height <= 0) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE, `layout.nodes['${id}'].height must be positive`, {
          node: { id, path: joinPath(base, 'nodes', id, 'height') },
        }),
      );
    }
  }

  for (const [id, points] of Object.entries(layout.edges ?? {})) {
    if (opts.knownIds && !opts.knownIds.has(id)) {
      out.push(
        diagnostic('warn', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF, `layout.edges['${id}'] points to an element that does not exist`, {
          node: { id, path: joinPath(base, 'edges', id) },
        }),
      );
    }
    if (points.length < 2) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_DI_INCOMPLETE, `layout.edges['${id}'] needs at least 2 waypoints`, {
          node: { id, path: joinPath(base, 'edges', id) },
        }),
      );
    }
  }

  return out;
}
