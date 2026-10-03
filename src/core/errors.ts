/**
 * @floken-io/moddle · 错误与诊断契约（moddle 侧实现）
 *
 * 五包通用的错误处理契约见仓库根 `AGENTS.md` §5「错误处理契约」。本档落实 moddle 这一侧，
 * 形态与 `floken-feel/src/core/errors.ts` **逐字对齐**（两包零互相依赖，故各写一份）：
 *
 * 1. **两条通道不许混**：`ModdleError` 系（抛出，调用方无法继续） vs `Diagnostic`（随结果返回，可继续）。
 *    模型校验属于后者 —— 换一份模型还有救，所以 `validate*` 一律返回 `Diagnostic[]`。
 * 2. **错误码是稳定契约**：一旦发布不得改名（性质同 XML 前缀），只能新增。
 *    命名规则 `<域>_<类别>_<对象>`，全大写蛇形，域 = 包短名（本包 `MODDLE`）。
 * 3. **抛出码与诊断码分属两个命名空间、不得重叠**（AGENTS.md §5.3 硬约束②）：
 *    - 诊断码统一 `MODDLE_VALIDATE_*`（模型不合格，可改）；
 *    - 抛出码 `MODDLE_ARG_*`（API 契约被破坏）/ `MODDLE_PARSE_*`（XML 解析，M2 起）/ `MODDLE_MODEL_*`（严格模式升级）。
 * 4. **message 面向人、不含易变数据**：id / 字段名 / 合法取值一律进 `details` 或 `node`。
 * 5. **禁止只给一句「校验失败」**（AGENTS.md §5.4）：每条诊断必须带 `node.path`；
 *    期望类（枚举取值、互斥组合）必须额外给 `expected`，让人知道该改成什么。
 */

/** 诊断分级（与 feel 侧同一组取值） */
export type Severity = 'error' | 'warn' | 'info';

/** 源码定位：**0-based、左闭右开**（XML 解析场景用） */
export interface Position {
  from: number;
  to: number;
}

/** 模型定位：`path` 形如 `processes[0].nodes[3].extension['floken:approval']` */
export interface NodeRef {
  id?: string;
  path?: string;
}

/**
 * 统一诊断形状。
 *
 * 与 feel 侧的唯一差别是 `start` / `end` 在这里**可选**：
 * moddle 有两种定位场景 —— XML 源码（用扁平偏移 `start`/`end`）与模型节点（用 `node`），
 * feel 只用到前者故必填，本包两者都会用到。
 * **约束：每条诊断至少给出一种定位**（测试断言，见 `test/errors.test.ts`）。
 */
export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  /** 源码定位（XML 场景）：扁平偏移，0-based 左闭右开 */
  start?: number;
  end?: number;
  /** 模型定位（JSON 场景） */
  node?: NodeRef;
  /** 此处期望的取值（枚举、互斥组合的合法项） */
  expected?: string[];
  /** 「可能是想写 X」 */
  suggestions?: string[];
}

// ---------------- 错误码 ----------------

/** 抛出类错误码（`ModdleError` 家族） */
export const MODDLE_ERROR_CODES = {
  /** API 契约被破坏：入参类型/形状不对（不是"模型不合格"，是"你调错了"） */
  ARG_INVALID_INPUT: 'MODDLE_ARG_INVALID_INPUT',
  /** 未知选项（**禁止静默忽略**，AGENTS.md §5.1） */
  ARG_UNKNOWN_OPTION: 'MODDLE_ARG_UNKNOWN_OPTION',
  /**
   * 严格模式（{@link assertValidDefinition}）把 error 级诊断升级为抛错。
   * ⚠️ 码是**一个**，具体几条不合格放 `details.diagnostics` ——
   * 不要为每种校验失败各发一个码，那条路走下去码表会失控且无法稳定。
   */
  MODEL_VALIDATION_FAILED: 'MODDLE_MODEL_VALIDATION_FAILED',
} as const;

/** 诊断类错误码（不抛，随结果返回） */
export const MODDLE_DIAGNOSTIC_CODES = {
  /** 结构层：类型/枚举/必填不成立（由 zod issue 转来） */
  VALIDATE_TYPE: 'MODDLE_VALIDATE_TYPE',
  /** 结构层：出现未识别的键（拼错字段名 → 审批行为会静默失效，故 error 不是 warn） */
  VALIDATE_UNKNOWN_KEY: 'MODDLE_VALIDATE_UNKNOWN_KEY',
  /** 规则层：必填缺失（schema 已覆盖的大多数，这里留给跨字段的「至少一个」） */
  VALIDATE_REQUIRED: 'MODDLE_VALIDATE_REQUIRED',
  /** 规则层：审批人至少一个 */
  VALIDATE_APPROVER_REQUIRED: 'MODDLE_VALIDATE_APPROVER_REQUIRED',
  /** 规则层★：`approverPolicy` × `mode` 组合自相矛盾（如 `any` + `all`） */
  VALIDATE_POLICY_MODE: 'MODDLE_VALIDATE_POLICY_MODE',
  /** 规则层★：`first` + 显式 `mode` —— 冗余，warn */
  VALIDATE_POLICY_MODE_REDUNDANT: 'MODDLE_VALIDATE_POLICY_MODE_REDUNDANT',
  /** 规则层：`mode:'vote'` 缺 `vote` */
  VALIDATE_VOTE_REQUIRED: 'MODDLE_VALIDATE_VOTE_REQUIRED',
  /** 规则层：`vote` 同时给了 `threshold` 与 `count`（互斥） */
  VALIDATE_VOTE_EXCLUSIVE: 'MODDLE_VALIDATE_VOTE_EXCLUSIVE',
  /** 规则层：`vote.threshold` 越界（须 (0,1]）或 `count` 非正整数 */
  VALIDATE_VOTE_RANGE: 'MODDLE_VALIDATE_VOTE_RANGE',
  /** 规则层：`timeout` 的 duration/date/cycle 给了多于一个（互斥） */
  VALIDATE_TIMEOUT_EXCLUSIVE: 'MODDLE_VALIDATE_TIMEOUT_EXCLUSIVE',
  /** 规则层：`timeout.actions` 一个都没有 */
  VALIDATE_TIMEOUT_ACTION_REQUIRED: 'MODDLE_VALIDATE_TIMEOUT_ACTION_REQUIRED',
  /** 规则层：模型内部引用悬空（flow.from/to、layout 指向不存在的元素） */
  VALIDATE_DANGLING_REF: 'MODDLE_VALIDATE_DANGLING_REF',
  /** 规则层：id 重复 */
  VALIDATE_DUPLICATE_ID: 'MODDLE_VALIDATE_DUPLICATE_ID',
  /**
   * 规则层：元素类型不在覆盖表内（warn 不是 error —— 保全优先，绝不静默丢弃）。
   * 覆盖表见 `spec/coverage.ts`（27 类可执行 + 21 类不可执行）。
   *
   * ⚠️ **v2 起该码不再产生**：BPMN 覆盖表随 XML 一起删除，类型判定改由
   * `VALIDATE_NODE_TYPE` 负责（白名单 = 引擎真正能分派的 21 类）。
   * 码**保留不删**（错误码是发布后不得改名的稳定契约），仅供历史模型诊断对照。
   */
  VALIDATE_ELEMENT_UNSUPPORTED: 'MODDLE_VALIDATE_ELEMENT_UNSUPPORTED',
  /**
   * ★ v2：节点 `type` 不在白名单 {@link NODE_TYPES} 内，也不在 `customNodeTypes` 里。
   *
   * **error 不是 warn**：拼错 `userTaks` 若被静默接受，引擎要等**令牌到达**才报
   * 「未知节点类型」，排查成本高一个量级（§3.3）。
   */
  VALIDATE_NODE_TYPE: 'MODDLE_VALIDATE_NODE_TYPE',
  /**
   * ★ v2：类型在白名单内，但**引擎尚未实现**（4 类）。
   *
   * **warn 不是 error** —— 建模期放行；引擎在令牌到达时抛错并指名归属 FR，
   * **绝不静默直通**（AC-M2）。
   */
  VALIDATE_NODE_UNIMPLEMENTED: 'MODDLE_VALIDATE_NODE_UNIMPLEMENTED',
  /**
   * ★ v2：`extension` 袋里出现了模型的一等字段键（见 `NODE_RESERVED_KEYS`）。
   *
   * **error**：一等字段与袋里那份「哪个生效」会变成未定义行为（§4.5 硬边界）。
   */
  VALIDATE_RESERVED_KEY: 'MODDLE_VALIDATE_RESERVED_KEY',
  /**
   * ★ v2：`schemaVersion` 的 major 不是本包认识的版本。
   *
   * **error 且不做迁移**：v1 → v2 不提供迁移（§10）。「读旧格式读出一个行为不同的流程」
   * 比「当场报错」危险得多。
   */
  VALIDATE_SCHEMA_VERSION: 'MODDLE_VALIDATE_SCHEMA_VERSION',
  /**
   * ★ v2：传给 `validateDefinition` 的选项名拼错。
   * 落在诊断通道而不是抛出，是因为校验器**不因首错中断**的整体纪律（AC-M8）。
   */
  VALIDATE_UNKNOWN_OPTION: 'MODDLE_VALIDATE_UNKNOWN_OPTION',
  /**
   * 规则层：`id` 不是合法标识符（NCName 规则）。
   *
   * ★ **error 不是 warn**：非法 id 会被别人整体判废（bpmn-moddle 报 `illegal ID <1s>`），
   * 而我们自己的读取是宽容的 —— 这类问题**只在交叉验证时才暴露**，必须在建模期拦住。
   */
  VALIDATE_INVALID_ID: 'MODDLE_VALIDATE_INVALID_ID',
  /**
   * 导出：一等字段的值**不属于该元素类型**。
   *
   * ⚠️ **v2 起该码不再产生**（判据 `effectiveProperties().isAttr` 随 BPMN 类型表删除）。
   * 码保留不删（稳定契约），仅供历史模型诊断对照。
   */
  VALIDATE_ATTR_NOT_ALLOWED: 'MODDLE_VALIDATE_ATTR_NOT_ALLOWED',
  /**
   * 导入宽容：BPMN 命名空间里**覆盖表未登记**的元素已原样快照保全（纪律一）。
   *
   * ⚠️ **v2 起该码不再产生**（覆盖表随 XML 删除）。码保留不删，仅供历史模型诊断对照。
   */
  VALIDATE_ELEMENT_PRESERVED: 'MODDLE_VALIDATE_ELEMENT_PRESERVED',
  /**
   * **图面信息残缺**：连线折点不足 2 个，这条边无法成立，坐标会被跳过。
   *
   * **warn 不是 error**：图面信息不参与执行语义，定义本身仍可用；
   * 但必须说出来 —— 静默丢坐标会让用户看到"线莫名少了一条"而无从归因。
   */
  VALIDATE_DI_INCOMPLETE: 'MODDLE_VALIDATE_DI_INCOMPLETE',
} as const;

export type ModdleErrorCode =
  (typeof MODDLE_ERROR_CODES)[keyof typeof MODDLE_ERROR_CODES];
export type ModdleDiagnosticCode =
  (typeof MODDLE_DIAGNOSTIC_CODES)[keyof typeof MODDLE_DIAGNOSTIC_CODES];

// ---------------- 抛出类错误 ----------------

export interface ModdleErrorInit {
  code: string;
  /** 源码定位（XML 场景） */
  position?: Position;
  /** 模型定位（JSON 场景） */
  node?: NodeRef;
  /** 一句修复提示（人读） */
  hint?: string;
  /** 结构化补充：id、字段名、合法取值等**可断言**的数据 */
  details?: Record<string, unknown>;
}

/**
 * moddle 错误基类。
 * ⚠️ 本类**不出现在任何跨包依赖里**：其他四包各有自己的基类，只保证字段形状一致。
 */
export class ModdleError extends Error {
  /** 五包统一印记：宿主可据此判断「这是 floken 的结构化错误」 */
  readonly floken = true;
  readonly pkg = 'moddle';
  readonly code: string;
  /*
   * 可选字段一律用 `declare`：**不生成实例字段**，于是未赋值时不会留下
   * `node: undefined` 这种键（`JSON.stringify` / `Object.keys` 保持干净）。
   */
  declare readonly position?: Position;
  declare readonly node?: NodeRef;
  declare readonly hint?: string;
  declare readonly details?: Record<string, unknown>;

  constructor(message: string, init: ModdleErrorInit) {
    super(message);
    this.name = new.target.name;
    this.code = init.code;
    if (init.position) this.position = init.position;
    if (init.node) this.node = init.node;
    if (init.hint) this.hint = init.hint;
    if (init.details) this.details = init.details;
  }
}

/** API 契约被破坏：入参形状不对、未知选项 */
export class ModdleArgError extends ModdleError {}

/**
 * 严格模式下模型校验不通过（error 级诊断升级而来）。
 * `details.diagnostics` 带完整诊断列表 —— 一次说清所有问题，不是"报第一个就停"。
 */
export class ModdleValidationError extends ModdleError {}

/**
 * XML 解析失败（M2 起）。**必带 `position`** —— 源文件往往上千行，
 * 没有偏移量就只能在编辑器里肉眼找。
 */
export class ModdleParseError extends ModdleError {}

// ---------------- 工厂 ----------------

/** 入参形状不对。message 只说"该是什么"，具体错在哪进 `details` */
export function argError(
  what: string,
  expected: string,
  detail: Record<string, unknown> = {},
): ModdleArgError {
  return new ModdleArgError(`${what} must be ${expected}`, {
    code: MODDLE_ERROR_CODES.ARG_INVALID_INPUT,
    details: { what, expected, ...detail },
  });
}

/** 未知选项（禁止静默忽略 —— 拼错的选项名会让行为静默偏离预期） */
export function unknownOptionError(
  key: string,
  allowed: readonly string[],
): ModdleArgError {
  return new ModdleArgError(`Unknown option '${key}'`, {
    code: MODDLE_ERROR_CODES.ARG_UNKNOWN_OPTION,
    hint: `可用选项：${allowed.join(', ')}`,
    details: { key, allowed: [...allowed] },
  });
}

/**
 * 严格校验失败：把 error 级诊断整体升级为抛错。
 *
 * 为什么码只有一个：码是**稳定契约**（发布后不得改名），而校验规则会持续增加。
 * 一条规则一个码 = 每次加规则都在改公开契约；一个码 + `details.diagnostics` = 规则随便加，契约不变。
 */
export function validationFailedError(
  count: number,
  diagnostics: readonly Diagnostic[],
  node?: NodeRef,
): ModdleValidationError {
  const init: ModdleErrorInit = {
    code: MODDLE_ERROR_CODES.MODEL_VALIDATION_FAILED,
    details: { count, diagnostics: diagnostics as Diagnostic[] },
  };
  if (node) init.node = node;
  return new ModdleValidationError(`Model validation failed with ${count} error(s)`, init);
}

/**
 * 解析错误。位置是**必需参数**而不是可选 —— 逼每个抛出点都给出偏移量。
 */
export function parseError(
  code: string,
  message: string,
  position: Position,
  extra: { hint?: string; details?: Record<string, unknown> } = {},
): ModdleParseError {
  const init: ModdleErrorInit = { code, position, details: { ...(extra.details ?? {}) } };
  if (extra.hint) init.hint = extra.hint;
  return new ModdleParseError(message, init);
}

// ---------------- 诊断工具 ----------------

/**
 * 造一条诊断。**至少一种定位**（源码或模型）是硬要求，不给就抛 ——
 * 「校验失败」这种无定位的诊断等于让人去几万行 JSON 里肉眼找。
 */
export function diagnostic(
  severity: Severity,
  code: string,
  message: string,
  loc: { node?: NodeRef; start?: number; end?: number; expected?: string[]; suggestions?: string[] } = {},
): Diagnostic {
  if (loc.node === undefined && loc.start === undefined) {
    throw new ModdleArgError('Diagnostic requires at least one of node / start', {
      code: MODDLE_ERROR_CODES.ARG_INVALID_INPUT,
      details: { code },
    });
  }
  const d: Diagnostic = { severity, code, message };
  if (loc.node) d.node = loc.node;
  if (loc.start !== undefined) d.start = loc.start;
  if (loc.end !== undefined) d.end = loc.end;
  if (loc.expected?.length) d.expected = loc.expected;
  if (loc.suggestions?.length) d.suggestions = loc.suggestions;
  return d;
}

/** 过滤出 error 级诊断 */
export function errorsOf(ds: readonly Diagnostic[]): Diagnostic[] {
  return ds.filter((d) => d.severity === 'error');
}

/** 路径拼接：`a` + `b` → `a.b`；下标用 `[n]` */
export function joinPath(base: string, ...parts: (string | number)[]): string {
  let out = base;
  for (const p of parts) {
    if (typeof p === 'number') out += `[${p}]`;
    else if (out && !out.endsWith('.')) out += p.startsWith('[') ? p : `.${p}`;
    else out += p;
  }
  return out;
}
