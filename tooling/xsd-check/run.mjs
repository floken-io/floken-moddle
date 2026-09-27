/*
 * 官方 OMG BPMN 2.0 XSD 校验（verify 第十五道门禁）
 *
 * 与前面所有门禁的区别：前面验的是「别的解析器认不认」，这一道验的是
 * **规范本身认不认** —— 直接把文件喂给 OMG 发布的 BPMN20.xsd（JAXP，JDK 自带）。
 *
 * 依赖：
 *   - JDK（java 在 PATH 上即可；JAXP 是 JDK 自带，零第三方）
 *   - 官方 XSD：`.workbuddy/xsd/`（BPMN20 / Semantic / DI / BPMNDI / DC）
 *     来源：Camunda `camunda-bpmn-model` jar 内打包的 OMG 官方发布版。
 *   - MIWG 语料：`.workbuddy/miwg/`（缺失则跳过语料部分，不 fail）
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
const XSD_DIR = join(WS, '.workbuddy', 'xsd');
const MIWG_DIR = join(WS, '.workbuddy', 'miwg');
const OUT = join(WS, '.workbuddy', 'xsd-out');

const { toXmlSync, fromXmlSync } = await import(
  pathToFileURL(join(PKG, 'dist', 'index.js')).href
);

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

// ─────────────────────────────────────────────────────────────────
// 1. 是否有 JDK
// ─────────────────────────────────────────────────────────────────
let javaOk = true;
try {
  javaOk = javaAvailable();
} catch {
  javaOk = false;
}
if (!javaOk || !existsSync(join(XSD_DIR, 'BPMN20.xsd'))) {
  console.log('· check:xsd — 跳过（需要 JDK 与官方 XSD；补齐后自动生效）');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────
// 2. 生成我们自己的各类导出样本
// ─────────────────────────────────────────────────────────────────
// 只建目录、按名覆盖，不做 rmSync 清空：
//   ① 输出文件名稳定（样本名 + miwg-<原名>），覆盖即等价，清空没有收益；
//   ② 目录里是几百份中间产物，整目录递归删除会触发沙箱的批量删除保护，把门禁搞崩。
mkdirSync(OUT, { recursive: true });

const base = (extra = {}) => ({
  schemaVersion: '1.0.0',
  id: 'D1',
  name: 'xsd-sample',
  ...extra,
});

const samples = {
  'ours-simple': base({
    processes: [
      {
        id: 'P1',
        executable: true,
        nodes: [
          { id: 's', type: 'startEvent', name: '开始' },
          { id: 'g', type: 'exclusiveGateway', name: '分流', defaultFlow: 'f2' },
          {
            id: 't1',
            type: 'userTask',
            name: '审批',
            extension: {
              'floken:approval': { mode: 'all', approverPolicy: 'user', approvers: ['u1'] },
            },
          },
          { id: 'e', type: 'endEvent', name: '结束' },
        ],
        flows: [
          { id: 'f1', from: 's', to: 'g' },
          { id: 'f2', from: 'g', to: 't1' },
          { id: 'f3', from: 't1', to: 'e' },
        ],
      },
    ],
  }),

  'ours-lanes': base({
    collaborations: [
      {
        id: 'C1',
        participants: [{ id: 'PA1', name: '采购部', processRef: 'P1' }],
        messageFlows: [{ id: 'mf1', from: 'PA1', to: 'PA1' }],
      },
    ],
    processes: [
      {
        id: 'P1',
        laneSets: [
          {
            id: 'LS1',
            lanes: [
              { id: 'L1', name: '发起', nodeIds: ['s'] },
              { id: 'L2', name: '审批', nodeIds: ['t1'] },
            ],
          },
        ],
        nodes: [
          { id: 's', type: 'startEvent', name: '开始' },
          { id: 't1', type: 'userTask', name: '审批' },
          { id: 'e', type: 'endEvent', name: '结束' },
        ],
        flows: [
          { id: 'f1', from: 's', to: 't1' },
          { id: 'f2', from: 't1', to: 'e' },
        ],
      },
    ],
  }),

  'ours-camunda': base({
    processes: [
      {
        id: 'P1',
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
            id: 'st',
            type: 'serviceTask',
            name: '调用',
            implementation: '##WebService',
            operationRef: 'op1',
          },
          { id: 'e', type: 'endEvent' },
        ],
        flows: [
          { id: 'f1', from: 's', to: 't1' },
          { id: 'f2', from: 't1', to: 'st' },
          { id: 'f3', from: 'st', to: 'e' },
        ],
      },
    ],
  }),

  'ours-rich': base({
    extraElements: [
      '<bpmn:message id="Msg_1" name="订单消息" />',
      '<bpmn:itemDefinition id="Item_1" />',
    ],
    processes: [
      {
        id: 'P1',
        nodes: [
          { id: 's', type: 'startEvent', name: '开始' },
          {
            id: 'sub',
            type: 'subProcess',
            name: '子流程',
            triggeredByEvent: false,
            nodes: [
              { id: 'si', type: 'startEvent' },
              { id: 'st1', type: 'task' },
              { id: 'se', type: 'endEvent' },
            ],
            flows: [
              { id: 'sf1', from: 'si', to: 'st1' },
              { id: 'sf2', from: 'st1', to: 'se' },
            ],
          },
          {
            id: 'be',
            type: 'boundaryEvent',
            name: '超时',
            attachedTo: 'sub',
            cancelActivity: false,
            eventDefinition: { type: 'timer', timeDuration: 'PT1H' },
          },
          {
            id: 'ca',
            type: 'callActivity',
            name: '调用子流程',
            calledElement: 'OTHER_PROC',
          },
          {
            id: 'sc',
            type: 'scriptTask',
            name: '脚本',
            scriptFormat: 'javascript',
            script: 'execution.setVariable("x", 1);',
          },
          {
            id: 'me',
            type: 'intermediateCatchEvent',
            name: '等消息',
            messageRef: 'Msg_1',
            eventDefinition: { type: 'message' },
          },
          { id: 'e', type: 'endEvent', name: '结束' },
          { id: 'ta', type: 'textAnnotation', text: '这是一条注释' },
          {
            id: 'as',
            type: 'association',
            sourceRef: 'ta',
            targetRef: 't1',
            associationDirection: 'None',
          },
        ],
        flows: [
          { id: 'f1', from: 's', to: 'sub' },
          { id: 'f2', from: 'sub', to: 'ca' },
          { id: 'f3', from: 'ca', to: 'sc' },
          { id: 'f4', from: 'sc', to: 'me' },
          { id: 'f5', from: 'me', to: 'e' },
          { id: 'f6', from: 'be', to: 'e' },
        ],
      },
    ],
  }),
};

const written = [];
for (const [name, model] of Object.entries(samples)) {
  const p = join(OUT, `${name}.bpmn`);
  writeFileSync(p, toXmlSync(model));
  written.push({ p, label: `我们导出 · ${name}` });

  // 净化导出（includeExtensions:false）也必须是合法 BPMN —— §6.4 的承诺
  const clean = join(OUT, `${name}.clean.bpmn`);
  writeFileSync(clean, toXmlSync(model, { includeExtensions: false }));
  written.push({ p: clean, label: `我们导出 · ${name}（净化）` });
}

// ─────────────────────────────────────────────────────────────────
// 3. MIWG 语料：原始 + 经我们转一圈
// ─────────────────────────────────────────────────────────────────
const corpus = [];
if (existsSync(MIWG_DIR)) {
  const files = readdirSync(MIWG_DIR)
    .filter((f) => f.endsWith('.bpmn'))
    .sort();
  for (const f of files) {
    const src = join(MIWG_DIR, f);
    corpus.push({ p: src, label: `语料原文件 · ${f}` });
    try {
      const back = toXmlSync(fromXmlSync(readFileSync(src)));
      const p = join(OUT, `miwg-${f}`);
      writeFileSync(p, back);
      corpus.push({ p, label: `语料转一圈 · ${f}` });
    } catch (e) {
      check(false, `语料转一圈 · ${f}`, String(e.message ?? e));
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// 4. 交给官方 XSD
// ─────────────────────────────────────────────────────────────────
const all = [...written, ...corpus];
const runJavaBatch = (paths) => {
  const { stdout, ok, error, stderr } = runJava({
    sandboxRoot: WS,
    label: 'xsd-check',
    classpath: [],
    source: join(HERE, 'XsdCheck.java'),
    args: [XSD_DIR, ...paths],
  });
  if (!ok && !stdout.trim()) console.log(`        Java 调用失败：${error} ${stderr.slice(0, 200)}`);
  const perFile = new Map();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [kind, ...rest] = line.split('\t');
    if (kind === 'FILE') perFile.set(rest[0], { count: Number(rest[1]), errs: [] });
    else if (kind === 'ERR') {
      const e = perFile.get(rest[0]);
      if (e) e.errs.push(rest.slice(1).join('\t'));
    }
  }
  return perFile;
};

// 分批跑，避免命令行过长
const perFile = new Map();
for (let i = 0; i < all.length; i += 20) {
  const batch = all.slice(i, i + 20);
  const r = runJavaBatch(batch.map((x) => x.p));
  for (const [k, v] of r) perFile.set(k, v);
}

console.log('\n官方 OMG BPMN 2.0 XSD 校验（JAXP，JDK 自带）');
let bad = 0;
for (const { p, label } of all) {
  const r = perFile.get(p);
  const n = r ? r.count : -1;
  if (n !== 0) {
    bad++;
    check(false, label, `XSD error ${n} 条 → ${(r?.errs ?? []).slice(0, 3).join(' | ')}`);
  }
}
console.log(
  `  ${bad === 0 ? 'PASS' : 'FAIL'}  合计 ${all.length} 份文件，${bad} 份不符合官方 XSD`,
);
if (bad > 0) failures++;

process.exit(failures ? 1 : 0);
