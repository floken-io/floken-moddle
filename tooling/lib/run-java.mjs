/*
 * 跑 Java 对照物的**唯一**入口。
 *
 * ★ 为什么不能直接 `execFileSync('java', args, { encoding:'utf8' })`：
 * 本机沙箱给子进程开 **stdout 管道** 会报 `EBUSY`（`stdio:'ignore'` 才不报错），
 * 于是会出现"时通时不通"的玄学门禁 —— 更糟的是崩溃点伪装成一次普通的验证失败，
 * 让人误以为是被测没过，而不是环境问题。
 *
 * → 改为把 stdout / stderr **重定向到文件**（`stdio` 用 fd），再读回来。
 * 没有管道，就不受这个限制。
 *
 * Java 侧 stdout 必须是 UTF-8（Windows 默认走系统编码，中文路径会写成 GBK），
 * 各 `*.java` 里已用 `PrintStream(FileDescriptor.out, true, UTF_8)` 强制 —— 见 XsdCheck.java 注释。
 */
import { commandAvailable, runRedirected } from './run-process.mjs';


/** java 在不在（同样避开管道） */
export function javaAvailable() {
  return commandAvailable('java', ['-version']);
}

/**
 * @param {object}  o
 * @param {string}  o.sandboxRoot  工作区根目录（结果临时文件的落点）
 * @param {string}  o.label        临时文件名前缀（同名的多次调用会覆盖，不累积）
 * @param {string[]}o.classpath    jar 绝对路径
 * @param {string}  o.source       单文件源码启动模式下传 .java 路径；否则 classpath 里要含主类
 * @param {string} [o.mainClass]   非单文件模式时的主类名
 * @param {string[]}o.args         其余命令行参数
 * @returns {{ ok: boolean, stdout: string, stderr: string, error: string | null }}
 */
export function runJava({ sandboxRoot, label, classpath, source, mainClass, args }) {
  const argv = source ? [source, ...args] : ['-cp', classpath.join(';'), mainClass, ...args];
  const full = source ? ['-cp', classpath.join(';'), ...argv] : argv;

  const r = runRedirected({ cwd: sandboxRoot, label, cmd: 'java', args: full });
  // slf4j 的抱怨跟门禁无关，别让它污染判读
  const cleanErr = r.stderr
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('SLF4J:'))
    .join('\n');
  return { ok: r.ok, stdout: r.stdout, stderr: cleanErr, error: r.error };
}
