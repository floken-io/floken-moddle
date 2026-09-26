/**
 * ★ `Approval` —— BLOCKER-M0 验收要求的 6 条实例化用例 + 组合矩阵 + 提前终止规则。
 *
 * 用例来源：`01-包需求-floken-moddle.md` §4.4.1 ⑥ 末尾点名的四条主路径
 * （单人 / 会签 / 或签 / 票签）+ 超时 + 抄送。
 */

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_KEYS,
  APPROVER_SPEC_TYPES,
  DEFAULT_CC_TRIGGERS,
  DEFAULT_WORK_CALENDAR,
  ModdleValidationError,
  REQUIRE_COMMENT_DEFAULTS,
  checkPolicyMode,
  normalizeApproval,
  requiredVotes,
  shouldTerminate,
  validateApproval,
  type Approval,
} from '../src/index.js';

/** 只要 error 级（warn 不算不合格） */
const errorsOf = (a: unknown) => validateApproval(a).filter((d) => d.severity === 'error');
const codesOf = (a: unknown) =>
  validateApproval(a).map((d) => `${d.severity}:${d.code}`);

// ─────────────────────────────────────────────────────────────────
// 6 条实例化用例（BLOCKER-M0 验收）
// ─────────────────────────────────────────────────────────────────

describe('★ 六条主路径实例化用例', () => {
  it('① 单人审批：policy=first，不写 mode', () => {
    const a: Approval = {
      approvers: [{ type: 'starterLeader', level: 1 }],
      approverPolicy: 'first',
    };
    expect(errorsOf(a)).toEqual([]);
    const n = normalizeApproval(a);
    expect(n.approverPolicy).toBe('first');
    expect(n.mode).toBe('all'); // 默认，但办理人 = 1 时不生效
  });

  it('② 会签：policy=all + mode=all', () => {
    const a: Approval = {
      approvers: [
        { type: 'user', value: 'u1' },
        { type: 'role', value: 'finance' },
      ],
      approverPolicy: 'all',
      mode: 'all',
    };
    expect(errorsOf(a)).toEqual([]);
    const n = normalizeApproval(a);
    expect(n.mode).toBe('all');
    expect(n.onReject).toBe('abort'); // ★ 会签默认驳回即终止
    expect(n.reject.requireComment).toBe(true); // 回退类默认要意见
  });

  it('③ 或签：policy=all + mode=any + 开驳回', () => {
    const a: Approval = {
      approvers: [{ type: 'dept', value: 'd1', includeChildren: true }],
      approverPolicy: 'all',
      mode: 'any',
      reject: { allowed: true, allowedTargets: ['starter', 'previous'] },
    };
    expect(errorsOf(a)).toEqual([]);
    const n = normalizeApproval(a);
    expect(n.mode).toBe('any');
    expect(n.reject.allowed).toBe(true);
    expect(n.reject.allowedTargets).toEqual(['starter', 'previous']);
    expect(n.reject.allowArbitrary).toBe(false);
  });

  it('④ 票签：mode=vote + threshold 0.5', () => {
    const a: Approval = {
      approvers: [
        { type: 'user', value: 'u1' },
        { type: 'user', value: 'u2' },
        { type: 'user', value: 'u3' },
      ],
      mode: 'vote',
      vote: { threshold: 0.5 },
    };
    expect(errorsOf(a)).toEqual([]);
    const n = normalizeApproval(a);
    expect(n.vote).toEqual({ threshold: 0.5 });
    expect(requiredVotes(3, n.vote)).toBe(2); // 过半：3 人 → 2 票
  });

  it('⑤ 超时：duration P3D + autoApprove（走工作日历，不是 7×24）', () => {
    const a: Approval = {
      approvers: [{ type: 'role', value: 'boss' }],
      timeout: { duration: 'P3D', actions: [{ type: 'autoApprove' }] },
    };
    expect(errorsOf(a)).toEqual([]);
    const n = normalizeApproval(a);
    expect(n.timeout?.duration).toBe('P3D');
    expect(n.timeout?.actions).toEqual([{ type: 'autoApprove' }]);
    expect(n.timeout?.workCalendar).toBe(DEFAULT_WORK_CALENDAR);
  });

  it('⑥ 抄送：cc.on 默认 completed', () => {
    const a: Approval = {
      approvers: [{ type: 'formField', field: 'manager' }],
      cc: { to: [{ type: 'role', value: 'hr' }], on: ['completed'] },
    };
    expect(errorsOf(a)).toEqual([]);
    const n = normalizeApproval(a);
    expect(n.cc?.on).toEqual(['completed']);
    // 不写 on 时取默认
    const n2 = normalizeApproval({ approvers: a.approvers, cc: { to: a.cc?.to } });
    expect(n2.cc?.on).toEqual([...DEFAULT_CC_TRIGGERS]);
  });
});

// ─────────────────────────────────────────────────────────────────
// 组合矩阵
// ─────────────────────────────────────────────────────────────────

describe('★ approverPolicy × mode 组合矩阵（§4.4.1 ②）', () => {
  const rows: {
    policy: 'all' | 'any' | 'first';
    mode: 'all' | 'any' | 'vote' | undefined;
    level: 'ok' | 'warn' | 'error';
  }[] = [
    { policy: 'first', mode: undefined, level: 'ok' },
    { policy: 'all', mode: 'all', level: 'ok' },
    { policy: 'all', mode: 'any', level: 'ok' },
    { policy: 'all', mode: 'vote', level: 'ok' },
    { policy: 'any', mode: 'any', level: 'ok' },
    { policy: 'any', mode: 'all', level: 'error' },
    { policy: 'any', mode: 'vote', level: 'error' },
    { policy: 'first', mode: 'all', level: 'warn' },
    { policy: 'first', mode: 'any', level: 'warn' },
  ];

  it.each(rows)('$policy + $mode → $level', ({ policy, mode, level }) => {
    expect(checkPolicyMode(policy, mode).level).toBe(level);
  });

  it('自相矛盾的组合产出 error 且给出该改成什么', () => {
    const ds = validateApproval({
      approvers: [{ type: 'user', value: 'u1' }],
      approverPolicy: 'any',
      mode: 'all',
    });
    const e = ds.find((d) => d.severity === 'error');
    expect(e?.code).toBe('MODDLE_VALIDATE_POLICY_MODE');
    expect(e?.expected).toEqual(['any']);
    expect(e?.node?.path).toContain('mode');
  });

  it('冗余组合只 warn，不拦人', () => {
    const ds = validateApproval({
      approvers: [{ type: 'user', value: 'u1' }],
      approverPolicy: 'first',
      mode: 'any',
    });
    expect(ds.filter((d) => d.severity === 'error')).toEqual([]);
    expect(ds.some((d) => d.severity === 'warn' && d.code === 'MODDLE_VALIDATE_POLICY_MODE_REDUNDANT')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// 规则层：vote / timeout / approvers / unknown key
// ─────────────────────────────────────────────────────────────────

describe('vote 互斥与取值', () => {
  it('同时给 threshold 与 count → VALIDATE_VOTE_EXCLUSIVE', () => {
    expect(
      codesOf({
        approvers: [{ type: 'user', value: 'u1' }],
        mode: 'vote',
        vote: { threshold: 0.5, count: 2 },
      }),
    ).toContain('error:MODDLE_VALIDATE_VOTE_EXCLUSIVE');
  });

  it('mode=vote 却没给 vote → VALIDATE_VOTE_REQUIRED', () => {
    expect(
      codesOf({ approvers: [{ type: 'user', value: 'u1' }], mode: 'vote' }),
    ).toContain('error:MODDLE_VALIDATE_VOTE_REQUIRED');
  });

  it('threshold 越界（比例须在 (0,1]）→ VALIDATE_VOTE_RANGE', () => {
    for (const bad of [0, -0.1, 1.5]) {
      expect(
        codesOf({
          approvers: [{ type: 'user', value: 'u1' }],
          mode: 'vote',
          vote: { threshold: bad },
        }),
      ).toContain('error:MODDLE_VALIDATE_VOTE_RANGE');
    }
    expect(errorsOf({ approvers: [{ type: 'user', value: 'u1' }], mode: 'vote', vote: { threshold: 1 } })).toEqual([]);
  });

  it('count 支持「3 人中 2 人同意」这种国内说法', () => {
    const a = { approvers: [{ type: 'user', value: 'u1' }], mode: 'vote', vote: { count: 2 } } as const;
    expect(errorsOf(a)).toEqual([]);
    expect(requiredVotes(3, { count: 2 })).toBe(2);
    expect(requiredVotes(3, { count: 9 })).toBe(3); // 上限收敛到总人数
  });
});

describe('timeout 三选一、互斥', () => {
  it('duration + date 同时给 → VALIDATE_TIMEOUT_EXCLUSIVE', () => {
    expect(
      codesOf({
        approvers: [{ type: 'user', value: 'u1' }],
        timeout: { duration: 'P3D', date: '2026-10-01', actions: [{ type: 'autoApprove' }] },
      }),
    ).toContain('error:MODDLE_VALIDATE_TIMEOUT_EXCLUSIVE');
  });

  it('一个都不给 → VALIDATE_REQUIRED', () => {
    expect(
      codesOf({ approvers: [{ type: 'user', value: 'u1' }], timeout: { actions: [{ type: 'autoApprove' }] } }),
    ).toContain('error:MODDLE_VALIDATE_REQUIRED');
  });

  it('没有 actions → VALIDATE_TIMEOUT_ACTION_REQUIRED', () => {
    expect(
      codesOf({ approvers: [{ type: 'user', value: 'u1' }], timeout: { duration: 'P3D', actions: [] } }),
    ).toContain('error:MODDLE_VALIDATE_TIMEOUT_ACTION_REQUIRED');
  });
});

describe('其他规则', () => {
  it('approvers 为空 → VALIDATE_APPROVER_REQUIRED', () => {
    expect(codesOf({ approvers: [] })).toContain('error:MODDLE_VALIDATE_APPROVER_REQUIRED');
  });

  it('★ 拼错的字段名 → error 不是静默忽略（审配置拼错会让行为悄悄偏离）', () => {
    const ds = validateApproval({
      approvers: [{ type: 'user', value: 'u1' }],
      requireComments: true,
    });
    const e = ds.find((d) => d.code === 'MODDLE_VALIDATE_UNKNOWN_KEY');
    expect(e?.severity).toBe('error');
    expect(e?.message).toContain('requireComments');
  });

  it('未知 ApproverSpec 类型 → error', () => {
    expect(codesOf({ approvers: [{ type: 'boss', value: 'x' }] })).toContain(
      'error:MODDLE_VALIDATE_TYPE',
    );
  });

  it('非对象 → error', () => {
    expect(codesOf('nope')).toContain('error:MODDLE_VALIDATE_TYPE');
  });
});

// ─────────────────────────────────────────────────────────────────
// 提前终止规则（对照 warm-flow 补齐的三条）
// ─────────────────────────────────────────────────────────────────

describe('★ 会签 / 票签的提前终止规则', () => {
  it('规则一：会签任一人驳回 → 立即整体驳回（onReject 默认 abort）', () => {
    const r = shouldTerminate('all', 3, 0, 1);
    expect(r.done).toBe(true);
    expect(r.outcome).toBe('rejected');
    expect(r.cancelRest).toBe(true);
    // 'wait' 则不终止，继续等所有人表态
    expect(shouldTerminate('all', 3, 0, 1, { onReject: 'wait' }).done).toBe(false);
  });

  it('规则二：票签反向提前终止 —— 剩余票已不可能达标', () => {
    // 3 人需 2 票：已驳回 2 → 只剩 1 人，凑不够 2 票
    const r = shouldTerminate('vote', 3, 0, 2, { vote: { threshold: 0.5 } });
    expect(r.done).toBe(true);
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toContain('达不到');
    // onReject='wait' 也救不回来（不可能达标），但其余待办不取消
    const w = shouldTerminate('vote', 3, 0, 2, { vote: { threshold: 0.5 }, onReject: 'wait' });
    expect(w.outcome).toBe('rejected');
    expect(w.cancelRest).toBe(false);
  });

  it('★ 票签容忍部分反对：一有反对票就整体驳回的话票签就没意义了', () => {
    // 3 人需 2 票，已通过 1、驳回 1、剩 1 → 还有希望，继续等
    expect(shouldTerminate('vote', 3, 1, 1, { vote: { threshold: 0.5 } }).done).toBe(false);
  });

  it('规则三：最后一人兜底 —— 只剩一人时不再算比例', () => {
    // 最后一人表态通过 → 2 票达标
    expect(shouldTerminate('vote', 3, 2, 1, { vote: { threshold: 0.5 } }).outcome).toBe('approved');
    // 最后一人驳回 → 1 票未达标
    expect(shouldTerminate('vote', 3, 1, 2, { vote: { threshold: 0.5 } }).outcome).toBe('rejected');
  });

  it('或签：一人通过即推进；无人通过且无人驳回则继续等', () => {
    expect(shouldTerminate('any', 3, 1, 0).outcome).toBe('approved');
    expect(shouldTerminate('any', 3, 0, 1).done).toBe(false);
  });

  it('requiredVotes：threshold 向上取整（过半），count 收敛到总人数', () => {
    expect(requiredVotes(3, { threshold: 0.5 })).toBe(2);
    expect(requiredVotes(4, { threshold: 0.5 })).toBe(2);
    expect(requiredVotes(3, { threshold: 1 })).toBe(3);
    expect(requiredVotes(3, { threshold: 0.34 })).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// 归一化与常量
// ─────────────────────────────────────────────────────────────────

describe('normalizeApproval · 默认值只在代码里落一处', () => {
  it('空配置（只给 approvers）→ 全默认', () => {
    const n = normalizeApproval({ approvers: [{ type: 'user', value: 'u1' }] });
    expect(n).toMatchObject({
      approverPolicy: 'all',
      mode: 'all',
      onReject: 'abort',
      sequential: false,
      onEmpty: 'error',
      commentRequired: 'onReject',
    });
    // 动作层默认全关（白名单式，机制约束①）
    for (const k of ['reject', 'withdraw', 'revoke', 'transfer', 'delegate', 'reduceSign'] as const) {
      expect(n[k].allowed, k).toBe(false);
    }
    expect(n.addSign).toEqual({ before: false, after: false, layout: 'parallel' });
  });

  it('★ requireComment 按动作性质分两类，不搞一刀切', () => {
    const n = normalizeApproval({ approvers: [{ type: 'user', value: 'u1' }] });
    expect(n.reject.requireComment).toBe(REQUIRE_COMMENT_DEFAULTS.reject); // true
    expect(n.withdraw.requireComment).toBe(true);
    expect(n.revoke.requireComment).toBe(true);
    expect(n.transfer.requireComment).toBe(false);
    expect(n.delegate.requireComment).toBe(false);
  });

  it('有 error 就抛，绝不拿坏配置硬凑默认值（禁「吞异常返默认值」）', () => {
    expect(() => normalizeApproval({ approvers: [] })).toThrow(ModdleValidationError);
    expect(() => normalizeApproval({ approvers: [{ type: 'user', value: 'u1' }], mode: 'nope' })).toThrow(
      ModdleValidationError,
    );
  });

  it('assertValidApproval 严格模式：无 error 时原样返回', () => {
    const a = { approvers: [{ type: 'user', value: 'u1' }] } satisfies Approval;
    expect(validateApproval(a).filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('常量与键集合都由数据推导', () => {
  it('APPROVAL_KEYS 由 schema 推导，包含五层的关键字段', () => {
    for (const k of ['approvers', 'approverPolicy', 'mode', 'vote', 'onReject', 'timeout', 'cc']) {
      expect(APPROVAL_KEYS, k).toContain(k);
    }
    // 不含拼错/已废弃的键
    expect(APPROVAL_KEYS).not.toContain('requireComments');
  });

  it('★ 7 类 ApproverSpec 由 schema 推导（顺序 = 声明顺序）', () => {
    expect(APPROVER_SPEC_TYPES).toEqual([
      'user',
      'role',
      'dept',
      'starterLeader',
      'deptLeader',
      'formField',
      'expr',
    ]);
  });

});
