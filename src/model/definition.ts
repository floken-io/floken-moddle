/**
 * Model JSON v2 的顶层类型（§4.2 / §4.3 / §4.5 / §4.6）+ 整模型校验（§5）。
 *
 * ## ★ 本次重做改了什么（v1 → v2）
 *
 * v1 的形状是**为 XML 服务的**：`processes[]` 是 BPMN `<process>` 的影子、`laneSets` 是泳道、
 * `extraElements` 是 XML 快照、`extension` 要登记命名空间前缀且只能装标量。
 * XML 没了之后这些全是负担，故全部删除（§0.2 / §4.2 的差异表）。
 *
 * ## 三条定调（沿用，与序列化格式无关）
 * 1. **连线用 `from` / `to`**，不用 `sourceRef` / `targetRef` —— JSON 里 `from/to` 更直白，
 *    且避开"引用是字符串还是对象"这个经典坑；
 * 2. **`extension` 是保全袋**：不认识的键一律进它，**绝不静默丢弃**（§4.5 纪律一）；
 * 3. 校验走**诊断通道**，一次把问题说全；`assertValidDefinition()` 才是严格抛错入口。
 *
 * ## ★ 放开 `.strict()` 的真正含义（FR-M8）
 * v1 顶层是 `.strict()` → 未知键被判 `VALIDATE_UNKNOWN_KEY` **error**，
 * 而转换层那边又把它们静默丢掉 —— 两边口径打架，且都违反"绝不静默丢弃"。
 * v2 一律用 `z.looseObject()`：**未知键保留但不解读**，校验只对已知键负责。
 * ⚠️ 这与「静默丢弃」的区别是决定性的：保留的数据仍在，宿主随时可取；丢弃的数据找不回来。
 *
 * ⚠️ 注意 zod v4 的 `z.object()` 默认是 **strip**（未知键从输出里被剥掉）—— 那也是丢弃。
 *    所以这里**必须**显式 `looseObject`，不能偷懒写 `z.object`。
 */

import { z } from 'zod';

import {
  MODDLE_DIAGNOSTIC_CODES,
  diagnostic,
  joinPath,
  validationFailedError,
  type Diagnostic,
} from '../core/errors.js';
import type { Approval, TimeoutConfig } from './approval.js';
import { validateApproval } from './approval.js';
import {
  EVENT_DEFINITION_TYPES,
  NODE_TYPES,
  UNIMPLEMENTED_NODE_TYPES,
  isNodeType,
  isUnimplementedNodeType,
} from './node-types.js';
import { validateLayout, type Layout } from './layout.js';

/**
 * FEEL 表达式语言的 URI（D18/Q35）。
 *
 * **URI 取自官方，不自造**：这是 DMN **1.5** XSD 里 `expressionLanguage` 的官方默认值。
 * ⚠️ 该值随权威元模型版本走（1.3=`…/20191111/FEEL/`、1.4=`…/20211108/FEEL/`、
 * **1.5=`…/20230324/FEEL/`（本项目权威值）**、1.6=`…/20240513/FEEL/`）。
 */
export const FEEL_EXPRESSION_LANGUAGE = 'https://www.omg.org/spec/DMN/20230324/FEEL/';

/**
 * Model JSON 自身的格式版本（与包版本无关）。
 *
 * ★ v2 = JSON-only 重写后的形状。**不提供 v1→v2 迁移**（§10）：0.x 阶段破坏性变更属正常，
 * 且 v1 没有外部用户。校验器对 major ≠ 2 直接报 error —— 不做静默兼容，
 * 「读旧格式读出一个行为不同的流程」比「当场报错」危险得多。
 */
export const MODEL_SCHEMA_VERSION = '2.0.0';

// ─────────────────────────────────────────────────────────────────
// 自定义扩展袋（§4.5）
// ─────────────────────────────────────────────────────────────────

/**
 * ★ 自定义扩展袋 —— **就这一行，没有别的规则**。
 *
 * v1 的三条约束（键必须带 `prefix:`、值只能标量、标量往返变字符串）**全部取消**。
 * 那些约束没有一条来自 JSON —— 它们全部来自「XML 属性只能装字符串」这一个事实。
 */
export type ExtensionBag = Record<string, unknown>;

const ExtensionBagSchema: z.ZodType<ExtensionBag> = z.record(z.string(), z.unknown());

/**
 * ★ 模型的一等字段键（§4.5「保留键不进袋」）。
 *
 * `extension` 里**不允许**再出现这些键：它们已经是一等字段，重复塞一份会让
 * 「哪个生效」变成未定义行为。
 *
 * ★ 这条同时是**引擎侧 ADR-009 排除判据的数据源**：v1 排除的是 `floken:*` 前缀，
 * 而**前缀机制随 XML 一起消失**，故改为排除保留键（见 §4.5 衔接表）。
 */
export const NODE_RESERVED_KEYS: readonly string[] = Object.freeze([
  'id',
  'type',
  'name',
  'description',
  'approval',
  'call',
  'eventDefinition',
  'script',
  'timeout',
  'formKey',
  'attachedTo',
  'defaultFlow',
  'implementation',
  'operationRef',
  'messageRef',
  'calledElement',
  'triggeredByEvent',
  'cancelActivity',
  'isInterrupting',
  'nodes',
  'flows',
  'extension',
]);

// ─────────────────────────────────────────────────────────────────
// 行为子结构
// ─────────────────────────────────────────────────────────────────

/**
 * `FormalExpression` 的 Model JSON 形态（★ D18 / D19）。
 *
 * ⚠️ 全模型的可选字段统一写 `?: T | undefined`：本仓开了 `exactOptionalPropertyTypes`，
 * 而 zod 的 `.optional()` 产出就是 `T | undefined`（同 `model/approval.ts` 的说明）。
 * 两边写法必须一致，否则 `XxxSchema satisfies z.ZodType<Xxx>` 那道编译期锁会失效。
 */
export interface FormalExpression {
  /** ★ FEEL 源码，**不带 `=` 前缀**（D19） */
  body: string;
  /** 默认 {@link FEEL_EXPRESSION_LANGUAGE} */
  language?: string | undefined;
}

/**
 * 事件定义。取值见 {@link EVENT_DEFINITION_TYPES}。
 *
 * ⚠️ 清单的含义是「**可建模**的种类」，不是「引擎现在都能跑」的种类 ——
 * 引擎目前只对 `message` / `signal` 给出可投递绑定，其余在令牌到达时抛错并指名归属 FR。
 */
export interface EventDefinition {
  type: string;
  /** 各变体自有字段（timer 的 duration/date/cycle、message 的 messageRef …） */
  [key: string]: unknown;
}

/**
 * `callActivity` 的子流程引用（v1 在 `extension['floken:call']`，现为一等字段）。
 *
 * ★ `version` **必填**：引擎 `callTargetOf()` 对没绑定版本的 `callActivity` 直接抛错（INV-16），
 * **绝不回退到"最新版"** —— 回退的代价是「主流程没改、子流程悄悄换了版本，
 * 在途实例行为随发布而变」，且它没有任何报错（AC-E10 要防的正是这件事）。
 */
export interface CallSpec {
  /** 被调用流程的 processId */
  processId: string;
  /** ★ 显式绑定的定义版本（正整数） */
  version: number;
  /** 其余宿主自有字段 */
  [key: string]: unknown;
}

/** `scriptTask` 的脚本 */
export interface ScriptSpec {
  /** 脚本源码 */
  body: string;
  /** 语言/格式标识（如 `feel` / `javascript`） */
  language?: string | undefined;
}

// ─────────────────────────────────────────────────────────────────
// 节点与连线（§4.3）
// ─────────────────────────────────────────────────────────────────

/**
 * 节点。
 *
 * 字段按「谁读它」分三组：
 * - **通用**：`id` / `type` / `name` / `description`；
 * - **行为**：按 `type` 生效、互不冲突（`approval` 管 userTask、`call` 管 callActivity、
 *   `eventDefinition` 管各类事件、`script` 管 scriptTask、`timeout` 管非审批节点）；
 * - **扩展**：`extension`（任意 JSON，引擎不解读）。
 */
export interface FlowNode {
  id: string;
  /** ★ 节点类型，取值见 §3.2 白名单（{@link NODE_TYPES}）；可经 `customNodeTypes` 追加 */
  type: string;
  name?: string | undefined;
  description?: string | undefined;

  // ── 行为字段（★ v2 一等字段：v1 这些住在 extension['floken:*'] 里）──

  /** ★ userTask 的审批语义（v1 在 `extension['floken:approval']`） */
  approval?: Approval | undefined;
  /** ★ callActivity 的子流程引用（v1 在 `extension['floken:call']`） */
  call?: CallSpec | undefined;
  /** 事件定义（startEvent / intermediateCatchEvent / boundaryEvent …） */
  eventDefinition?: EventDefinition | undefined;
  /** serviceTask 的实现标识 / businessRuleTask 的决策引用 */
  implementation?: string | undefined;
  /** scriptTask 的脚本 */
  script?: ScriptSpec | undefined;
  /** 节点级超时（与 `approval.timeout` 分工：这里管**非审批**节点） */
  timeout?: TimeoutConfig | undefined;

  // ── 其余被引擎读取的字段（沿用 v1，与 XML 无关故保留）──

  /** userTask 的表单标识 */
  formKey?: string | undefined;
  /** boundaryEvent：挂到哪个节点 */
  attachedTo?: string | undefined;
  /** 无条件下的默认分支（`Gateway` / `Activity`），指向一条 flow 的 id */
  defaultFlow?: string | undefined;
  /** sendTask / receiveTask / serviceTask 的操作引用 */
  operationRef?: string | undefined;
  /** sendTask / receiveTask 的消息引用 */
  messageRef?: string | undefined;
  /** subProcess：是否由事件触发 */
  triggeredByEvent?: boolean | undefined;
  /** boundaryEvent：触发后是否取消宿主活动 */
  cancelActivity?: boolean | undefined;
  /** startEvent：事件子流程是否中断宿主 */
  isInterrupting?: boolean | undefined;

  /** subProcess 的子节点（递归） */
  nodes?: FlowNode[] | undefined;
  /** subProcess 的内部连线（递归） */
  flows?: Flow[] | undefined;

  /** ★ 自定义扩展袋：任意 JSON，无前缀、无标量限制（§4.5） */
  extension?: ExtensionBag | undefined;
}

export interface Flow {
  id: string;
  from: string;
  to: string;
  name?: string | undefined;
  description?: string | undefined;
  /**
   * FEEL 条件。两种写法都接受：
   * - 简写 `condition: 'amount > 5000'` → 视为 body，`language` 取 {@link FEEL_EXPRESSION_LANGUAGE}
   * - 全写 `condition: { body: '…', language: '…' }`
   *
   * ★ 为什么必须带 `language` 的概念：FEEL 与 XPath 对 `amount > 5000` 的语义**不一样**
   * （XPath 是节点集比较），不写清楚就会静默偏离预期（§4.3）。
   */
  condition?: string | FormalExpression | undefined;
  /** ★ 自定义扩展袋 */
  extension?: ExtensionBag | undefined;
}

// ─────────────────────────────────────────────────────────────────
// 顶层（§4.2）
// ─────────────────────────────────────────────────────────────────

/**
 * ★ v2 顶层结构。
 *
 * 与 v1 的最大差别：`processes: Process[]` 这一层**整个删掉**，节点与连线上提。
 * 理由：多 process 是 BPMN `collaboration` 的概念，**中式审批一个定义就是一个流程**；
 * 留着它只会让每个读取点都写 `def.processes[0]`（引擎里真就这么写的）。
 */
export interface ProcessDefinition {
  /** 本 JSON 格式的版本（semver）。v2 = JSON-only 重写后的形状 */
  schemaVersion: string;
  id: string;
  name?: string | undefined;
  /** 业务版本号 —— 实例绑定它，改版不影响在途 */
  version?: number | undefined;

  /** ★ 顶层节点表（v1 是 `processes[0].nodes`） */
  nodes: FlowNode[];
  /** ★ 顶层连线表 */
  flows: Flow[];

  /** 坐标（§4.6） */
  layout?: Layout | undefined;
  /** ★ 顶层自定义扩展袋（§4.5） */
  extensions?: Record<string, unknown> | undefined;
  /** 元数据（作者、来源工具、备注……），引擎不解读 */
  meta?: Record<string, unknown> | undefined;
}

// ─────────────────────────────────────────────────────────────────
// id（§4.1）
// ─────────────────────────────────────────────────────────────────

/**
 * `id` 的字符集（§4.1：NCName 安全字符集）。
 *
 * 宽松处：允许非 ASCII 字母（中文工具里 `id="节点1"` 很常见）。
 * 严格处：**不允许空白与冒号** —— 冒号在带命名空间的格式里是分隔符，
 * 空白会破坏任何基于空格分隔的引用语法。
 */
export const ID_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

/** id 是否合法（空串、数字开头、含空白/冒号一律不行） */
export function isValidId(id: string): boolean {
  if (!id) return false;
  if (ID_PATTERN.test(id)) return true;
  // 非 ASCII 开头（如中文）按 NCName 放行，只查不含空白与冒号、不以数字开头
  if (/[\s:]/.test(id)) return false;
  if (/^[\d.\-]/.test(id)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────
// schema（结构层 · ①）
// ─────────────────────────────────────────────────────────────────

const FormalExpressionSchema = z.looseObject({
  body: z.string(),
  language: z.string().optional(),
});

const EventDefinitionSchema = z.looseObject({ type: z.string().min(1) });

const CallSpecSchema = z.looseObject({
  processId: z.string().min(1),
  version: z.number().int().min(1),
});

const ScriptSpecSchema = z.looseObject({
  body: z.string(),
  language: z.string().optional(),
});

const FlowSchema: z.ZodType<Flow> = z.looseObject({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  condition: z.union([z.string(), FormalExpressionSchema]).optional(),
  extension: ExtensionBagSchema.optional(),
});

/**
 * 节点是**递归**的（subProcess 里还有 nodes/flows），故用 `z.lazy`。
 *
 * `approval` / `timeout` 用 `z.custom` 占位：它们的**结构**由 `approval.ts` 的 `ApprovalSchema`
 * 负责，这里只保证"有这个键"，真正的组合矩阵校验走规则层（④），
 * 否则结构层会把可继续的语义问题变成"整个 schema 解析失败"。
 */
const FlowNodeSchema: z.ZodType<FlowNode> = z.lazy(
  (): z.ZodType<FlowNode> =>
    z.looseObject({
      id: z.string().min(1),
      type: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),

      approval: z.custom<Approval>(() => true).optional(),
      call: CallSpecSchema.optional(),
      eventDefinition: EventDefinitionSchema.optional(),
      implementation: z.string().optional(),
      script: ScriptSpecSchema.optional(),
      timeout: z.custom<TimeoutConfig>(() => true).optional(),

      formKey: z.string().optional(),
      attachedTo: z.string().min(1).optional(),
      defaultFlow: z.string().min(1).optional(),
      operationRef: z.string().optional(),
      messageRef: z.string().optional(),
      triggeredByEvent: z.boolean().optional(),
      cancelActivity: z.boolean().optional(),
      isInterrupting: z.boolean().optional(),

      nodes: z.array(FlowNodeSchema).optional(),
      flows: z.array(FlowSchema).optional(),

      extension: ExtensionBagSchema.optional(),
    }),
);

export const ProcessDefinitionSchema: z.ZodType<ProcessDefinition> = z.looseObject({
  schemaVersion: z.string().min(1),
  id: z.string().min(1),
  name: z.string().optional(),
  version: z.number().int().nonnegative().optional(),
  nodes: z.array(FlowNodeSchema),
  flows: z.array(FlowSchema),
  layout: z.custom<Layout>(() => true).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

// ─────────────────────────────────────────────────────────────────
// 校验（§5）
// ─────────────────────────────────────────────────────────────────

export interface ValidateDefinitionOptions {
  /**
   * 追加自定义节点类型（§3.3）。
   *
   * 白名单**不是封闭枚举**：宿主可以加自己的类型（如 `acme:robotTask`），
   * 但必须**显式声明** —— 拼错 `userTaks` 若被静默接受，引擎要等令牌到达才报错。
   */
  customNodeTypes?: readonly string[] | undefined;
  /** 把 warn 也当成不合格 */
  strict?: boolean | undefined;
}

/** 选项名白名单（**禁止静默忽略**拼错的选项名） */
const VALIDATE_OPTION_KEYS: readonly string[] = Object.freeze(['customNodeTypes', 'strict']);

/**
 * 校验整份 Model JSON —— **返回诊断数组，不抛**（§5 纪律）。
 *
 * 四层，逐层加严，**前一层不过不进后一层**：
 * ① 结构（zod）→ ② 类型（`type` 是否在白名单）→ ③ 引用完整性（id 唯一 / from-to 存在）
 * → ④ 内嵌语义（`approval` 组合矩阵 / `extension` 保留键 / `layout` 与节点 id 对得上）。
 *
 * ⚠️ **绝不因首错中断**：设计器要一次显示全部问题（AC-M8）。
 */
export function validateDefinition(
  input: unknown,
  opts: ValidateDefinitionOptions = {},
): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const k of Object.keys(opts)) {
    if (!VALIDATE_OPTION_KEYS.includes(k)) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_UNKNOWN_OPTION, `Unknown option '${k}'`, {
          node: { path: '$' },
          expected: [...VALIDATE_OPTION_KEYS],
        }),
      );
    }
  }

  const custom = new Set(opts.customNodeTypes ?? []);

  const parsed = ProcessDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const p = issue.path.map((s) => String(s)).join('.');
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE, issue.message, {
          node: { path: p || '$' },
        }),
      );
    }
    return out; // 结构都不对，规则层无从下手
  }
  const def = parsed.data;

  // ── ①½ schemaVersion：major 必须是我们认识的版本（不做静默兼容）──
  const major = Number.parseInt(def.schemaVersion.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major !== 2) {
    out.push(
      diagnostic(
        'error',
        MODDLE_DIAGNOSTIC_CODES.VALIDATE_SCHEMA_VERSION,
        `Unsupported schemaVersion '${def.schemaVersion}'`,
        {
          node: { path: 'schemaVersion' },
          expected: [MODEL_SCHEMA_VERSION],
          suggestions: ['v1 → v2 不提供迁移（§10）；请按 v2 形状重写该定义'],
        },
      ),
    );
  }

  const checkId = (id: string, path: string): void => {
    if (isValidId(id)) return;
    out.push(
      diagnostic(
        'error',
        MODDLE_DIAGNOSTIC_CODES.VALIDATE_INVALID_ID,
        `id '${id}' is not a valid NCName (must not start with a digit, dot or dash; must not contain whitespace or ':')`,
        { node: { path }, suggestions: ['改成字母或下划线开头，如 Activity_0abc'] },
      ),
    );
  };

  checkId(def.id, 'id');

  // ── ③ 引用完整性：先递归收齐 id（子流程里的节点同样是合法引用目标）──
  const nodeIds = new Set<string>();
  /** ★ 连线 id 单独收：`layout.edges` 的键是 flow id，与 `layout.nodes` 不是同一个集合 */
  const flowIds = new Set<string>();
  const seenNodeIds = new Set<string>();
  const seenFlowIds = new Set<string>();

  const collectIds = (nodes: readonly FlowNode[], flows: readonly Flow[]): void => {
    for (const n of nodes) {
      nodeIds.add(n.id);
      if (n.nodes?.length || n.flows?.length) collectIds(n.nodes ?? [], n.flows ?? []);
    }
    for (const f of flows) flowIds.add(f.id);
  };
  collectIds(def.nodes, def.flows);

  /** ④ 扩展袋：保留键不许重复塞进来（§4.5「保留键不进袋」） */
  const checkExtension = (ext: ExtensionBag | undefined, base: string): void => {
    if (!ext) return;
    for (const k of Object.keys(ext)) {
      if (NODE_RESERVED_KEYS.includes(k)) {
        out.push(
          diagnostic(
            'error',
            MODDLE_DIAGNOSTIC_CODES.VALIDATE_RESERVED_KEY,
            `'${k}' is a reserved model key and must not appear inside 'extension'`,
            {
              node: { path: joinPath(base, 'extension', k) },
              suggestions: [`把它写成该元素的一等字段 ${k}`],
            },
          ),
        );
      }
    }
  };

  /** ② + ④ 的节点级检查 */
  const checkNode = (node: FlowNode, nBase: string): void => {
    checkId(node.id, joinPath(nBase, 'id'));
    if (seenNodeIds.has(node.id)) {
      out.push(
        diagnostic(
          'error',
          MODDLE_DIAGNOSTIC_CODES.VALIDATE_DUPLICATE_ID,
          `duplicate node id: ${node.id}`,
          { node: { id: node.id, path: joinPath(nBase, 'id') } },
        ),
      );
    }
    seenNodeIds.add(node.id);

    // ── ② 类型：不在白名单也不在 customNodeTypes → error（拼错必须当场报）──
    if (!isNodeType(node.type) && !custom.has(node.type)) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_NODE_TYPE, `unknown node type '${node.type}'`, {
          node: { id: node.id, path: joinPath(nBase, 'type') },
          expected: [...NODE_TYPES],
          suggestions: ['若要使用自定义类型，用 validateDefinition(def, { customNodeTypes: [...] }) 显式声明'],
        }),
      );
    } else if (isUnimplementedNodeType(node.type)) {
      /*
       * ★ 在白名单内但引擎未实现 → **warn 不是 error**（建模期放行）。
       * 引擎在令牌到达时会**抛错并指名归属 FR**，绝不静默直通（AC-M2）。
       */
      out.push(
        diagnostic(
          'warn',
          MODDLE_DIAGNOSTIC_CODES.VALIDATE_NODE_UNIMPLEMENTED,
          `node type '${node.type}' is whitelisted but not implemented by the engine yet`,
          {
            node: { id: node.id, path: joinPath(nBase, 'type') },
            expected: [...UNIMPLEMENTED_NODE_TYPES],
            suggestions: ['引擎会在令牌到达时抛错并指名归属 FR，不会静默直通'],
          },
        ),
      );
    }

    // ── ④ 事件定义种类 ──
    const evType = node.eventDefinition?.type;
    if (typeof evType === 'string' && !EVENT_DEFINITION_TYPES.includes(evType)) {
      out.push(
        diagnostic(
          'error',
          MODDLE_DIAGNOSTIC_CODES.VALIDATE_NODE_TYPE,
          `unknown eventDefinition.type '${evType}'`,
          {
            node: { id: node.id, path: joinPath(nBase, 'eventDefinition', 'type') },
            expected: [...EVENT_DEFINITION_TYPES],
          },
        ),
      );
    }

    // ── ④ 审批语义：组合矩阵由 approval.ts 的规则层负责（跨字段，zod 表达不了）──
    if (node.approval !== undefined) {
      for (const d of validateApproval(node.approval)) {
        out.push({
          ...d,
          node: { id: node.id, path: joinPath(nBase, 'approval', d.node?.path ?? '') },
        });
      }
    }

    checkExtension(node.extension, nBase);
  };

  const walk = (nodes: readonly FlowNode[], flows: readonly Flow[], base: string): void => {
    for (const [ni, node] of nodes.entries()) {
      const nBase = joinPath(base, 'nodes', ni);
      checkNode(node, nBase);
      if (node.nodes?.length || node.flows?.length) {
        walk(node.nodes ?? [], node.flows ?? [], nBase);
      }
    }
    for (const [fi, flow] of flows.entries()) {
      const fBase = joinPath(base, 'flows', fi);
      checkId(flow.id, joinPath(fBase, 'id'));
      if (seenFlowIds.has(flow.id)) {
        out.push(
          diagnostic(
            'error',
            MODDLE_DIAGNOSTIC_CODES.VALIDATE_DUPLICATE_ID,
            `duplicate flow id: ${flow.id}`,
            { node: { id: flow.id, path: joinPath(fBase, 'id') } },
          ),
        );
      }
      seenFlowIds.add(flow.id);

      if (!nodeIds.has(flow.from)) {
        out.push(
          diagnostic(
            'error',
            MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF,
            `flow.from '${flow.from}' does not reference an existing node`,
            { node: { id: flow.id, path: joinPath(fBase, 'from') } },
          ),
        );
      }
      if (!nodeIds.has(flow.to)) {
        out.push(
          diagnostic(
            'error',
            MODDLE_DIAGNOSTIC_CODES.VALIDATE_DANGLING_REF,
            `flow.to '${flow.to}' does not reference an existing node`,
            { node: { id: flow.id, path: joinPath(fBase, 'to') } },
          ),
        );
      }
      checkExtension(flow.extension, fBase);
    }
  };

  walk(def.nodes, def.flows, '$');

  // ── ④ layout 与节点 id 对得上 ──
  if (def.layout !== undefined) {
    for (const d of validateLayout(def.layout, { knownIds: nodeIds, knownEdgeIds: flowIds })) out.push(d);
  }

  return out;
}

/**
 * 严格模式：把 error 级（`strict` 下连同 warn 级）诊断升级为**抛错**。
 *
 * 抛的码只有**一个**（`MODDLE_MODEL_VALIDATION_FAILED`），具体几条不合格放 `details.diagnostics`
 * —— 一条规则一个码会让码表随校验规则无限膨胀，而码是**发布后不得改名**的稳定契约。
 */
export function assertValidDefinition(input: unknown, opts: ValidateDefinitionOptions = {}): void {
  const ds = validateDefinition(input, opts);
  const blocking = ds.filter((d) => (opts.strict ? d.severity !== 'info' : d.severity === 'error'));
  if (blocking.length > 0) throw validationFailedError(blocking.length, blocking);
}
