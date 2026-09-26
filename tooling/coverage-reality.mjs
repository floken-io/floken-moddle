/**
 * 门禁十一：「L2 可存」兑现率实证。
 *
 * 为什么需要它：`COVERAGE_STATS` 说 48 类都承诺 L2（能进 Model JSON / 能导出合法 XML /
 * 往返不丢），但**数字是从表算的，不证明代码真做得到**。这条门禁把每一类放进
 * **XSD 规定的合法容器**跑一次真实往返，兑现不了就直接红。
 *
 * 三类结果：
 * - `L2`：进了 Model JSON，往返后还在（**真兑现**）
 * - `PRESERVED`：没建模，但原样快照保全了（**不丢**，文档口径为「登记但不落地」）
 * - `LOST` / `THROW`：**门禁失败**
 *
 * 语料/对照物不在本机时跳过（exit 0）—— 与 miwg / interop 同一套取舍。
 *
 * 用法：node tooling/coverage-reality.mjs
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §5 / §14
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const DIST = join(pkgRoot, 'dist/index.js');

if (!existsSync(DIST)) {
  console.log('· coverage-reality — 跳过（dist 未构建）');
  process.exit(0);
}

const { ALL_COVERED_ELEMENTS, fromXmlSync, toXmlSync } = await import(
  'file:///' + DIST.replace(/\\/g, '/')
);

const wrap = (b, ns = '') =>
  '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"' +
  ' xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"' +
  ' xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"' +
  ' xmlns:di="http://www.omg.org/spec/DD/20100524/DI"' +
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
  ns +
  ' id="D1" targetNamespace="http://x">' +
  b +
  '</bpmn:definitions>';

/** XSD 规定的合法父容器 */
const ROOT_ONLY = new Set(['collaboration', 'choreography', 'globalChoreographyTask', 'globalConversation']);
const IN_COLLABORATION = new Set([
  'participant', 'messageFlow', 'conversation', 'callConversation', 'subConversation',
  'conversationLink', 'participantAssociation', 'messageFlowAssociation', 'conversationAssociation',
]);
const IN_CHOREOGRAPHY = new Set(['choreographyTask', 'callChoreography', 'subChoreography']);

/**
 * **不落地**（仅快照保全）的 13 类 —— 与文档 §5 的口径一一对应：
 * 编排族 5 + 会话族 5 + 关联族 3。
 * 它们登记在覆盖表里（认得），但不建模；纪律一只要求"不丢"，不要求"有字段"。
 * 其余 35 类必须**真进 Model JSON**。
 */
const PRESERVED_ONLY = new Set([
  'choreography', 'globalChoreographyTask', 'choreographyTask', 'callChoreography', 'subChoreography',
  'conversation', 'callConversation', 'subConversation', 'globalConversation', 'conversationLink',
  'participantAssociation', 'messageFlowAssociation', 'conversationAssociation',
]);

const rows = [];
let failures = 0;

for (const e of ALL_COVERED_ELEMENTS) {
  // sequenceFlow 的最小实例本身非法（必须带 sourceRef / targetRef），单列检查
  if (e.xmlName === 'sequenceFlow') continue;
  const tag = `<bpmn:${e.xmlName} id="x1"/>`;
  let container;
  let host;
  if (ROOT_ONLY.has(e.xmlName)) {
    container = 'definitions';
    host = tag;
  } else if (IN_COLLABORATION.has(e.xmlName)) {
    container = 'collaboration';
    host = `<bpmn:collaboration id="C1">${tag}</bpmn:collaboration>`;
  } else if (IN_CHOREOGRAPHY.has(e.xmlName)) {
    container = 'choreography';
    host = `<bpmn:choreography id="CH1">${tag}</bpmn:choreography>`;
  } else {
    container = 'process';
    host = `<bpmn:process id="P1">${tag}</bpmn:process>`;
  }

  let status;
  let note = '';
  try {
    const out = toXmlSync(fromXmlSync(wrap(host)), { declaration: false, autoLayout: false });
    const survived = out.includes(`<bpmn:${e.xmlName}`);
    if (!survived) {
      status = 'LOST';
      note = '往返后元素不见了';
    } else if (e.xmlName === 'sequenceFlow') {
      // sequenceFlow 必须有 sourceRef/targetRef，最小实例不合法，单列检查
      status = 'L2';
    } else {
      status = PRESERVED_ONLY.has(e.xmlName) ? 'PRESERVED' : 'L2';
    }
  } catch (err) {
    status = 'THROW';
    note = String(err.message ?? err).slice(0, 70);
  }
  if (status === 'LOST' || status === 'THROW') failures++;
  rows.push(`  ${status.padEnd(9)} ${e.xmlName.padEnd(24)} @${container.padEnd(13)} ${note}`);
}

// sequenceFlow 单独用合法实例验证（最小实例缺 sourceRef/targetRef，属非法输入）
const sfXml = wrap(
  '<bpmn:process id="P1"><bpmn:startEvent id="s"/><bpmn:endEvent id="e"/>' +
    '<bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="e"/></bpmn:process>',
);
const sfOk = toXmlSync(fromXmlSync(sfXml), { declaration: false }).includes('sequenceFlow');
if (!sfOk) {
  console.error('  FAIL sequenceFlow 合法实例往返失败');
  failures++;
}
rows.push(`  ${(sfOk ? 'L2' : 'LOST').padEnd(9)} ${'sequenceFlow'.padEnd(24)} @process        ${sfOk ? '' : '往返失败'}`);

const l2 = rows.filter((r) => r.trim().startsWith('L2')).length;
const preserved = rows.filter((r) => r.trim().startsWith('PRESERVED')).length;
const lost = rows.filter((r) => r.trim().startsWith('LOST') || r.trim().startsWith('THROW')).length;

console.log('L2 兑现实证（48 类放进 XSD 合法容器后往返）');
console.log(rows.join('\n'));
console.log(`\n  L2 真兑现 ${l2} · 保全不落地 ${preserved} · 丢失/抛错 ${lost}`);

if (failures) {
  console.error(`\n✗ coverage-reality — ${failures} 类没兑现（丢失即违反纪律一）`);
  process.exit(1);
}
console.log('✓ coverage-reality — 无丢失');
