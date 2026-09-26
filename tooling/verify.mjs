#!/usr/bin/env node
// floken 统一发布门禁（六道通用 check 的最小可用实现）。
// 完整规格见 流程引擎包文档/06-仓库脚手架与发布约定.md §6。
// 任一道失败 -> exit 1。fail 信息须可照着修。
//
// 说明：所有子命令都优先通过 `node <script>` 直接执行（不经过 cmd.exe / npx），
// 以避免 Windows 下 spawnSync 的偶发 EBUSY；子进程仍不可用时，
// check:types / check:tests / check:pack 会退化为**进程内**实现并在输出中标注。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fails = [];
const ok = (n, extra = '') => console.log(`\x1b[32m\u2713\x1b[0m ${n}${extra ? ' \u2014 ' + extra : ''}`);
const bad = (n, msg) => { console.error(`\x1b[31m\u2717 ${n}\x1b[0m \u2014 ${msg}`); fails.push(n); };

const NODE = process.execPath;
/** 子进程不可用时的典型错误（Windows/受限沙箱偶发） */
const SPAWN_BLOCKED = /EBUSY|EAGAIN|EMFILE|EPERM|ENOENT.*spawn|spawnSync/i;

function localBin(rel, fallbackRel) {
  const p = join(root, rel);
  if (existsSync(p)) return p;
  if (fallbackRel) {
    const f = join(dirname(NODE), fallbackRel);
    if (existsSync(f)) return f;
  }
  return null;
}

function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 忽略：不支持时退化为立即重试 */
  }
}

/** 通过 node 直接执行脚本（不经 cmd.exe），带退避重试
 *
 * ⚠️ `stdio` 必须显式写成 `['ignore','pipe','pipe']`：stdin 若接成管道/继承父进程的半天管道，
 * 嵌套子进程在 Windows 下必吃 EBUSY （本项目踩过，见 AGENTS.md §4）。
 */
function run(script, args, attempts = 5) {
  const delays = [0, 500, 1500, 3000, 6000];
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return execFileSync(NODE, [script, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: root,
      });
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      if (!/EBUSY|EAGAIN|EMFILE/i.test(msg)) throw e;
      if (i < attempts - 1) sleep(delays[i] ?? 1000);
    }
  }
  throw lastErr;
}

const TSC = localBin(join('node_modules', 'typescript', 'bin', 'tsc'));
const VITEST = localBin(join('node_modules', 'vitest', 'vitest.mjs'));
const NPM_CLI = localBin(
  join('node_modules', 'npm', 'bin', 'npm-cli.js'),
  join('node_modules', 'npm', 'bin', 'npm-cli.js'),
);

// ---------- 进程内退化实现 ----------

/** 进程内调用 TypeScript API 做类型检查；无错误返回 '' */
async function tscInProcess() {
  const ts = await import(pathToFileURL(join(root, 'node_modules', 'typescript', 'lib', 'typescript.js')).href);
  const cfg = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const diags = ts.getPreEmitDiagnostics(program);
  if (!diags.length) return '';
  const host = { getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => '\n' };
  return ts.formatDiagnostics(diags, host);
}

/** 进程内跑 vitest（关掉 reporter，直接从 state 读结果）；不可用时返回 null */
async function vitestInProcess() {
  const req = createRequire(join(root, 'package.json'));
  const { startVitest } = await import(pathToFileURL(req.resolve('vitest/node')).href);
  const vitest = await startVitest('test', [], { run: true, watch: false, reporters: [] });
  const files = vitest?.state?.getFiles?.() ?? [];
  await vitest?.close?.();

  const acc = { failed: 0, passed: 0 };
  const walk = (tasks) => {
    for (const t of tasks ?? []) {
      if (t.type === 'test') {
        if (t.result?.state === 'fail') acc.failed += 1;
        else if (t.result?.state === 'pass') acc.passed += 1;
      }
      if (t.tasks) walk(t.tasks);
    }
  };
  walk(files);
  return { ...acc, total: acc.failed + acc.passed };
}

/** 退化的打包清单：按 package.json 的 files 白名单 + npm 自动包含项静态推算 */
function staticPackPaths() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const listed = (pkg.files ?? []).filter((f) => !f.startsWith('!'));
  const auto = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];
  return [...listed, ...auto.filter((f) => existsSync(join(root, f)))];
}

// 1. check:types
try {
  try {
    if (!TSC) throw new Error('typescript 未安装（找不到 node_modules/typescript/bin/tsc）');
    run(TSC, ['-p', 'tsconfig.json', '--noEmit']);
  } catch (spawnErr) {
    if (!SPAWN_BLOCKED.test(String(spawnErr.message || spawnErr))) throw spawnErr;
    const out = await tscInProcess();
    if (out) throw new Error(out);
    console.log('\u00b7 check:types \u2014 子进程不可用，已用进程内 tsc 完成');
  }
  ok('check:types');
} catch (e) {
  bad('check:types', 'tsc 报类型错误（见上方）');
  console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
}

// 2. check:tests
try {
  let note = '';
  try {
    if (!VITEST) throw new Error('vitest 未安装（找不到 node_modules/vitest/vitest.mjs）');
    run(VITEST, ['run']);
  } catch (spawnErr) {
    if (!SPAWN_BLOCKED.test(String(spawnErr.message || spawnErr))) throw spawnErr;
    const res = await vitestInProcess();
    if (!res) throw spawnErr;
    if (res.failed > 0) throw new Error(`vitest 有 ${res.failed} 个失败用例`);
    note = `子进程不可用，已用进程内 vitest 完成（${res.passed}/${res.total} 通过）`;
  }
  ok('check:tests', note);
} catch (e) {
  bad('check:tests', 'vitest 未全绿');
  console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
}

// 3. check:pack
try {
  let paths = [];
  let degraded = false;
  try {
    if (!NPM_CLI) throw new Error('npm-cli.js 未找到');
    const out = run(NPM_CLI, ['pack', '--dry-run', '--json']).toString();
    paths = (JSON.parse(out)[0].files || []).map((f) => f.path);
  } catch (spawnErr) {
    if (!SPAWN_BLOCKED.test(String(spawnErr.message || spawnErr))) throw spawnErr;
    paths = staticPackPaths();
    degraded = true;
    console.log('\u00b7 check:pack \u2014 子进程不可用，已退化为按 files 白名单静态核对');
  }

  const leaked = paths.filter(
    (p) => /(^|\/)(src|test)\//.test(p) || (/\.ts$/.test(p) && !p.endsWith('.d.ts')),
  );
  if (leaked.length) bad('check:pack', '泄漏源码/测试: ' + leaked.join(', '));
  else ok('check:pack', `${paths.length} 个文件${degraded ? '（退化口径）' : ''}`);

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const badProto = ['workspace:', 'file:', 'link:'].filter((p) => JSON.stringify(pkg).includes(p));
  if (badProto.length) bad('check:pack', '出现禁止协议: ' + badProto.join(', '));
  else ok('check:pack', '无 workspace:/file:/link:');
} catch (e) {
  bad('check:pack', 'npm pack 失败');
  console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
}

/*
 * 4a. check:deps —— **Q36**：`dependencies` 只允许 `zod` 一项（两层各不得超过一项）。
 *     这条门禁把「用户拍板的口径」固化成机器检查，防止哪天顺手加一个依赖。
 */
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  const ALLOWED = ['zod'];
  const extra = deps.filter((d) => !ALLOWED.includes(d));
  if (extra.length) bad('check:deps', 'dependencies 超出白名单（Q36）: ' + extra.join(', '));
  else ok('check:deps', `dependencies = [${deps.join(', ') || '空'}]（白名单 ${ALLOWED.join('/')}）`);
}

/*
 * 4b. check:xmllib —— **Q38**：XML 读/写全部自研，dist 不得静态引入第三方 XML 库
 *     （saxen / saxes / xmlbuilder2 / fast-xml-parser / @xmldom 等，2026-09-26 已评估否决）。
 */
const dist = join(root, 'dist');
if (existsSync(dist)) {
  const walkDir = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walkDir(join(d, e.name)) : [join(d, e.name)],
    );
  const js = walkDir(dist).filter((f) => f.endsWith('.js'));
  const BANNED = ['saxen', 'saxes', 'xmlbuilder2', 'fast-xml-parser', '@xmldom/xmldom', 'bpmn-moddle'];
  const hit = js
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
    .match(new RegExp(`from\\s+'(${BANNED.join('|')})`, 'g'));
  if (hit) bad('check:xmllib', 'dist 中检出第三方 XML 库（Q38 违例）: ' + [...new Set(hit)].join(', '));
  else ok('check:xmllib', '无第三方 XML 库静态引用（自研 SAX）');
} else {
  console.log('\u00b7 check:xmllib \u2014 跳过（dist 尚未构建）');
}

// 4.5 check:spec —— BPMN 类型表契约（137/318 + abstract 交叉校验）
//     ⚠️ 这是 floken-moddle 的**专属第七道**，不在通用六道里。
//     它需要生成期的外部源（bpmn-moddle 描述符 + OMG Semantic.xsd）；
//     源不在时**跳过**而不是判 fail —— 源是一次性脚本的输入，不进 CI 依赖链。
{
  const gen = join(root, 'scripts', 'gen-bpmn-spec.mjs');
  const WS_ROOT = dirname(root);
  const wsRoot = dirname(WS_ROOT);
  const defaultSrc = join(wsRoot, '.workbuddy/_bpmn-sandbox/node_modules/bpmn-moddle/resources/bpmn/json');
  const defaultXsd = join(wsRoot, '.workbuddy/tmp/Semantic.xsd');
  if (!existsSync(gen)) {
    bad('check:spec', 'scripts/gen-bpmn-spec.mjs 缺失');
  } else if (!existsSync(defaultSrc) || !existsSync(defaultXsd)) {
    console.log('\u00b7 check:spec \u2014 跳过（生成源不在本机，属预期：' +
      'bpmn-moddle 描述符 / Semantic.xsd 是一次性脚本输入，不进依赖）');
  } else {
    try {
      run(gen, ['--check']);
      ok('check:spec', '类型表契约 137/318 与 XSD abstract 交叉校验通过');
    } catch (e) {
      bad('check:spec', '类型表与契约不符（见上方报告）');
      console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
    }
  }
}

// 4.6 check:ac-s1 —— AC-S1 实证：导出文件必须能被 bpmn-moddle（bpmn-js 解析内核）零 warning 解析。
//     与 check:spec 同款策略：对照物不在本机就**跳过**，不判 fail（它不是依赖，也不进 dist）。
{
  const script = join(root, 'tooling', 'ac-s1.mjs');
  const S = join(dirname(dirname(root)), '.workbuddy/_bpmn-sandbox/node_modules/bpmn-moddle/dist/index.js');
  if (!existsSync(S)) {
    console.log('\u00b7 check:ac-s1 \u2014 跳过（沙箱 bpmn-moddle 不在本机；属预期，它不是依赖）');
  } else if (!existsSync(join(root, 'dist', 'index.js'))) {
    bad('check:ac-s1', 'dist 未构建，无法实证（先跑 tsup）');
  } else {
    try {
      run(script, []);
      ok('check:ac-s1', 'bpmn-moddle 零 warning 解析 + DI 覆盖完整');
    } catch (e) {
      bad('check:ac-s1', '标准工具解析不通过（见上方报告）');
      console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
    }
  }
}

// 4.7 check:miwg —— FR-S15：MIWG 真实语料「导入不崩 + 二次导出幂等」。
//     语料一次性抓取到工作区 `.workbuddy/miwg/`（`tooling/fetch-miwg.mjs`），
//     不在本机时**跳过**（不进依赖链）。
{
  const CORPUS = join(dirname(dirname(root)), '.workbuddy/miwg');
  if (!existsSync(CORPUS) || !existsSync(join(root, 'dist', 'index.js'))) {
    console.log('\u00b7 check:miwg \u2014 跳过（语料或 dist 不在本机；先跑 tooling/fetch-miwg.mjs + tsup）');
  } else {
    try {
      run(join(root, 'tooling', 'miwg.mjs'), []);
      ok('check:miwg', 'MIWG 真实语料导入不崩、二次导出幂等');
    } catch (e) {
      bad('check:miwg', '真实语料不通过（见上方报告）');
      console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
    }
  }
}

// 4.8 check:interop —— 三向互操作实证（ours→别人 / 别人→ours / 真实语料闭环 / Camunda 扩展）。
//     它是 ac-s1 的**加强版**：ac-s1 只验我们自己生成的文件，interop 还验「别人的文件经我们
//     转一圈后仍能被别人读」—— DI 的 duplicate ID、悬空引用就是这么抓出来的。
//     与 check:ac-s1 同款策略：对照物不在本机则跳过。
{
  const MODDLE = join(dirname(dirname(root)), '.workbuddy/_bpmn-sandbox/node_modules/bpmn-moddle/dist/index.js');
  if (!existsSync(MODDLE) || !existsSync(join(root, 'dist', 'index.js'))) {
    console.log('\u00b7 check:interop \u2014 跳过（沙箱 bpmn-moddle 或 dist 不在本机；属预期，它不是依赖）');
  } else {
    try {
      run(join(root, 'tooling', 'interop.mjs'), []);
      ok('check:interop', '互操作四向实证通过（含真实语料闭环与 Camunda 扩展保全）');
    } catch (e) {
      bad('check:interop', '互操作实证不通过（见上方报告）');
      console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
    }
  }
}

/*
 * 4.9 check:coverage-reality —— **「L2 可存」兑现率实证**。
 *     覆盖表说 48 类都承诺 L2，但数字是从表算的，不证明代码做得到。
 *     这条把每一类放进 **XSD 规定的合法容器**跑真实往返：35 类必须真进 Model JSON，
 *     13 类（编排/会话/关联族）必须至少**原样保全**，丢失即 fail。
 */
{
  const script = join(root, 'tooling', 'coverage-reality.mjs');
  if (!existsSync(script) || !existsSync(join(root, 'dist', 'index.js'))) {
    console.log('\u00b7 check:coverage-reality \u2014 跳过（脚本或 dist 不在本机）');
  } else {
    try {
      run(script, []);
      ok('check:coverage-reality', '48 类合法容器往返：35 L2 兑现 + 13 保全，零丢失');
    } catch (e) {
      bad('check:coverage-reality', '覆盖承诺没兑现（见上方报告）');
      console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
    }
  }
}

/*
 * 4.10 check:strict-import —— **真实语料 × 默认配置** 导入实证。
 *     曾经的默认 `onUnsupported:'throw'` 让 22 份 MIWG 语料 **0 份**能导入，
 *     而 211 条单测全绿毫发无损 —— 单测只喂我们自己写出来的形态。
 *     这条钉死：默认配置下每份真实语料都能进来，且导出的文件自己读得回来。
 */
{
  const CORPUS = join(dirname(dirname(root)), '.workbuddy/miwg');
  if (!existsSync(CORPUS) || !existsSync(join(root, 'dist', 'index.js'))) {
    console.log('\u00b7 check:strict-import \u2014 跳过（语料或 dist 不在本机）');
  } else {
    try {
      run(join(root, 'tooling', 'strict-import.mjs'), []);
      ok('check:strict-import', 'MIWG 语料默认配置 100% 可导入');
    } catch (e) {
      bad('check:strict-import', '真实语料在默认配置下用不了（见上方报告）');
      console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
    }
  }
}

/*
 * 4.11 check:corpus-fidelity —— **真实语料的信息守恒 + 可校验**。
 *     `strict-import` 只钉「能导入」，而实测证明**能导入也可能内容是空的**：
 *     4 份语料导入后节点全丢、2 份静默少了池与文档，门禁却报 22/22 通过。
 *     这条钉死两件事：① 往返后每类元素计数不减少；② 导入结果跑校验器零 error
 *     （曾经 22 份合法语料产出 464 条诊断、10 份含 error）。
 */
{
  const CORPUS = join(dirname(dirname(root)), '.workbuddy/miwg');
  if (!existsSync(CORPUS) || !existsSync(join(root, 'dist', 'index.js'))) {
    console.log('\u00b7 check:corpus-fidelity \u2014 跳过（语料或 dist 不在本机）');
  } else {
    try {
      run(join(root, 'tooling', 'corpus-fidelity.mjs'), []);
      ok('check:corpus-fidelity', '语料往返守恒 + 导入后零 error 诊断');
    } catch (e) {
      bad('check:corpus-fidelity', '真实语料信息不守恒或误报（见上方报告）');
      console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
    }
  }
}

/*
 * 4.12 check:interop-full —— **多库 × 双向**互操作实证。
 *     `interop`（第十道）只用了 bpmn-moddle 一个对照物，且未注册第三方扩展 ——
 *     它对 camunda:* 的验证只是「字符串有没有保回」，没验证对方是否**当真属性认**。
 *     这条扩到 5 个对照物并在**两个方向**上都跑：
 *       A 导出侧：bpmn-moddle / camunda-bpmn-moddle（Camunda 7）/ zeebe-bpmn-moddle（Camunda 8）
 *                 / bpmnlint（官方规则集，口径=不比对方自己建模的等价文件差）/ bpmn-engine（真执行）
 *       B 导入侧：moddle 建模 / moddle+camunda 建模 / MIWG 22 份（转后不得比基线差）
 *       C 闭环：ours → XML → 对方 → XML → ours → XML 幂等
 */
{
  const SB = join(dirname(dirname(root)), '.workbuddy/_bpmn-sandbox/node_modules/bpmn-moddle/dist/index.js');
  if (!existsSync(SB) || !existsSync(join(root, 'dist', 'index.js'))) {
    console.log('\u00b7 check:interop-full \u2014 跳过（沙箱对照库或 dist 不在本机）');
  } else {
    try {
      run(join(root, 'tooling', 'interop-full.mjs'), []);
      ok('check:interop-full', '多库 × 双向：5 个对照物导入导出全通');
    } catch (e) {
      bad('check:interop-full', '多库双向互操作失败（见上方报告）');
      console.error((e.stdout?.toString?.() || '') + (e.stderr?.toString?.() || '') + (e.message || ''));
    }
  }
}

// 5/6. size / exports — 占位（需 tsup 产物 + publint/attw，详见 06 §6）
console.log('\u00b7 check:size / check:exports \u2014 完整口径见 06-仓库脚手架与发布约定 §6');

if (fails.length) {
  console.error(`\nverify FAILED: ${fails.length} 项未通过`);
  process.exit(1);
}
console.log('\nverify PASSED');
