/**
 * 错误与诊断的形状一致性（AGENTS.md §5.2 / §5.3 要求每包都有一份）。
 *
 * 五包是独立仓、禁止跨包 import 错误基类，所以**没有共享基类可以断言** ——
 * 只能逐字段断言形状。这份测试就是那道锁。
 */

import { describe, expect, it } from 'vitest';

import {
  MODDLE_DIAGNOSTIC_CODES,
  MODDLE_ERROR_CODES,
  ModdleArgError,
  ModdleError,
  ModdleValidationError,
  argError,
  diagnostic,
  joinPath,
  unknownOptionError,
  validationFailedError,
} from '../src/index.js';

const SUBCLASSES = [ModdleError, ModdleArgError, ModdleValidationError] as const;

describe('错误对象结构契约（AGENTS.md §5.2）', () => {
  it('每个子类都齐备 name / message / code / pkg / floken', () => {
    for (const Ctor of SUBCLASSES) {
      const e = new Ctor('boom', { code: MODDLE_ERROR_CODES.ARG_INVALID_INPUT });
      expect(e).toBeInstanceOf(Error);
      expect(e.floken).toBe(true);
      expect(e.pkg).toBe('moddle');
      expect(e.code).toBe('MODDLE_ARG_INVALID_INPUT');
      expect(e.message).toBe('boom');
      // ★ name 必须是**子类自己的名字**，不是基类的 —— 宿主靠它分辨
      expect(e.name).toBe(Ctor.name);
    }
  });

  it('可选字段不生成 undefined 键（JSON.stringify / Object.keys 保持干净）', () => {
    const e = new ModdleArgError('boom', { code: MODDLE_ERROR_CODES.ARG_INVALID_INPUT });
    expect(Object.keys(e)).not.toContain('node');
    expect(Object.keys(e)).not.toContain('position');
    expect(Object.keys(e)).not.toContain('hint');
    expect(Object.keys(e)).not.toContain('details');
    expect(JSON.parse(JSON.stringify(e))).toMatchObject({ floken: true, pkg: 'moddle' });
  });

  it('给了定位/提示/细节才出现对应键', () => {
    const e = new ModdleValidationError('bad', {
      code: MODDLE_ERROR_CODES.MODEL_VALIDATION_FAILED,
      node: { id: 't1', path: 'processes[0].nodes[3]' },
      hint: 'fix it',
      details: { count: 2 },
    });
    expect(e.node).toEqual({ id: 't1', path: 'processes[0].nodes[3]' });
    expect(e.hint).toBe('fix it');
    expect(e.details).toEqual({ count: 2 });
  });
});

describe('错误码命名（AGENTS.md §5.3）', () => {
  it('全大写蛇形、域前缀 MODDLE_', () => {
    for (const [k, v] of Object.entries(MODDLE_ERROR_CODES)) {
      expect(v, k).toMatch(/^MODDLE_[A-Z0-9]+(_[A-Z0-9]+)*$/);
    }
    for (const [k, v] of Object.entries(MODDLE_DIAGNOSTIC_CODES)) {
      expect(v, k).toMatch(/^MODDLE_[A-Z0-9]+(_[A-Z0-9]+)*$/);
    }
  });

  it('码表内无重复值', () => {
    const all = [...Object.values(MODDLE_ERROR_CODES), ...Object.values(MODDLE_DIAGNOSTIC_CODES)];
    expect(new Set(all).size).toBe(all.length);
  });

  it('★ 抛出码与诊断码是两个命名空间、不得重叠', () => {
    const thrown = new Set(Object.values(MODDLE_ERROR_CODES));
    for (const c of Object.values(MODDLE_DIAGNOSTIC_CODES)) {
      expect(thrown.has(c), `诊断码 ${c} 与抛出码重叠`).toBe(false);
    }
  });
});

describe('诊断形状（AGENTS.md §5.4 / §5.5）', () => {
  it('至少一种定位 —— 不给定位就抛，避免「校验失败」这种没头没尾的诊断', () => {
    expect(() => diagnostic('error', 'MODDLE_VALIDATE_TYPE', 'x')).toThrow(ModdleArgError);
  });

  it('模型定位（node 路径）能带，且为唯一定位手段', () => {
    const a = diagnostic('error', 'MODDLE_VALIDATE_TYPE', 'x', { node: { id: 'n1', path: 'a.b' } });
    expect(a.node).toEqual({ id: 'n1', path: 'a.b' });

    // JSON-only：不再有「源码偏移」定位（旧 `start`/`end` 随 XML 一起删除）
    expect(() => diagnostic('warn', 'MODDLE_VALIDATE_TYPE', 'y', {})).toThrow(ModdleArgError);
  });

  it('期望类诊断要给出合法取值（§5.4）', () => {
    const d = diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_POLICY_MODE, '组合矛盾', {
      node: { path: 'approval.mode' },
      expected: ['any'],
    });
    expect(d.expected).toEqual(['any']);
  });
});

describe('工厂', () => {
  it('unknownOptionError 列出可用选项（禁止静默忽略未知选项）', () => {
    const e = unknownOptionError('strcit', ['strict', 'lax']);
    expect(e.code).toBe('MODDLE_ARG_UNKNOWN_OPTION');
    expect(e.hint).toContain('strict');
    expect(e.details).toMatchObject({ key: 'strcit' });
  });

  it('validationFailedError 一次带全所有诊断，不是报第一个就停', () => {
    const ds = [
      diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE, 'a', { node: { path: 'a' } }),
      diagnostic('error', MODDLE_DIAGNOSTIC_CODES.VALIDATE_TYPE, 'b', { node: { path: 'b' } }),
    ];
    const e = validationFailedError(2, ds);
    expect(e.message).toBe('Model validation failed with 2 error(s)');
    // ★ message 不含易变数据：条数只在 details 里
    expect(e.details).toMatchObject({ count: 2 });
    expect((e.details?.['diagnostics'] as unknown[]).length).toBe(2);
  });

  it('argError 的 message 只说"该是什么"，易变数据进 details', () => {
    const e = argError('definition', 'an object', { got: 'string' });
    expect(e.message).toBe('definition must be an object');
    expect(e.details).toMatchObject({ got: 'string' });
  });
});

describe('joinPath', () => {
  it('拼接属性与下标', () => {
    expect(joinPath('processes', 0, 'nodes', 3)).toBe('processes[0].nodes[3]');
    expect(joinPath('a', 'b')).toBe('a.b');
    expect(joinPath("extension['floken:approval']", 'mode')).toBe(
      "extension['floken:approval'].mode",
    );
  });
});
