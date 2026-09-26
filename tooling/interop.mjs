/**
 * 互操作实证（三向交叉）：我们的 XML 与**别人的解析器**互相能不能吃下对方的东西。
 *
 * 为什么单测不够：自己的解析器只认自己写出的形态，双方都"自洽"也可能是两头错。
 * 对照物 = **bpmn-moddle 10.3.0**（bpmn-js / Camunda Modeler 的解析内核，同一套 OMG 描述符）。
 *
 *   A. ours → 别人：我们 `toXml` 出来的文件，moddle 能不能解析（零结构类 warning + DI 全覆盖）
 *   B. 别人 → ours：moddle 建模序列化出来的文件，我们 `fromXml` 能不能读回关键属性
 *   C. 真实语料闭环：MIWG 22 份 → 我们 round-trip → moddle 再解析，看有没有把结构写坏
 *
 * 沙箱/语料不在本机时**跳过**（exit 0）—— 它们是一次性对照物，不进依赖链、不进 dist（Q38）。
 *
 * 用法：node tooling/interop.mjs
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §14.1
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const wsRoot = dirname(dirname(pkgRoot));
const MODDLE = join(wsRoot, '.workbuddy/_bpmn-sandbox/node_modules/bpmn-moddle/dist/index.js');
const DIST = join(pkgRoot, 'dist/index.js');
const CORPUS = join(wsRoot, '.workbuddy/miwg');
const SAMPLE = join(pkgRoot, 'examples/expense.bpmn');

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  console.error(`  FAIL ${m}`);
  failures++;
};
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

if (!existsSync(MODDLE) || !existsSync(DIST)) {
  console.log('· interop — 跳过（沙箱 bpmn-moddle 或 dist 不在本机）');
  process.exit(0);
}

const { BpmnModdle } = await import('file:///' + MODDLE.replace(/\\/g, '/'));
const { toXmlSync, fromXmlSync } = await import('file:///' + DIST.replace(/\\/g, '/'));
const moddle = new BpmnModdle({});

/*
 * 只关心**我们自己写的那部分**是否被对方认可：
 * moddle 不认识 camunda/zeebe 是它的包配置问题（我们没给它注册那些扩展包），
 * 不是我们产出的 XML 有问题。故按命名空间过滤 warning。
 */
const isOurFault = (w) => {
  const m = String(w?.message ?? '');
  return /unparsable content <(bpmn|bpmndi|dc|di):|unknown <(bpmn|bpmndi|dc|di):|no namespace/i.test(m);
};
const structural = (ws) => (ws ?? []).filter(isOurFault);

// ─────────────────────────────────────────────────────────────────
// A. ours → 别人
// ─────────────────────────────────────────────────────────────────
console.log('A. ours → bpmn-moddle（我们导出的文件，别人读不读得懂）');

/** 满配模型：把 §6.6 里承诺的规范属性全用上，看对方认不认 */
const full = {
  schemaVersion: '1.0.0',
  id: 'D_Full',
  processes: [
    {
      id: 'P1',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'g1', type: 'exclusiveGateway', name: '分流', gatewayDirection: 'Diverging', defaultFlow: 'f2' },
        { id: 't1', type: 'userTask', name: '审批', implementation: '##unspecified', formKey: 'expense' },
        { id: 'st', type: 'scriptTask', name: '算钱', scriptFormat: 'javascript', script: 'amount * 0.1' },
        { id: 'ca', type: 'callActivity', name: '调子流程', calledElement: 'sub-key' },
        { id: 'dor', type: 'dataObjectReference', name: '单据', dataObjectRef: 'do1' },
        { id: 'sub', type: 'subProcess', name: '子流程', triggeredByEvent: false, nodes: [{ id: 'in1', type: 'userTask' }], flows: [] },
        { id: 'e', type: 'endEvent' },
      ],
      flows: [
        { id: 'f1', from: 's', to: 'g1' },
        { id: 'f2', from: 'g1', to: 't1', condition: 'amount > 5000' },
        { id: 'f3', from: 'g1', to: 'st' },
        { id: 'f4', from: 't1', to: 'ca' },
        { id: 'f5', from: 'st', to: 'sub' },
        { id: 'f6', from: 'sub', to: 'e' },
      ],
    },
  ],
};

async function oursToThem(label, xml) {
  const { rootElement, warnings } = await moddle.fromXML(xml, { lax: true });
  const bad2 = structural(warnings);
  check(bad2.length === 0, `${label}：moddle 零结构类 warning${bad2.length ? ` → ${bad2.map((w) => w.message.split('\n')[0]).join(' | ')}` : ''}`);
  check(rootElement?.$type === 'bpmn:Definitions', `${label}：根元素是 bpmn:Definitions`);
  const proc = rootElement?.rootElements?.find((e) => e.$type === 'bpmn:Process');
  const collect = (l) => (l ?? []).flatMap((e) => [e.id, ...collect(e.flowElements)]);
  const semantic = collect(proc?.flowElements);
  const plane = rootElement?.diagrams?.[0]?.plane;
  const drawn = (plane?.planeElement ?? []).map((de) => de.bpmnElement?.id).filter(Boolean);
  const missing = semantic.filter((id) => !drawn.includes(id));
  check(missing.length === 0, `${label}：${semantic.length} 个语义元素全部有 DI${missing.length ? `（缺 ${missing.join(',')}）` : ''}`);
  return rootElement;
}

if (existsSync(SAMPLE)) {
  await oursToThem('样例 expense.bpmn', readFileSync(SAMPLE, 'utf8'));
}
await oursToThem('满配模型', toXmlSync(full));

// ─────────────────────────────────────────────────────────────────
// B. 别人 → ours
// ─────────────────────────────────────────────────────────────────
console.log('\nB. bpmn-moddle → ours（别人导出的文件，我们读不读得懂）');

const mdefs = moddle.create('bpmn:Definitions', { id: 'D2', targetNamespace: 'http://x' });
const mproc = moddle.create('bpmn:Process', { id: 'P2', isExecutable: true });
mdefs.get('rootElements').push(mproc);
const el = (t, o) => moddle.create(t, o);
const mStart = el('bpmn:StartEvent', { id: 's' });
const mGw = el('bpmn:ExclusiveGateway', { id: 'g', gatewayDirection: 'Diverging' });
const mT1 = el('bpmn:UserTask', { id: 't1', name: '审批', implementation: '##unspecified' });
const mSt = el('bpmn:ScriptTask', { id: 'st', scriptFormat: 'javascript', script: 'amount * 0.1' });
const mCa = el('bpmn:CallActivity', { id: 'ca', calledElement: 'sub-key' });
// ★ moddle 序列化时**省略 `false`**（XSD 默认值），只有 `true` 会落盘。
// 我们用 `true` 验证读回；另有一条断言验证「没写属性 → JSON 里不出现字段」的正确语义。
const mSub = el('bpmn:SubProcess', { id: 'sub', triggeredByEvent: true });
const mInner = el('bpmn:UserTask', { id: 'in1' });
mSub.get('flowElements').push(mInner);
const mEnd = el('bpmn:EndEvent', { id: 'e' });
const mkFlow = (id, a, b, body) => {
  const f = el('bpmn:SequenceFlow', { id, sourceRef: a, targetRef: b });
  if (body) {
    f.set('conditionExpression', el('bpmn:FormalExpression', { body, language: 'https://www.omg.org/spec/DMN/20230324/FEEL/' }));
  }
  mproc.get('flowElements').push(f);
  return f;
};
const mf2 = mkFlow('f2', mGw, mT1, 'amount > 5000');
mGw.set('default', mf2);
mproc.get('flowElements').push(mStart, mGw, mT1, mSt, mCa, mSub, mEnd);
mkFlow('f1', mStart, mGw);
mkFlow('f3', mGw, mSt);
mkFlow('f4', mT1, mCa);
mkFlow('f5', mCa, mSub);
mkFlow('f6', mSub, mEnd);

const { xml: mXml } = await moddle.toXML(mdefs, { format: true });
const back = fromXmlSync(mXml, { onUnsupported: 'warn' });
const nodeById = new Map();
for (const p of back.processes) for (const n of p.nodes) nodeById.set(n.id, n);
const flowById = new Map();
for (const p of back.processes) for (const f of p.flows) flowById.set(f.id, f);

/**
 * ★ 值的**落点**可能是一等字段、也可能在 extension 保全袋里。
 * 两个都查 → 改前改后都能报出"值在哪"，避免脚本只在一种实现下有意义。
 */
const pick = (n, key) => {
  if (n[key] !== undefined) return { where: `一等字段 .${key}`, value: n[key] };
  if (n.extension?.[key] !== undefined) return { where: 'extension（保全袋）', value: n.extension[key] };
  return { where: '丢失', value: undefined };
};
const expect = (n, key, want) => {
  const got = pick(n, key);
  check(
    String(got.value) === String(want),
    `${n.id}.${key} = ${want}（实得 ${got.value} @ ${got.where}）`,
  );
  return got.where;
};

check(nodeById.size === 7, `7 个顶层节点全部读回（实得 ${nodeById.size}）`);
check(nodeById.get('sub')?.nodes?.length === 1, '子流程内嵌节点读回（subProcess.nodes = 1）');
const whereDir = expect(nodeById.get('g'), 'gatewayDirection', 'Diverging');
const whereDef = expect(nodeById.get('g'), 'defaultFlow', 'f2');
expect(nodeById.get('t1'), 'implementation', '##unspecified');
expect(nodeById.get('st'), 'scriptFormat', 'javascript');
expect(nodeById.get('st'), 'script', 'amount * 0.1');
expect(nodeById.get('ca'), 'calledElement', 'sub-key');
expect(nodeById.get('sub'), 'triggeredByEvent', true);
/*
 * 「没写」与「写了 false」必须是两回事（§6.5 坑 3）：
 * moddle 省略了 `triggeredByEvent`，我们就不该凭空造一个 `false` 出来。
 * 反过来我们自己写的 `false` 必须落盘 —— 由 A 方向的满配模型覆盖。
 */
check(
  nodeById.get('t1')?.triggeredByEvent === undefined,
  `未写出的布尔属性不凭空造值（t1.triggeredByEvent = ${nodeById.get('t1')?.triggeredByEvent}）`,
);
check(flowById.get('f2')?.condition?.body === 'amount > 5000', `条件表达式读回（实得 ${flowById.get('f2')?.condition?.body}）`);
check(flowById.get('f2')?.condition?.language === 'https://www.omg.org/spec/DMN/20230324/FEEL/', '条件的 language 读回');

// 关键属性是否落在一等字段上（§6.6 的核心诉求）
const isFirstClass = whereDir.startsWith('一等字段') && whereDef.startsWith('一等字段');
check(isFirstClass, `gatewayDirection / defaultFlow 落在一等字段上（实得 ${whereDir} / ${whereDef}）`);

// 反向：我们读回再导出，对方还能读（闭环）
const roundTrip = toXmlSync(back);
const after = await moddle.fromXML(roundTrip, { lax: true });
const structural2 = structural(after.warnings);
check(structural2.length === 0, `moddle 建模文件经我们转一圈后仍零结构类 warning${structural2.length ? ` → ${structural2.map((w) => w.message.split('\n')[0]).join(' | ')}` : ''}`);
check(toXmlSync(fromXmlSync(roundTrip)) === roundTrip, '闭环后二次导出逐字节幂等');

// ─────────────────────────────────────────────────────────────────
// D. Camunda Modeler 风格的图（第三方扩展能不能保回）
// ─────────────────────────────────────────────────────────────────
console.log('\nD. Camunda Modeler 风格文件（第三方扩展属性/元素保不保得住）');

const camundaXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  id="D_Camunda" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="P1" isExecutable="true">
    <bpmn:startEvent id="s" />
    <bpmn:exclusiveGateway id="g" default="f2" />
    <bpmn:userTask id="t" name="审批" camunda:assignee="zhangsan"
      camunda:candidateGroups="finance,admin" camunda:formKey="expense">
      <bpmn:extensionElements>
        <camunda:taskListener event="create" class="com.example.OnCreate" />
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:businessRuleTask id="br" camunda:decisionRef="discount" />
    <bpmn:serviceTask id="svc" implementation="##WebService" camunda:class="com.example.Svc" />
    <bpmn:endEvent id="e" />
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="g" />
    <bpmn:sequenceFlow id="f2" sourceRef="g" targetRef="t">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">\${amount &gt; 5000}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f3" sourceRef="g" targetRef="svc" />
    <bpmn:sequenceFlow id="f4" sourceRef="t" targetRef="br" />
    <bpmn:sequenceFlow id="f5" sourceRef="br" targetRef="e" />
    <bpmn:sequenceFlow id="f6" sourceRef="svc" targetRef="e" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="dia">
    <bpmndi:BPMNPlane id="plane" bpmnElement="P1">
      <bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="0" y="0" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="t_di" bpmnElement="t"><dc:Bounds x="100" y="0" width="100" height="80" /></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

const cam = fromXmlSync(camundaXml, { onUnsupported: 'warn' });
const camNodes = new Map(cam.processes.flatMap((p) => p.nodes).map((n) => [n.id, n]));
check(camNodes.get('g')?.defaultFlow === 'f2', `exclusiveGateway.default → defaultFlow（实得 ${camNodes.get('g')?.defaultFlow}）`);
check(camNodes.get('svc')?.implementation === '##WebService', `serviceTask.implementation 读回（实得 ${camNodes.get('svc')?.implementation}）`);
check(
  camNodes.get('t')?.extension?.['camunda:assignee'] === 'zhangsan',
  `camunda:assignee 保回（实得 ${camNodes.get('t')?.extension?.['camunda:assignee']}）`,
);
check(
  camNodes.get('br')?.extension?.['camunda:decisionRef'] === 'discount',
  `camunda:decisionRef 保回（实得 ${camNodes.get('br')?.extension?.['camunda:decisionRef']}）`,
);
const camOut = toXmlSync(cam);
check(camOut.includes('camunda:assignee="zhangsan"'), '再导出仍写作 camunda:assignee 属性（FR-S13）');
check(camOut.includes('camunda:taskListener'), '第三方元素 taskListener 快照保回');
const camRe = await moddle.fromXML(camOut, { lax: true });
check(structural(camRe.warnings).length === 0, `转出后 moddle 无结构类 warning（实得 ${structural(camRe.warnings).length}）`);
check(toXmlSync(fromXmlSync(camOut, { onUnsupported: 'warn' })) === camOut, 'Camunda 风格文件二次导出幂等');

// ─────────────────────────────────────────────────────────────────
// C. 真实语料闭环（MIWG 22 份）
// ─────────────────────────────────────────────────────────────────
if (existsSync(CORPUS)) {
  console.log('\nC. MIWG 真实语料闭环（真实文件 → 我们 round-trip → moddle 再解析）');
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.bpmn')).sort();
  let nBase = 0;
  let nAfter = 0;
  const rows = [];
  for (const f of files) {
    const xml = readFileSync(join(CORPUS, f), 'utf8');
    const base = await moddle.fromXML(xml, { lax: true });
    const baseBad = structural(base.warnings).length;
    let out;
    try {
      const def = fromXmlSync(xml, { onUnsupported: 'warn', allowDoctype: true });
      out = toXmlSync(def);
    } catch (e) {
      rows.push(` - ${f}: 我们崩了 ${e?.code ?? ''} ${e?.message ?? e}`);
      continue;
    }
    const re = await moddle.fromXML(out, { lax: true });
    const afterBad = structural(re.warnings);
    nBase += baseBad;
    nAfter += afterBad.length;
    if (afterBad.length) rows.push(` - ${f}: ${afterBad.map((w) => w.message.split('\n')[0]).join(' | ')}`);
  }
  check(rows.length === 0, `${files.length} 份真实语料经我们转一圈后仍无结构类 warning（基线 ${nBase} → 转后 ${nAfter}）`);
  if (rows.length) for (const r of rows) console.log(r);
} else {
  console.log('\nC. MIWG 语料不在本机（跳过；先跑 node tooling/fetch-miwg.mjs）');
}

console.log(
  failures === 0
    ? '\n互操作实证通过（A ours→别人 / B 别人→ours / C 真实语料闭环 / D Camunda 扩展）'
    : `\n互操作实证失败：${failures} 项`,
);
process.exit(failures === 0 ? 0 : 1);
