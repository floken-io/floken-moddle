/**
 * ★ `Approval` —— 中国式审批语义的类型 + 校验 + 归一化（护城河所在）
 *
 * 规格来源：`流程引擎包文档/01-包需求-floken-moddle.md` §4.4.1（BLOCKER-M0 落笔处，**单一事实源**）。
 * 本档是它在代码里的兑现，三层分工：
 *
 * 1. **类型层**（`Approval` 等 interface）—— 与文档逐字对应，是公开 API 的面子；
 * 2. **结构层**（`ApprovalSchema`，zod）—— 类型/枚举/必填/unknown-key 的运行时校验；
 * 3. **规则层**（`validateApproval`）—— **跨字段**的互斥与组合矩阵，zod 表达不了的部分。
 *
 * ⚠️ 三条纪律：
 * - **动作层开关名逐字对齐 `03-engine` §4 主表「设计期开关」列**（`approval.reject.allowed` 等），
 *   引擎读的就是这些路径 —— 改名等于改引擎。
 * - **默认值只在 {@link normalizeApproval} 里落一处**，引擎不得各写一份。
 * - 校验走**诊断通道**（可继续），不抛；只有 `assertValidApproval()` 才抛（严格模式）。
 */

import { z } from 'zod';

import {
  MODDLE_DIAGNOSTIC_CODES,
  diagnostic,
  joinPath,
  validationFailedError,
  type Diagnostic,
  type NodeRef,
} from '../core/errors.js';

// ─────────────────────────────────────────────────────────────────
// ① 分配层 · 审批人声明
// ─────────────────────────────────────────────────────────────────

/**
 * 7 类声明式选人（FR-5 / E-1 AC1）。
 * 全部由 `ApproverSource.resolve(spec, ctx)` 在**运行时**解析 —— 引擎不认识用户表，
 * 所以这里只能声明"从哪取人"，不能写死任何人。
 *
 * ⚠️ 可选字段统一写 `?: T | undefined` 而不是 `?: T`：本仓开了 `exactOptionalPropertyTypes`
 * （`tooling/tsconfig.base.json`），而 zod 的 `.optional()` 产出就是 `T | undefined`。
 * 两边写法必须一致，否则 `ApprovalSchema satisfies z.ZodType<Approval>` 这道编译期锁会失效。
 */
export type ApproverSpec =
  | { type: 'user'; value: string }
  | { type: 'role'; value: string }
  | { type: 'dept'; value: string; includeChildren?: boolean | undefined }
  | { type: 'starterLeader'; level?: number | undefined }
  | { type: 'deptLeader'; of?: string | undefined }
  | { type: 'formField'; field: string }
  | { type: 'expr'; expression: string };

/** 候选人里**取几个**当办理人 */
export type ApproverPolicy = 'all' | 'any' | 'first';
/** 多个办理人**怎么算通过** */
export type ApprovalMode = 'all' | 'any' | 'vote';

/** 解析不到审批人时怎么办（E-4 AC1：默认必须报错，不得静默跳过） */
export type OnEmpty = 'error' | 'skip' | 'toAdmin';
/** 多人场景下有人驳回怎么办（见「提前终止规则」） */
export type OnReject = 'abort' | 'wait';

/**
 * `vote` 二选一、**互斥**：比例（`threshold`(0,1]）或固定人数（`count` 正整数）。
 * 之所以提供 `count` 而不只给比例：国内票签文案本来就是"3 人中 2 人同意"，
 * 让用户自己做除法不合理（对照 warm-flow 的 `passCount=N`）。
 */
export type VoteSpec = { threshold: number } | { count: number };

// ─────────────────────────────────────────────────────────────────
// ② 动作层（开关名 = 引擎读的路径）
// ─────────────────────────────────────────────────────────────────

export interface ActionGate {
  /** 默认 false —— 设计期未开启，运行期提交即抛错（机制约束①） */
  allowed?: boolean | undefined;
  /** 见 {@link REQUIRE_COMMENT_DEFAULTS} */
  requireComment?: boolean | undefined;
}

export interface RejectConfig extends ActionGate {
  /** 允许驳回到的目标白名单；缺省 = 只允许 'previous'。目标须在已办节点里（D-2 AC2） */
  allowedTargets?: string[] | undefined;
  /** 是否开放 jumpTo / returnTo（打破拓扑的任意跳转），默认 false */
  allowArbitrary?: boolean | undefined;
}

export interface WithdrawConfig extends ActionGate {
  /** 默认 'currentNode'（D-5 AC6） */
  scope?: 'currentNode' | 'any' | undefined;
}

export interface AddSignConfig {
  /** 均默认 false（D-10 AC6） */
  before?: boolean | undefined;
  after?: boolean | undefined;
  /** 默认 'parallel'（D-10 AC3/AC4） */
  layout?: 'parallel' | 'serial' | undefined;
  /** 可选上限，防运行时无限加签 */
  maxCount?: number | undefined;
}

/**
 * ★ `requireComment` 的默认值 —— **按动作性质分两类，不搞一刀切**。
 *
 * - **回退类**（`reject` / `withdraw` / `revoke`）= `true`：中国式审批里"驳回不写意见"是要被追责的；
 * - **换人类**（`transfer` / `delegate`）= `false`（D-8 AC3 措辞是「requireComment=true 且未填 → 拒绝」，说明默认可填可不填）。
 *
 * ⚠️ 覆盖不到的 4 项动作（`approve` / `terminate` / `suspend`+`resume` / `saveDraft`）
 * **无设计期开关**，与主表「设计期开关」列写 `—` 的四行一致 —— 不要给它们补开关。
 */
export const REQUIRE_COMMENT_DEFAULTS = Object.freeze({
  reject: true,
  withdraw: true,
  revoke: true,
  transfer: false,
  delegate: false,
} as const);

// ─────────────────────────────────────────────────────────────────
// ③ 时间层
// ─────────────────────────────────────────────────────────────────

/**
 * ★ 工作日历 —— 决定「3 个工作日」怎么数。
 *
 * ⚠️ 本包只负责**把它原样带到调度方**：`workdays` / `hours` 是默认工作时段，
 * **`holidays` 一律由宿主提供** —— 引擎与模型层**都不内置任何法定节假日表**
 * （每家公司的放假安排不同，内置一份就是在替业务做决定，且必然过期）。
 */
export interface WorkCalendarSpec {
  id?: string | undefined;
  /** 默认 [1,2,3,4,5] */
  workdays?: number[] | undefined;
  /** 默认 [{ from: '09:00', to: '18:00' }]（F-1 AC1） */
  hours?: { from: string; to: string }[] | undefined;
  /** 'YYYY-MM-DD'；**缺省 = 不跳过任何节假日**（F-1 AC3 口径订正：无内置表） */
  holidays?: string[] | undefined;
}

export type TimeoutAction =
  | { type: 'remind'; interval?: string | undefined; max?: number | undefined }
  | { type: 'autoApprove' }
  | { type: 'autoReject'; target?: string | undefined }
  | { type: 'escalate'; to?: ApproverSpec[] | undefined };

export interface TimeoutConfig {
  /** ISO-8601：'P3D' / 'PT4H'（F-2 AC1） */
  duration?: string | undefined;
  /** 绝对时间（F-2 AC2） */
  date?: string | undefined;
  /** 周期（F-2 AC3） */
  cycle?: string | undefined;
  /**
   * 工作日历，**两种形态都原样交给调度方**（引擎不解读）：
   *   ① 字符串 = 日历 **id**（`'default'` 只是个名字，含义由调度方解释）；
   *   ② 内联对象 = 自己定义（`workdays` / `hours` / `holidays`）。
   * 默认 `'default'`。
   */
  workCalendar?: string | WorkCalendarSpec | undefined;
  /** 至少一个 */
  actions: TimeoutAction[];
}

/**
 * ⚠️ `workCalendar` 默认**不是 7×24**：「3 个工作日」必须跳过周末。
 * 不配日历时也不得退化成 7×24 —— 这是中国式审批的硬预期（F-1）。
 *
 * ⚠️ 但**法定节假日不内置**：`'default'` 只代表「周一至周五 9:00–18:00」这一默认工作时段，
 * 放假安排由宿主往 `holidays` 里给（见 {@link WorkCalendarSpec}）。
 *
 * ⚠️ 为什么 id 叫 `'default'` 而不是 `'cn-default'`（2026-10-07 改名）：
 * 它**不含任何中国法定节假日**，只是"默认工作时段"。叫 `cn-default` 会让人以为
 * 春节国庆都已经算好了 —— 名字承诺了兑现不了的东西。
 */
export const DEFAULT_WORK_CALENDAR = 'default';

/**
 * 归一化时填进去的默认值 —— **只含工作时段，不含节假日**。
 * 早期注释写「缺省用内置法定节假日」，但表里一直是空的：那是文档承诺没兑现，已订正口径。
 */
export const DEFAULT_WORK_CALENDAR_SPEC: Readonly<{
  id: string;
  workdays: number[];
  hours: { from: string; to: string }[];
  holidays: string[];
}> = Object.freeze({
  id: DEFAULT_WORK_CALENDAR,
  workdays: [1, 2, 3, 4, 5],
  hours: [{ from: '09:00', to: '18:00' }],
  holidays: [],
});

// ─────────────────────────────────────────────────────────────────
// ④ 完整接口（单事实源）
// ─────────────────────────────────────────────────────────────────

export interface Approval {
  // ── 分配层 ──
  approvers: ApproverSpec[];
  approverPolicy?: ApproverPolicy | undefined;
  mode?: ApprovalMode | undefined;
  vote?: VoteSpec | undefined;
  onReject?: OnReject | undefined;
  sequential?: boolean | undefined;
  onEmpty?: OnEmpty | undefined;

  // ── 动作层（默认全部关闭 = 白名单式，机制约束①）──
  /** reject / rejectToPrev / jumpTo / returnTo 共用此开关 */
  reject?: RejectConfig | undefined;
  withdraw?: WithdrawConfig | undefined;
  revoke?: ActionGate | undefined;
  transfer?: ActionGate | undefined;
  delegate?: ActionGate | undefined;
  addSign?: AddSignConfig | undefined;
  reduceSign?: ActionGate | undefined;

  // ── 时间层 ──
  timeout?: TimeoutConfig | undefined;

  // ── 数据层 ──
  formSnapshot?:
    | { enabled?: boolean | undefined; include?: 'all' | string[] | undefined }
    | undefined;
  signature?: { required?: boolean | undefined } | undefined;
  attachment?:
    | { required?: boolean | undefined; maxCount?: number | undefined; accept?: string[] | undefined }
    | undefined;
  commentRequired?: 'never' | 'onReject' | 'always' | undefined;

  // ── 合规层 ──
  cc?:
    | { to?: ApproverSpec[] | undefined; on?: CcTrigger[] | undefined }
    | undefined;
}

export type CcTrigger = 'approved' | 'rejected' | 'completed' | 'terminated';

/** 抄送的默认触发时机（§4.4.1 ⑤） */
export const DEFAULT_CC_TRIGGERS: readonly CcTrigger[] = Object.freeze(['completed']);

// ─────────────────────────────────────────────────────────────────
// 结构层 · zod schema
// ─────────────────────────────────────────────────────────────────

/**
 * 所有 object 一律 `.strict()`：拼错的字段名（如 `requireComments`）会被判 **error** 而不是被静默忽略 ——
 * 审批配置拼错会让行为悄悄偏离预期，这比报错危险得多（AGENTS.md §5 四禁之「吞异常返默认值」）。
 */
const ApproverSpecSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal('role'), value: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('dept'),
    value: z.string().min(1),
    includeChildren: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal('starterLeader'),
    level: z.number().int().positive().optional(),
  }).strict(),
  z.object({ type: z.literal('deptLeader'), of: z.string().optional() }).strict(),
  z.object({ type: z.literal('formField'), field: z.string().min(1) }).strict(),
  z.object({ type: z.literal('expr'), expression: z.string().min(1) }).strict(),
]);

const WorkCalendarSpecSchema = z
  .object({
    id: z.string().min(1).optional(),
    workdays: z.array(z.number().int().min(1).max(7)).optional(),
    hours: z.array(z.object({ from: z.string(), to: z.string() }).strict()).optional(),
    holidays: z.array(z.string()).optional(),
  })
  .strict();

const TimeoutActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('remind'),
    interval: z.string().optional(),
    max: z.number().int().positive().optional(),
  }).strict(),
  z.object({ type: z.literal('autoApprove') }).strict(),
  z.object({ type: z.literal('autoReject'), target: z.string().optional() }).strict(),
  z.object({ type: z.literal('escalate'), to: z.array(ApproverSpecSchema).optional() }).strict(),
]);

const TimeoutConfigSchema = z
  .object({
    duration: z.string().min(1).optional(),
    date: z.string().min(1).optional(),
    cycle: z.string().min(1).optional(),
    workCalendar: z.union([z.string().min(1), WorkCalendarSpecSchema]).optional(),
    actions: z.array(TimeoutActionSchema),
  })
  .strict();

const ActionGateSchema = z
  .object({ allowed: z.boolean().optional(), requireComment: z.boolean().optional() })
  .strict();

const RejectConfigSchema = ActionGateSchema.extend({
  allowedTargets: z.array(z.string().min(1)).optional(),
  allowArbitrary: z.boolean().optional(),
}).strict();

const WithdrawConfigSchema = ActionGateSchema.extend({
  scope: z.enum(['currentNode', 'any']).optional(),
}).strict();

const AddSignConfigSchema = z
  .object({
    before: z.boolean().optional(),
    after: z.boolean().optional(),
    layout: z.enum(['parallel', 'serial']).optional(),
    maxCount: z.number().int().positive().optional(),
  })
  .strict();

/**
 * `Approval` 的 zod 结构校验。
 *
 * `satisfies z.ZodType<Approval>` 是**编译期一致性锁**：schema 少字段、字段类型写宽/窄都会编译失败，
 * 于是「类型层」与「结构层」不会静默分叉（两处都手写 = 迟早对不上）。
 */
export const ApprovalSchema = z
  .object({
    approvers: z.array(ApproverSpecSchema).min(1),
    approverPolicy: z.enum(['all', 'any', 'first']).optional(),
    mode: z.enum(['all', 'any', 'vote']).optional(),
    /*
     * `vote` 用 **union + strict** 而不是"两个 optional 字段"：
     * 后者会让 `{ threshold: 0.5, count: 2 }` 通过结构层（两个键都合法），
     * 互斥只能靠规则层兜；用 union 则**类型层就表达了互斥**，
     * 同时给了 `{threshold:number}` / `{count:number}` 的精确输出类型。
     */
    vote: z
      .union([
        z.object({ threshold: z.number() }).strict(),
        z.object({ count: z.number() }).strict(),
      ])
      .optional(),
    onReject: z.enum(['abort', 'wait']).optional(),
    sequential: z.boolean().optional(),
    onEmpty: z.enum(['error', 'skip', 'toAdmin']).optional(),

    reject: RejectConfigSchema.optional(),
    withdraw: WithdrawConfigSchema.optional(),
    revoke: ActionGateSchema.optional(),
    transfer: ActionGateSchema.optional(),
    delegate: ActionGateSchema.optional(),
    addSign: AddSignConfigSchema.optional(),
    reduceSign: ActionGateSchema.optional(),

    timeout: TimeoutConfigSchema.optional(),

    formSnapshot: z
      .object({
        enabled: z.boolean().optional(),
        include: z.union([z.literal('all'), z.array(z.string().min(1))]).optional(),
      })
      .strict()
      .optional(),
    signature: z.object({ required: z.boolean().optional() }).strict().optional(),
    attachment: z
      .object({
        required: z.boolean().optional(),
        maxCount: z.number().int().positive().optional(),
        accept: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    commentRequired: z.enum(['never', 'onReject', 'always']).optional(),

    cc: z
      .object({
        to: z.array(ApproverSpecSchema).optional(),
        on: z.array(z.enum(['approved', 'rejected', 'completed', 'terminated'])).optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<Approval>;

/**
 * `Approval` 的**合法键集合** —— 由 schema 推导，不是手列。
 * 设计器的属性面板、导入时的未知字段提示都读它。
 */
export const APPROVAL_KEYS: readonly string[] = Object.freeze(
  Object.keys((ApprovalSchema as unknown as { shape: Record<string, unknown> }).shape),
);

/**
 * 7 类 `ApproverSpec` 的 `type` 取值 —— **由 schema 推导**（不手列，手列错过三次）。
 * 顺序 = 声明顺序（user → expr），设计器的下拉框直接用它。
 */
export const APPROVER_SPEC_TYPES: readonly string[] = Object.freeze(
  (
    ApproverSpecSchema as unknown as {
      options: readonly { shape: { type: { value: string } } }[];
    }
  ).options.map((o) => o.shape.type.value),
);

// ─────────────────────────────────────────────────────────────────
// 规则层 · 跨字段的互斥与组合矩阵
// ─────────────────────────────────────────────────────────────────

/** 宽松读取：结构层已经报错时，规则层仍要能安全地把剩下的规则跑完 */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * ★ `approverPolicy` × `mode` 组合矩阵（§4.4.1 ②）。
 *
 * 这是「互斥规则」的具体答案，也是**唯一**需要跨两个字段判定的地方。
 * 返回 `'error'` / `'warn'` / `'ok'`，让调用方决定通道。
 */
export function checkPolicyMode(
  policy: ApproverPolicy,
  mode: ApprovalMode | undefined,
): { level: 'ok' | 'warn' | 'error'; reason: string; expected?: string[] } {
  if (policy === 'any' && (mode === 'all' || mode === 'vote')) {
    return {
      level: 'error',
      reason: `\`approverPolicy:'any'\` 表示「取一个候选人即办理」，与 \`mode:'${mode}'\`（多人汇聚）自相矛盾`,
      expected: ['any'],
    };
  }
  if (policy === 'first' && mode !== undefined) {
    return {
      level: 'warn',
      reason: `\`approverPolicy:'first'\` 已是单人审批，显式写 \`mode:'${mode}'\` 是冗余`,
    };
  }
  return { level: 'ok', reason: '' };
}

export interface ValidateOptions {
  /** 模型定位：节点 id */
  nodeId?: string | undefined;
  /** 模型定位：路径前缀，如 `processes[0].nodes[3].extension['floken:approval']` */
  path?: string | undefined;
}

/**
 * 校验一份 `Approval`，返回诊断列表（**不抛**）。
 *
 * 两阶段：
 * 1. 结构层（zod）→ 类型/枚举/必填/unknown-key；
 * 2. 规则层（自研）→ 组合矩阵、`vote` 互斥与取值、`timeout` 三选一、`approvers` 非空。
 *
 * 结构层失败也**继续跑**规则层：一次把问题说全，比「报第一个就停」省往返。
 */
export function validateApproval(input: unknown, opts: ValidateOptions = {}): Diagnostic[] {
  const base = opts.path ?? 'approval';
  const node: NodeRef | undefined = opts.nodeId ? { id: opts.nodeId } : undefined;
  const at = (p: string): NodeRef => ({ ...(node ?? {}), path: joinPath(base, p) });
  const out: Diagnostic[] = [];
  const v = asRecord(input);

  // ── 阶段 1：结构层 ──
  const parsed = ApprovalSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const p = issue.path.map((s) => String(s)).join('.');
      if (issue.code === 'unrecognized_keys') {
        const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
        const loc: { node: NodeRef; suggestions?: string[] } = { node: at(p) };
        if (keys.length) loc.suggestions = ['请对照 `APPROVAL_KEYS` 检查拼写'];
        out.push(
          diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_UNKNOWN_KEY,
            `未识别的字段：${keys.join(', ')}`, loc),
        );
        continue;
      }
      /*
       * `vote` 是 union：两个键都给 → 两个分支都不匹配 → zod 报 `invalid_union`。
       * 这里换成专属码 + 人话，因为「互斥」是有业务含义的规则，不是"类型不对"。
       */
      const rawVote = v ? asRecord(v['vote']) : undefined;
      if (issue.code === 'invalid_union' && p === 'vote' && rawVote) {
        const both =
          asNumber(rawVote['threshold']) !== undefined && asNumber(rawVote['count']) !== undefined;
        if (both) {
          out.push(
            diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_VOTE_EXCLUSIVE,
              '`vote.threshold` 与 `vote.count` 互斥，只能给一个',
              { node: at('vote'), expected: ['threshold', 'count'] }),
          );
          continue;
        }
      }
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE, issue.message, { node: at(p) }),
      );
    }
  }

  // ── 阶段 2：规则层（读原始值，结构层失败也不影响跑完）──
  if (!v) {
    out.push(
      diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE, '审批配置必须是对象', { node: { ...(node ?? {}), path: base } }),
    );
    return out;
  }

  // 审批人至少一个
  const approvers = asArray(v['approvers']);
  if (approvers === undefined) {
    out.push(
      diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_APPROVER_REQUIRED, '缺少 `approvers`', { node: at('approvers') }),
    );
  } else if (approvers.length === 0) {
    out.push(
      diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_APPROVER_REQUIRED, '`approvers` 至少需要一个', {
        node: at('approvers'),
        expected: ['至少 1 个 ApproverSpec'],
      }),
    );
  }

  // 组合矩阵
  const policy = (asString(v['approverPolicy']) ?? 'all') as ApproverPolicy;
  const mode = asString(v['mode']) as ApprovalMode | undefined;
  const verdict = checkPolicyMode(policy, mode);
  if (verdict.level !== 'ok') {
    const loc: { node: NodeRef; expected?: string[] } = { node: at('mode') };
    if (verdict.expected) loc.expected = verdict.expected;
    out.push(
      diagnostic(
        verdict.level,
        verdict.level === 'error'
          ? MODDLE_DIAGNOSTIC_CODES.VALIDATE_POLICY_MODE
          : MODDLE_DIAGNOSTIC_CODES.VALIDATE_POLICY_MODE_REDUNDANT,
        verdict.reason,
        loc,
      ),
    );
  }

  // vote（互斥已在结构层由 union 判定，这里只管"缺"与"越界"）
  const vote = asRecord(v['vote']);
  const hasThreshold = asNumber(vote?.['threshold']) !== undefined;
  const hasCount = asNumber(vote?.['count']) !== undefined;
  if (mode === 'vote' && !hasThreshold && !hasCount) {
    out.push(
      diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_VOTE_REQUIRED,
        "`mode:'vote'` 必须给出 `vote.threshold` 或 `vote.count`",
        { node: at('vote'), expected: ['threshold', 'count'] }),
    );
  } else if (hasThreshold) {
    const t = asNumber(vote?.['threshold']) as number;
    if (!(t > 0 && t <= 1)) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_VOTE_RANGE,
          '`vote.threshold` 是比例，取值须在 (0, 1]',
          { node: at('vote.threshold'), expected: ['(0, 1] 之间的数值'] }),
      );
    }
  } else if (hasCount) {
    const c = asNumber(vote?.['count']) as number;
    if (!Number.isInteger(c) || c < 1) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_VOTE_RANGE,
          '`vote.count` 必须是正整数',
          { node: at('vote.count'), expected: ['≥ 1 的整数'] }),
      );
    }
  }

  // timeout：duration / date / cycle 三选一、互斥
  const timeout = asRecord(v['timeout']);
  if (timeout) {
    const given = ['duration', 'date', 'cycle'].filter((k) => asString(timeout[k]) !== undefined);
    if (given.length > 1) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TIMEOUT_EXCLUSIVE,
          `\`timeout\` 的 ${given.join(' / ')} 互斥，只能给一个`,
          { node: at('timeout'), expected: ['duration', 'date', 'cycle'] }),
      );
    } else if (given.length === 0) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_REQUIRED,
          '`timeout` 必须给出 duration / date / cycle 之一',
          { node: at('timeout'), expected: ['duration', 'date', 'cycle'] }),
      );
    }
    const actions = asArray(timeout['actions']);
    if (actions === undefined || actions.length === 0) {
      out.push(
        diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TIMEOUT_ACTION_REQUIRED,
          '`timeout.actions` 至少需要一个',
          { node: at('timeout.actions'), expected: ['remind', 'autoApprove', 'autoReject', 'escalate'] }),
      );
    }
  }

  return out;
}

/** 严格模式：有 error 级诊断就抛（其余通道一律返回诊断） */
export function assertValidApproval(input: unknown, opts: ValidateOptions = {}): Approval {
  const ds = validateApproval(input, opts);
  const errs = ds.filter((d) => d.severity === 'error');
  if (errs.length) throw validationFailedError(errs.length, errs);
  return input as Approval;
}

// ─────────────────────────────────────────────────────────────────
// 归一化 · 默认值的唯一出处
// ─────────────────────────────────────────────────────────────────

/** 归一化后的 `Approval`：设计期可省的全都填好，引擎读它不必再判空 */
export interface NormalizedApproval {
  approvers: ApproverSpec[];
  approverPolicy: ApproverPolicy;
  /** 办理人数为 1 时**不生效**（等价 'any'），不报错 */
  mode: ApprovalMode;
  vote?: VoteSpec;
  onReject: OnReject;
  sequential: boolean;
  onEmpty: OnEmpty;

  /** `allowedTargets` 缺省 = `['previous']`（D-2 AC2） */
  reject: { allowed: boolean; requireComment: boolean; allowArbitrary: boolean; allowedTargets: string[] };
  withdraw: { allowed: boolean; requireComment: boolean; scope: 'currentNode' | 'any' };
  revoke: { allowed: boolean; requireComment: boolean };
  transfer: { allowed: boolean; requireComment: boolean };
  delegate: { allowed: boolean; requireComment: boolean };
  addSign: { before: boolean; after: boolean; layout: 'parallel' | 'serial'; maxCount?: number | undefined };
  reduceSign: { allowed: boolean; requireComment?: boolean | undefined };

  timeout?: NormalizedTimeout;

  formSnapshot: { enabled: boolean; include?: 'all' | string[] };
  signature: { required: boolean };
  attachment: { required: boolean; maxCount?: number; accept?: string[] };
  commentRequired: NonNullable<Approval['commentRequired']>;

  cc?: { to?: ApproverSpec[]; on: CcTrigger[] };
}

export interface NormalizedTimeout extends Omit<TimeoutConfig, 'workCalendar' | 'actions'> {
  duration?: string;
  date?: string;
  cycle?: string;
  workCalendar: string | Required<WorkCalendarSpec>;
  actions: TimeoutAction[];
}

/**
 * 填默认值。**先校验后归一化** —— 有 error 就抛，绝不拿一份坏配置硬凑出默认值
 * （AGENTS.md §5 四禁之「吞异常返默认值」）。
 */
export function normalizeApproval(input: unknown, opts: ValidateOptions = {}): NormalizedApproval {
  const ds = validateApproval(input, opts);
  const errs = ds.filter((d) => d.severity === 'error');
  if (errs.length) throw validationFailedError(errs.length, errs);
  const a = input as Approval;

  const gate = (
    cfg: ActionGate | undefined,
    key: keyof typeof REQUIRE_COMMENT_DEFAULTS,
  ): { allowed: boolean; requireComment: boolean } => ({
    allowed: cfg?.allowed ?? false,
    requireComment: cfg?.requireComment ?? REQUIRE_COMMENT_DEFAULTS[key],
  });

  return {
    approvers: a.approvers,
    approverPolicy: a.approverPolicy ?? 'all',
    mode: a.mode ?? 'all',
    ...(a.vote ? { vote: a.vote } : {}),
    onReject: a.onReject ?? 'abort',
    sequential: a.sequential ?? false,
    onEmpty: a.onEmpty ?? 'error',

    reject: {
      allowed: a.reject?.allowed ?? false,
      requireComment: a.reject?.requireComment ?? REQUIRE_COMMENT_DEFAULTS.reject,
      allowArbitrary: a.reject?.allowArbitrary ?? false,
      allowedTargets: a.reject?.allowedTargets ?? ['previous'],
    },
    withdraw: {
      allowed: a.withdraw?.allowed ?? false,
      requireComment: a.withdraw?.requireComment ?? REQUIRE_COMMENT_DEFAULTS.withdraw,
      scope: a.withdraw?.scope ?? 'currentNode',
    },
    revoke: gate(a.revoke, 'revoke'),
    transfer: gate(a.transfer, 'transfer'),
    delegate: gate(a.delegate, 'delegate'),
    addSign: {
      before: a.addSign?.before ?? false,
      after: a.addSign?.after ?? false,
      layout: a.addSign?.layout ?? 'parallel',
      ...(a.addSign?.maxCount !== undefined ? { maxCount: a.addSign.maxCount } : {}),
    },
    reduceSign: { allowed: a.reduceSign?.allowed ?? false },

    ...(a.timeout ? { timeout: normalizeTimeout(a.timeout) } : {}),

    formSnapshot: {
      enabled: a.formSnapshot?.enabled ?? false,
      ...(a.formSnapshot?.include !== undefined ? { include: a.formSnapshot.include } : {}),
    },
    signature: { required: a.signature?.required ?? false },
    attachment: {
      required: a.attachment?.required ?? false,
      ...(a.attachment?.maxCount !== undefined ? { maxCount: a.attachment.maxCount } : {}),
      ...(a.attachment?.accept !== undefined ? { accept: a.attachment.accept } : {}),
    },
    commentRequired: a.commentRequired ?? 'onReject',

    ...(a.cc ? { cc: { ...(a.cc.to ? { to: a.cc.to } : {}), on: a.cc.on ?? [...DEFAULT_CC_TRIGGERS] } } : {}),
  };
}

function normalizeTimeout(t: TimeoutConfig): NormalizedTimeout {
  const wc = t.workCalendar ?? DEFAULT_WORK_CALENDAR;
  return {
    ...(t.duration !== undefined ? { duration: t.duration } : {}),
    ...(t.date !== undefined ? { date: t.date } : {}),
    ...(t.cycle !== undefined ? { cycle: t.cycle } : {}),
    workCalendar:
      typeof wc === 'string'
        ? wc
        : {
            id: wc.id ?? DEFAULT_WORK_CALENDAR_SPEC.id,
            workdays: wc.workdays ?? [...DEFAULT_WORK_CALENDAR_SPEC.workdays],
            hours: wc.hours ?? [...DEFAULT_WORK_CALENDAR_SPEC.hours],
            holidays: wc.holidays ?? [...DEFAULT_WORK_CALENDAR_SPEC.holidays],
          },
    actions: t.actions,
  };
}

/**
 * ★ 会签 / 票签的**提前终止规则**（§4.4.1「提前终止规则」，对照 warm-flow 补齐）。
 *
 * Camunda 的 `completionCondition` 只表达**正向**条件（够票就推进）；国内 OA 的真实预期是
 * **反向**也要判 —— 一旦票数已不可能达标，不该继续等。放在模型层是为了让引擎**没有自由心证的空间**。
 *
 * @param total   办理人总数
 * @param passed  已通过数
 * @param rejected 已驳回数
 */
export function shouldTerminate(
  mode: ApprovalMode,
  total: number,
  passed: number,
  rejected: number,
  opts: { onReject?: OnReject | undefined; vote?: VoteSpec | undefined } = {},
): {
  done: boolean;
  outcome: 'approved' | 'rejected' | 'pending';
  reason: string;
  /** 是否取消其余待办（`onReject:'wait'` 时不取消，让其余人继续表态） */
  cancelRest: boolean;
} {
  const pending = total - passed - rejected;
  const abort = (opts.onReject ?? 'abort') === 'abort';
  const done = (
    outcome: 'approved' | 'rejected',
    reason: string,
    cancelRest: boolean,
  ) => ({ done: true, outcome, reason, cancelRest });
  const wait = (reason: string) =>
    ({ done: false, outcome: 'pending' as const, reason, cancelRest: false });

  /*
   * ★ **规则序修正（2026-10-01，`floken-engine` 的 D-21 / D-31）**
   *
   * 旧实现把「全员表态后按多数定（`pending === 0`）」放在**最前面**、且**不看 `mode`**，
   * 于是会签 3 人「2 通过 1 驳回」被判成 **approved** —— 与会签的定义（**全部通过**才推进）
   * 直接冲突，也违反 `03-engine` §5.2 的判定式（`approved + rejected >= total && rejected === 0`）。
   *
   * 根因：这条"多数决"压根不是 §4.4.1 的规则三。规则三写的是「**待办只剩 1 人**时不再算比例，
   * 由该人决定」，是**票签**的兜底（防除不尽 / 永远卡住）；旧实现把它误写成 `pending === 0`
   * 且提到模式判定之前，等于把"多数决"叠加到了会签的"全票决"上。
   *
   * ⇒ 修正为：**先按 `mode` 判各自的语义，"全员已表态"的兜底只对票签生效**。
   */
  if (mode === 'any') {
    if (passed >= 1) return done('approved', '或签：一人通过即推进', true);
    if (pending === 0) return done('rejected', '或签：全员已表态且无人通过', true);
    return wait('或签：等待任一通过');
  }

  if (mode === 'all') {
    // 规则一（会签驳回即终止）：会签 = 全票决，只要有人驳回，结果就必须是 rejected
    if (rejected >= 1) {
      /*
       * ★ `onReject` 只决定**要不要提前终止**，不决定**最后按什么定**（D-31）：
       *   - `'abort'` → 立即整体驳回并取消其余；
       *   - `'wait'` 且还有人没表态 → 继续等（"记录驳回但其余继续"）；
       *   - `'wait'` 且全员已表态 → 驳回，但不取消（已无人可取消）。
       */
      if (!abort && pending > 0) {
        return wait('会签：已记录驳回，等待其余成员表态（onReject=wait）');
      }
      return done('rejected', abort ? '会签：任一人驳回即整体驳回（onReject=abort）' : '会签：有人驳回', abort);
    }
    if (passed === total) return done('approved', '会签：全部通过', true);
    return wait('会签：等待剩余人员');
  }

  /*
   * mode === 'vote'：由**票数**判定，`onReject` 在这里不参与"要不要终止"的判断 ——
   * 票签的本意就是容忍部分反对，一有反对票就整体驳回的话票签没有意义。
   * `onReject` 只影响「确定驳回后是否取消其余待办」（体现在返回的 `cancelRest`）。
   */
  const need = requiredVotes(total, opts.vote);
  if (passed >= need) return done('approved', `票签：已达 ${need} 票`, true);
  // 规则二（票签反向提前终止）：剩余票已不可能凑够
  if (passed + pending < need) {
    return done('rejected', `票签：剩余 ${pending} 人即使全部通过也达不到 ${need} 票`, abort);
  }
  // 规则三（兜底）：全员表态后按已表态结果定 —— 只对票签成立（防除不尽 / 永远卡住）
  if (pending === 0) {
    return done(passed > rejected ? 'approved' : 'rejected', '票签：所有人已表态', true);
  }
  return wait(`票签：还需 ${need - passed} 票`);
}

/**
 * 票签需要几票。`threshold` 是**比例** `(0,1]`，向上取整（3 人 × 0.5 = 2 票，与"过半"同义）。
 * 与 Camunda 的 `nrOfCompletedInstances/nrOfInstances >= r` 同义，只是这里算成整数人数。
 */
export function requiredVotes(total: number, vote?: VoteSpec): number {
  if (!vote) return total;
  if ('count' in vote && typeof vote.count === 'number') return Math.min(vote.count, total);
  const threshold = (vote as { threshold?: number }).threshold;
  if (typeof threshold !== 'number') return total;
  return Math.min(total, Math.ceil(total * threshold));
}
