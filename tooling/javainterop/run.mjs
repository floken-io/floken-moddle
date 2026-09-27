/*
 * Java 生态对照物：Camunda 7 官方解析器 `camunda-bpmn-model`（verify 第十六道门禁）。
 *
 * 与第十四道 `interop-full` 的分工：那一道是 **JS / 浏览器生态**（bpmn-moddle、bpmnlint、
 * bpmn-engine），这一道是 **Java 引擎生态**（Camunda 7 / Flowable / Activiti 同族）。
 * 两者解析实现、模型抽象、校验规则**完全没有共享代码**，是真正的独立第二意见。
 *
 * 依赖：JDK（java 在 PATH 上）+ 三个 jar（Maven Central，已下载到沙箱 `.workbuddy/_bpmn-sandbox/jars`）。
 * jar 缺失则跳过，不 fail（遵循「实证脚本源不在则跳过」的纪律）。
 *
 * 用法：node run.mjs
 */
import { javaAvailable, runJava } from '../lib/run-java.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..');
const WS = join(PKG, '..', '..');
const JARS = join(WS, '.workbuddy', '_bpmn-sandbox', 'jars');
const MIWG = join(WS, '.workbuddy', 'miwg');
const OUT = join(WS, '.workbuddy', 'java-out');

const REQUIRED = [
  'camunda-bpmn-model-7.20.0.jar',
  'camunda-xml-model-7.20.0.jar',
  'slf4j-api-1.7.36.jar',
];

const javaOk = javaAvailable();
if (!javaOk || !REQUIRED.every((j) => existsSync(join(JARS, j)))) {
  console.log('· check:java-interop — 跳过（需要 JDK 与 Camunda jar；补齐后自动生效）');
  process.exit(0);
}

const { toXmlSync, fromXmlSync } = await import(
  pathToFileURL(join(PKG, 'dist', 'index.js')).href
);

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

// ── 样本：我们导出的四类 ──────────────────────────────────────────
// 同 xsd-check/run.mjs：只建目录、按名覆盖，不整目录递归删除（会触发沙箱批量删除保护）。
mkdirSync(OUT, { recursive: true });

const samples = {
  'ours-simple': {
    schemaVersion: '1.0.0',
    id: 'D1',
    name: 'java-sample',
    processes: [
      {
        id: 'P1',
        executable: true,
        nodes: [
          { id: 's', type: 'startEvent', name: '开始' },
          { id: 'g', type: 'exclusiveGateway', name: '分流', defaultFlow: 'f2' },
          { id: 't1', type: 'userTask', name: '审批' },
          { id: 'e', type: 'endEvent', name: '结束' },
        ],
        flows: [
          { id: 'f1', from: 's', to: 'g' },
          { id: 'f2', from: 'g', to: 't1' },
          { id: 'f3', from: 't1', to: 'e' },
        ],
      },
    ],
  },
  'ours-camunda': {
    schemaVersion: '1.0.0',
    id: 'D1',
    processes: [
      {
        id: 'P1',
        executable: true,
        nodes: [
          { id: 's', type: 'startEvent' },
          {
            id: 't1',
            type: 'userTask',
            name: '审批',
            extension: {
              'camunda:assignee': '${initiator}',
              'camunda:candidateGroups': 'managers',
            },
          },
          {
            id: 'sc',
            type: 'scriptTask',
            name: '脚本',
            scriptFormat: 'javascript',
            script: 'execution.setVariable("x", 1);',
          },
          { id: 'e', type: 'endEvent' },
        ],
        flows: [
          { id: 'f1', from: 's', to: 't1' },
          { id: 'f2', from: 't1', to: 'sc' },
          { id: 'f3', from: 'sc', to: 'e' },
        ],
      },
    ],
  },
};

const ours = [];
for (const [name, model] of Object.entries(samples)) {
  const p = join(OUT, `${name}.bpmn`);
  writeFileSync(p, toXmlSync(model));
  ours.push({ p, name });
}

// ── 语料：原文件 + 我们转一圈 ─────────────────────────────────────
const corpus = [];
if (existsSync(MIWG)) {
  for (const f of readdirSync(MIWG).filter((x) => x.endsWith('.bpmn')).sort()) {
    const src = join(MIWG, f);
    corpus.push({ p: src, name: `原 ${f}`, baseline: true });
    const rt = join(OUT, `miwg-${f}`);
    writeFileSync(rt, toXmlSync(fromXmlSync(readFileSync(src))));
    corpus.push({ p: rt, name: `转 ${f}`, baseline: false });
  }
}

// ── 交给 Java ────────────────────────────────────────────────────
const all = [...ours, ...corpus];
const rj = runJava({
  sandboxRoot: WS,
  label: 'javainterop',
  classpath: REQUIRED.map((j) => join(JARS, j)),
  source: join(HERE, 'CamundaCheck.java'),
  args: all.map((x) => x.p),
});
if (!rj.ok && !rj.stdout.trim()) {
  console.log(`· check:java-interop — Java 调用失败：${rj.error} ${rj.stderr.slice(0, 200)}`);
  process.exit(1);
}
const out = rj.stdout;

const result = new Map();
const errors = new Map();
for (const line of out.split('\n')) {
  if (!line.trim()) continue;
  const parts = line.split('\t');
  if (parts[0] === 'OK') result.set(parts[1], parts.slice(2).join('\t'));
  else if (parts[0] === 'FAIL') result.set(parts[1], 'FAIL: ' + parts.slice(2).join('\t'));
  else if (parts[0] === '  ERR') {
    errors.set(parts[1], [...(errors.get(parts[1]) ?? []), parts.slice(2).join('\t')]);
  }
}

console.log('\nJava 生态对照物：Camunda 7 camunda-bpmn-model 7.20.0（JDK JAXP 之外唯一依赖）');

for (const { p, name } of ours) {
  const r = result.get(p);
  const ok = typeof r === 'string' && !r.startsWith('FAIL');
  check(ok, `我们导出 · ${name}`, ok ? r : String(r));
}

// 关键语义：不是"能读"，而是"按真语义读"
const simple = result.get(ours[0].p) ?? '';
check(
  simple.includes('gateway(g).default=f2'),
  '默认分支被解析成**真引用**（gateway.default → SequenceFlow f2）',
  simple.slice(0, 120),
);
const cam = result.get(ours[1].p) ?? '';
check(
  cam.includes('assignee=${initiator}') && cam.includes('candidateGroups=managers'),
  'camunda:assignee / candidateGroups 被解析成**真属性**',
  cam.slice(0, 160),
);
check(
  cam.includes('scriptTask(sc).format=javascript'),
  'scriptTask.scriptFormat 按名字读回',
  cam.slice(0, 160),
);

// 语料：转一圈后不得比基线差
const baselineFail = new Set();
for (const c of corpus) {
  if (!c.baseline) continue;
  const r = result.get(c.p);
  if (typeof r !== 'string' || r.startsWith('FAIL')) baselineFail.add(c.name.replace('原 ', ''));
}
let worse = 0;
for (const c of corpus) {
  if (c.baseline) continue;
  const short = c.name.replace('转 ', '');
  const r = result.get(c.p);
  const ok = typeof r === 'string' && !r.startsWith('FAIL');
  if (!ok && !baselineFail.has(short)) {
    worse++;
    check(false, `${c.name} 被 Camunda 拒收（基线却通过）`, String(r).slice(0, 160));
  }
}
check(
  worse === 0,
  `MIWG ${corpus.length / 2} 份语料转一圈后 Camunda 拒收数不比基线差`,
  `基线被拒 ${baselineFail.size} 份 / 转后新增被拒 ${worse} 份`,
);

process.exit(failures ? 1 : 0);
