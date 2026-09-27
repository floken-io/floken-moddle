/*
 * 子进程执行的**唯一**入口 —— 关键约束：**不要给子进程开 stdout 管道**。
 *
 * ★ 本机沙箱（Windows）下 `stdio:'pipe'` 会让 `execFileSync` 直接抛 `EBUSY`，
 * 而且**时通时不通**：同一条命令有时正常、有时失败，失败点还伪装成一次普通的
 * "验证没通过"，极难归因。实测结论：
 *   · `stdio:'ignore'` → 稳定通过
 *   · `stdio:'pipe'`   → 随机 EBUSY
 * → 统一把 stdout / stderr **重定向到文件**再读回来，彻底避开管道。
 *
 * 附带修掉的坑：Java 的 `println` 在 Windows 上写 `\r\n`，
 * 不归一换行的话，`\r` 会混进每个字段（拿去做 Map 的 key 就会全对不上，
 * 症状像"Java 没跑起来"，实际是它跑得好好的）。
 */
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {object} o
 * @param {string} o.cwd          沙箱根（临时落点；不建目录在家）
 * @param {string} o.label        临时文件名前缀（同名覆盖，不累积文件）
 * @param {string} o.cmd          可执行文件绝对路径
 * @param {string[]} o.args
 * @returns {{ ok: boolean, stdout: string, stderr: string, error: string | null }}
 */
export function runRedirected({ cwd, label, cmd, args }) {
  const tmpDir = join(cwd, '.workbuddy', '_bpmn-sandbox', 'out');
  mkdirSync(tmpDir, { recursive: true });
  const outPath = join(tmpDir, `${label}.out`);
  const errPath = join(tmpDir, `${label}.err`);

  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let error = null;
  try {
    execFileSync(cmd, args, { stdio: ['ignore', outFd, errFd] });
  } catch (e) {
    error = String(e.message ?? e).slice(0, 400);
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }

  const read = (p) => {
    try {
      return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      return '';
    }
  };
  return { ok: error === null, stdout: read(outPath), stderr: read(errPath), error };
}

/** 某个可执行文件在不在（`stdio:'ignore'`，同样不用管道） */
export function commandAvailable(cmd, args = ['--version']) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
