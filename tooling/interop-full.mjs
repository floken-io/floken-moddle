/**
 * 互操作实证（**多库 × 双向**）—— 我们导出的文件，Node 生态的主流 BPMN 库吃不吃得下；
 * 它们导出的文件，我们读不读得回来。
 *
 * 与 `interop.mjs`（第十道：单库 bpmn-moddle 能否解析）分工：
 * 本脚本是**第十四道**，回答的是更强的三个问题：
 *   ① 对方是**把它们当真属性**认，还是只当字符串宽容放行？（用 camunda-bpmn-moddle 注册扩展后解析）
 *   ② 我们的文件过不过得了 **bpmnlint**（官方规则检查器）？（口径 = 与对方自己建模的等价文件比，不比它差）
 *   ③ 我们的文件能不能被**真执行引擎跑完**？（bpmn-engine，含 exclusiveGateway 默认分支语义）
 *
 * 方向：
 *   A. ours → 别人（导出侧）：moddle / moddle+camunda / bpmnlint / bpmn-engine
 *   B. 别人 → ours（导入侧）：moddle 建模 / moddle+camunda 建模 / MIWG 22 份真实语料
 *   C. 双向闭环：ours → XML → 别人 → XML → ours → XML 逐字节幂等
 *
 * 沙箱不在本机时**跳过**（exit 0）—— 对照物是一次性的，不进依赖链、不进 dist（Q38）。
 *
 * 用法：node tooling/interop-full.mjs
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §14.9
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const wsRoot = dirname(dirname(pkgRoot));
const SB = join(wsRoot, '.workbuddy/_bpmn-sandbox/node_modules');
const DIST = join(pkgRoot, 'dist/index.js');
const CORPUS = join(wsRoot, '.workbuddy/miwg');
const SAMPLE = join(pkgRoot, 'examples/expense.bpmn');

const MODDLE_JS = join(SB, 'bpmn-moddle/dist/index.js');
const CAMUNDA_JSON = join(SB, 'camunda-bpmn-moddle/resources/camunda.json');
const ZEEBE_JSON = join(SB, 'zeebe-bpmn-moddle/resources/zeebe.json');
const LINT_JS = join(SB, 'bpmnlint/lib/index.js');
const LINT_RESOLVER = join(SB, 'bpmnlint/lib/resolver/node-resolver.js');
const ENGINE_JS = join(SB, 'bpmn-engine/src/index.js');

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  console.error(`  FAIL ${m}`);
  failures++;
};
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));
const imp = (p) => import('file:///' + p.replace(/\\/g, '/'));

if (![MODDLE_JS, CAMUNDA_JSON, LINT_JS, ENGINE_JS, DIST].every(existsSync)) {
  console.log('· interop-full — 跳过（沙箱对照库或 dist 不在本机）');
  process.exit(0);
}

const { BpmnModdle } = await imp(MODDLE_JS);
const { toXmlSync, fromXmlSync } = await imp(DIST);
const { Linter } = await imp(LINT_JS);
const NodeResolver = (await imp(LINT_RESOLVER)).default;
const { Engine } = await imp(ENGINE_JS);
const camundaJson = JSON.parse(readFileSync(CAMUNDA_JSON, 'utf8'));

const moddle = new BpmnModdle({});
const camModdle = new BpmnModdle({ camunda: camundaJson });
const linter = new Linter({ config: { extends: ['bpmnlint:recommended'] }, resolver: new NodeResolver() });

/** 只关心**我们自己写的那部分**（bpmn/bpmndi/dc/di 命名空间）是否被对方认可 */
const isOurFault = (w) =>
  /unparsable content <(bpmn|bpmndi|dc|di):|unknown <(bpmn|bpmndi|dc|di):|no namespace/i.test(
    String(w?.message ?? ''),
  );
const structural = (ws) => (ws ?? []).filter(isOurFault);

const lines = [];
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

// ═════════════════════════════════════════════════════════════════
// A. ours → 别人（导出侧）
// ═════════════════════════════════════════════════════════════════
console.log('A. ours → 别人（我们导出的文件，Node 生态的库吃不吃得下）');

/** 满配模型：§6.6 承诺的规范属性全用上 */
const full = {
  schemaVersion: '1.0.0',
  id: 'D_Full',
  processes: [
    {
      id: 'P1',
      nodes: [
        { id: 's', type: 'startEvent', name: '开始' },
        { id: 'g1', type: 'exclusiveGateway', name: '分流', gatewayDirection: 'Diverging', defaultFlow: 'f2' },
        { id: 't1', type: 'userTask', name: '审批', implementation: '##unspecified' },
        { id: 'st', type: 'scriptTask', name: '算钱', scriptFormat: 'javascript', script: 'amount * 0.1' },
        { id: 'ca', type: 'callActivity', name: '调子流程', calledElement: 'sub-key' },
        { id: 'e', type: 'endEvent', name: '结束' },
      ],
      flows: [
        { id: 'f1', from: 's', to: 'g1' },
        { id: 'f2', from: 'g1', to: 't1', condition: 'amount > 5000' },
        { id: 'f3', from: 'g1', to: 'st' },
        { id: 'f4', from: 't1', to: 'ca' },
        { id: 'f5', from: 'st', to: 'e' },
        { id: 'f6', from: 'ca', to: 'e' },
      ],
    },
  ],
};
const fullXml = toXmlSync(full);

// ── A1. bpmn-moddle（裸）──
{
  const { rootElement, warnings } = await moddle.fromXML(fullXml, { lax: true });
  const s = structural(warnings);
  check(s.length === 0, `A1 moddle 零结构类 warning${s.length ? ` → ${s.map((w) => w.message.split('\n')[0]).join(' | ')}` : ''}`);
  check(rootElement?.$type === 'bpmn:Definitions', 'A1 根元素是 bpmn:Definitions');
  const proc = rootElement?.rootElements?.find((e) => e.$type === 'bpmn:Process');
  const collect = (l) => (l ?? []).flatMap((e) => [e.id, ...collect(e.flowElements)]);
  const semantic = collect(proc?.flowElements);
  const drawn = (rootElement?.diagrams?.[0]?.plane?.planeElement ?? [])
    .map((de) => de.bpmnElement?.id)
    .filter(Boolean);
  const missing = semantic.filter((id) => !drawn.includes(id));
  check(missing.length === 0, `A1 ${semantic.length} 个语义元素全部有 DI${missing.length ? `（缺 ${missing.join(',')}）` : ''}`);
  const gw = proc?.flowElements?.find((e) => e.id === 'g1');
  check(gw?.get('default')?.id === 'f2', `A1 exclusiveGateway.default 被对方识别为默认分支（实得 ${gw?.get('default')?.id}）`);
  const st = proc?.flowElements?.find((e) => e.id === 'st');
  check(st?.get('script') === 'amount * 0.1', `A1 scriptTask.script 被对方解析（实得 ${st?.get('script')}）`);
}

if (existsSync(SAMPLE)) {
  const { rootElement, warnings } = await moddle.fromXML(readFileSync(SAMPLE, 'utf8'), { lax: true });
  check(structural(warnings).length === 0, 'A1 样例 expense.bpmn 零结构类 warning');
  check(rootElement?.$type === 'bpmn:Definitions', 'A1 样例根元素正确');
}

// ── A1b. zeebe-bpmn-moddle（Camunda 8 / Zeebe 生态的扩展配置）──
if (existsSync(ZEEBE_JSON)) {
  const zeebeJson = JSON.parse(readFileSync(ZEEBE_JSON, 'utf8'));
  const z = new BpmnModdle({ zeebe: zeebeJson });
  const r = await z.fromXML(fullXml, { lax: true });
  const s = structural(r.warnings);
  check(s.length === 0, `A1b zeebe-moddle 零结构类 warning${s.length ? ` → ${s.map((w) => w.message.split('\n')[0]).join(' | ')}` : ''}`);
  check(r.rootElement?.$type === 'bpmn:Definitions', 'A1b zeebe 侧根元素正确');
} else {
  console.log('  ·   A1b zeebe-bpmn-moddle 不在沙箱（跳过）');
}

// ── A2. bpmn-moddle + camunda 扩展（Camunda Modeler 的真实配置）──
{
  lines.length = 0;
  lines.push(XML_DECL);
  lines.push('<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"');
  lines.push('  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"');
  lines.push('  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"');
  lines.push('  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"');
  lines.push('  id="D_Cam" targetNamespace="http://bpmn.io/schema/bpmn">');
  lines.push('  <bpmn:process id="P1" isExecutable="true">');
  lines.push('    <bpmn:startEvent id="s" />');
  lines.push('    <bpmn:exclusiveGateway id="g" default="f2" />');
  lines.push('    <bpmn:userTask id="t" name="审批" camunda:assignee="zhangsan" camunda:candidateGroups="finance,admin" />');
  lines.push('    <bpmn:businessRuleTask id="br" camunda:decisionRef="discount" />');
  lines.push('    <bpmn:endEvent id="e" />');
  lines.push('    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="g" />');
  lines.push('    <bpmn:sequenceFlow id="f2" sourceRef="g" targetRef="t" />');
  lines.push('    <bpmn:sequenceFlow id="f3" sourceRef="g" targetRef="br" />');
  lines.push('    <bpmn:sequenceFlow id="f4" sourceRef="t" targetRef="e" />');
  lines.push('    <bpmn:sequenceFlow id="f5" sourceRef="br" targetRef="e" />');
  lines.push('  </bpmn:process>');
  lines.push('</bpmn:definitions>');
  const camXml = lines.join('\n');

  const ours = fromXmlSync(camXml, { onUnsupported: 'warn' });
  const camOut = toXmlSync(ours);
  check(camOut.includes('camunda:assignee="zhangsan"'), 'A2 camunda:assignee 原样落盘（属性形式）');

  const { rootElement, warnings } = await camModdle.fromXML(camOut, { lax: true });
  const s = structural(warnings);
  check(s.length === 0, `A2 camunda-moddle 零结构类 warning${s.length ? ` → ${s.map((w) => w.message.split('\n')[0]).join(' | ')}` : ''}`);
  const proc = rootElement?.rootElements?.find((e) => e.$type === 'bpmn:Process');
  const t = proc?.flowElements?.find((e) => e.id === 't');
  const br = proc?.flowElements?.find((e) => e.id === 'br');
  check(
    t?.get('camunda:assignee') === 'zhangsan',
    `A2 对方把 camunda:assignee **当真属性**解析（实得 ${t?.get('camunda:assignee')}）`,
  );
  check(
    t?.get('camunda:candidateGroups') === 'finance,admin',
    `A2 对方把 camunda:candidateGroups 当真属性解析（实得 ${t?.get('camunda:candidateGroups')}）`,
  );
  check(
    br?.get('camunda:decisionRef') === 'discount',
    `A2 对方把 camunda:decisionRef 当真属性解析（实得 ${br?.get('camunda:decisionRef')}）`,
  );
  /** 属性必须挂在**模型对象**上，而不是掉进 extensionElements 的未知元素堆里 */
  const dumped = (t?.get('extensionElements')?.values ?? []).map((v) => v.$type);
  check(
    !dumped.some((x) => String(x).includes('assignee')),
    `A2 assignee 没被降级进 extensionElements（实得 ${JSON.stringify(dumped)}）`,
  );
}

// ── A3. bpmnlint（官方规则检查器）—— 口径：**不比对方自己建模的等价文件差** ──
{
  const lintOf = async (xml) => {
    /**
     * ★ moddle 和 linter **都**要用独立实例：
     * 复用 moddle 会让跨文件的 id 引用串味，复用 linter 会让规则状态串味 ——
     * 两者都会凭空造出 `no-duplicate-sequence-flows` 之类的假告警。
     */
    const m = new BpmnModdle({});
    const { rootElement } = await m.fromXML(xml, { lax: true });
    const rep = await new Linter({ config: { extends: ['bpmnlint:recommended'] }, resolver: new NodeResolver() }).lint(
      rootElement,
    );
    const set = new Set();
    /** ★ 规则名是 report 的**外层 key**，条目里只有 category/message */
    for (const [rule, rs] of Object.entries(rep)) for (const r of rs) set.add(`${r.category}:${rule}`);
    return set;
  };

  /**
   * 对方自己建模一个**结构对等**的流程作为 lint 基线：
   * 同款 diverging 网关 + 同款条件分支 + 同款默认分支。
   * ★ 不对等的对照物没有意义 —— 我方带条件流、基线不带，`label-required` 就会假报我方更差。
   */
  const d = moddle.create('bpmn:Definitions', { id: 'D1', targetNamespace: 'http://x' });
  const p = moddle.create('bpmn:Process', { id: 'P1', isExecutable: true });
  d.get('rootElements').push(p);
  const mk = (t, o) => moddle.create(t, o);
  const bs = mk('bpmn:StartEvent', { id: 's', name: '开始' });
  const bg = mk('bpmn:ExclusiveGateway', { id: 'g1', name: '分流', gatewayDirection: 'Diverging' });
  const bt1 = mk('bpmn:UserTask', { id: 't1', name: '审批' });
  const bt2 = mk('bpmn:ScriptTask', { id: 'st', name: '算钱', scriptFormat: 'javascript', script: 'amount * 0.1' });
  const bca = mk('bpmn:CallActivity', { id: 'ca', name: '调子流程', calledElement: 'sub-key' });
  const be = mk('bpmn:EndEvent', { id: 'e', name: '结束' });
  const bf2 = mk('bpmn:SequenceFlow', { id: 'f2', sourceRef: bg, targetRef: bt1 });
  bf2.set('conditionExpression', mk('bpmn:FormalExpression', { body: 'amount > 5000' }));
  bg.set('default', bf2);
  p.get('flowElements').push(
    bs, bg, bt1, bt2, bca, be,
    mk('bpmn:SequenceFlow', { id: 'f1', sourceRef: bs, targetRef: bg }),
    bf2,
    mk('bpmn:SequenceFlow', { id: 'f3', sourceRef: bg, targetRef: bt2 }),
    mk('bpmn:SequenceFlow', { id: 'f4', sourceRef: bt1, targetRef: bca }),
    mk('bpmn:SequenceFlow', { id: 'f5', sourceRef: bt2, targetRef: be }),
    mk('bpmn:SequenceFlow', { id: 'f6', sourceRef: bca, targetRef: be }),
  );
  const { xml: theirXml } = await moddle.toXML(d, { format: true });

  const theirs = await lintOf(theirXml);
  const ours = await lintOf(fullXml);
  const extra = [...ours].filter((x) => !theirs.has(x));
  check(
    extra.length === 0,
    `A3 bpmnlint 不比对方自己建模的等价文件差（基线 ${theirs.size} 类 → 我们 ${ours.size} 类${extra.length ? `，新增 ${extra.join(' / ')}` : ''}）`,
  );
  console.log(`       · 基线告警类型：${[...theirs].join(' / ') || '（无）'}`);
  /**
   * ★ 基线里那几类是 bpmnlint 在**纯 moddle 解析**下的固有噪声：
   * moddle 不会回填 `incoming`/`outgoing`，规则就判"未连接"。
   * 反过来**补写** incoming/outgoing 会触发 `no-duplicate-sequence-flows`（冗余替代组写两遍 = 重复）。
   * 故我们不写，也不吸收 —— 这个取舍由本断言钉死。
   */
  const dup = [...ours].some((x) => x.includes('duplicate-sequence-flows'));
  check(!dup, 'A3 未触发 no-duplicate-sequence-flows（证明「不写冗余 incoming/outgoing」是对的）');
}

// ── A4. bpmn-engine（真执行引擎）—— 含默认分支语义 ──
{
  const runnable = {
    schemaVersion: '1.0.0',
    id: 'D_Run',
    processes: [
      {
        id: 'P1',
        executable: true,
        nodes: [
          { id: 's', type: 'startEvent', name: '开始' },
          { id: 'g', type: 'exclusiveGateway', name: '分流', defaultFlow: 'fElse' },
          { id: 'tBig', type: 'task', name: '大额' },
          { id: 'tSmall', type: 'task', name: '小额' },
          { id: 'e', type: 'endEvent', name: '结束' },
        ],
        flows: [
          { id: 'f1', from: 's', to: 'g' },
          { id: 'fBig', from: 'g', to: 'tBig', condition: 'amount > 5000' },
          { id: 'fElse', from: 'g', to: 'tSmall' },
          { id: 'f4', from: 'tBig', to: 'e' },
          { id: 'f5', from: 'tSmall', to: 'e' },
        ],
      },
    ],
  };
  const runXml = toXmlSync(runnable);

  /**
   * ★ 手写一份**结构对等**的标准 BPMN 作为行为基线。
   * 为什么要对照而不是直接断言"该走默认分支"：实测 bpmn-engine 26.0.5 在条件不成立时
   * **并没有**走 `default` 分支（手写标准 XML 同样如此，与我们的文件无关）——
   * 用它验证默认分支语义会得到假阴性。故行为层只断言"与手写标准文件**一致**"；
   * 默认分支语义由 A1（对方把 `default` 解析成真引用）兜住。
   */
  const handXml = [
    XML_DECL,
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="D_Run" targetNamespace="http://floken.dev/schema/bpmn/1.0">',
    '  <bpmn:process id="P1" isExecutable="true">',
    '    <bpmn:startEvent id="s" name="开始" />',
    '    <bpmn:exclusiveGateway id="g" name="分流" default="fElse" />',
    '    <bpmn:task id="tBig" name="大额" />',
    '    <bpmn:task id="tSmall" name="小额" />',
    '    <bpmn:endEvent id="e" name="结束" />',
    '    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="g" />',
    '    <bpmn:sequenceFlow id="fBig" sourceRef="g" targetRef="tBig">',
    '      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">amount &gt; 5000</bpmn:conditionExpression>',
    '    </bpmn:sequenceFlow>',
    '    <bpmn:sequenceFlow id="fElse" sourceRef="g" targetRef="tSmall" />',
    '    <bpmn:sequenceFlow id="f4" sourceRef="tBig" targetRef="e" />',
    '    <bpmn:sequenceFlow id="f5" sourceRef="tSmall" targetRef="e" />',
    '  </bpmn:process>',
    '</bpmn:definitions>',
  ].join('\n');

  const run = async (source, variables) => {
    const engine = new Engine({ source });
    const done = engine.waitFor('end');
    const taken = [];
    /** bpmn-engine 调用 `listener.emit(routingKey, elementApi, execution)` —— EventEmitter 直接可用 */
    const listener = new EventEmitter();
    listener.on('flow.take', (api) => taken.push(api?.id ?? api?.content?.id));
    await engine.execute({ variables, listener });
    const end = await Promise.race([done, new Promise((r) => setTimeout(() => r('TIMEOUT'), 5000))]);
    return { end, taken };
  };

  for (const vars of [{ amount: 8000 }, { amount: 100 }]) {
    const label = `amount=${vars.amount}`;
    const a = await run(runXml, vars);
    check(a.end !== 'TIMEOUT', `A4 bpmn-engine 能**跑完**我们导出的文件（${label}）`);
    const hand = await run(handXml, vars);
    check(hand.end !== 'TIMEOUT', `A4 手写标准 XML 也能跑完（${label}，对照物有效）`);
    check(
      a.taken.join(',') === hand.taken.join(','),
      `A4 路由行为与手写标准 BPMN **完全一致**（${label}：我们 ${a.taken.join(',') || '∅'} vs 手写 ${hand.taken.join(',') || '∅'}）`,
    );
  }
  const a8 = await run(runXml, { amount: 8000 });
  check(a8.taken.includes('fBig'), `A4 条件成立走 fBig（实得 ${a8.taken.join(',')}）`);
}

// ═════════════════════════════════════════════════════════════════
// B. 别人 → ours（导入侧）
// ═════════════════════════════════════════════════════════════════
console.log('\nB. 别人 → ours（它们导出的文件，我们读不读得回来）');

// ── B1. bpmn-moddle 建模 → 我们读 ──
{
  const d = moddle.create('bpmn:Definitions', { id: 'D2', targetNamespace: 'http://x' });
  const p = moddle.create('bpmn:Process', { id: 'P2', isExecutable: true });
  d.get('rootElements').push(p);
  const mk = (t, o) => moddle.create(t, o);
  const ms = mk('bpmn:StartEvent', { id: 's' });
  const mg = mk('bpmn:ExclusiveGateway', { id: 'g', gatewayDirection: 'Diverging' });
  const mt = mk('bpmn:UserTask', { id: 't1', name: '审批', implementation: '##unspecified' });
  const mst = mk('bpmn:ScriptTask', { id: 'st', scriptFormat: 'javascript', script: 'amount * 0.1' });
  const mca = mk('bpmn:CallActivity', { id: 'ca', calledElement: 'sub-key' });
  // ★ moddle 序列化省略 `false`（XSD 默认值）；用 `true` 验证读回
  const msub = mk('bpmn:SubProcess', { id: 'sub', triggeredByEvent: true });
  msub.get('flowElements').push(mk('bpmn:UserTask', { id: 'in1' }));
  const me = mk('bpmn:EndEvent', { id: 'e' });
  const flow = (id, a, b, cond) => {
    const f = mk('bpmn:SequenceFlow', { id, sourceRef: a, targetRef: b });
    if (cond) {
      f.set('conditionExpression', mk('bpmn:FormalExpression', { body: cond, language: 'https://www.omg.org/spec/DMN/20230324/FEEL/' }));
    }
    p.get('flowElements').push(f);
    return f;
  };
  const mf2 = flow('f2', mg, mt, 'amount > 5000');
  mg.set('default', mf2);
  p.get('flowElements').push(ms, mg, mt, mst, mca, msub, me);
  flow('f1', ms, mg);
  flow('f3', mg, mst);
  flow('f4', mt, mca);
  flow('f5', mca, msub);
  flow('f6', msub, me);
  const { xml: theirXml } = await moddle.toXML(d, { format: true });

  const back = fromXmlSync(theirXml, { onUnsupported: 'warn' });
  const nodes = new Map(back.processes.flatMap((x) => x.nodes).map((n) => [n.id, n]));
  const flows = new Map(back.processes.flatMap((x) => x.flows).map((f) => [f.id, f]));
  check(nodes.size === 7, `B1 7 个顶层节点全读回（实得 ${nodes.size}）`);
  check(nodes.get('sub')?.nodes?.length === 1, 'B1 子流程内嵌节点读回');

  /** ★ 断言落在**一等字段**上 —— §6.6 的核心诉求是 engine 按名字读，不去袋里掏字符串 */
  const firstClass = (n, key, want) => {
    const v = n?.[key];
    check(v !== undefined && String(v) === String(want), `B1 ${n?.id}.${key} = ${want} **在一等字段上**（实得 ${v}）`);
  };
  firstClass(nodes.get('g'), 'gatewayDirection', 'Diverging');
  firstClass(nodes.get('g'), 'defaultFlow', 'f2');
  firstClass(nodes.get('t1'), 'implementation', '##unspecified');
  firstClass(nodes.get('st'), 'scriptFormat', 'javascript');
  firstClass(nodes.get('st'), 'script', 'amount * 0.1');
  firstClass(nodes.get('ca'), 'calledElement', 'sub-key');
  firstClass(nodes.get('sub'), 'triggeredByEvent', true);
  /** 「没写」与「写了 false」必须是两回事（§6.5） */
  check(nodes.get('t1')?.triggeredByEvent === undefined, `B1 未写出的布尔不凭空造值（实得 ${nodes.get('t1')?.triggeredByEvent}）`);
  check(flows.get('f2')?.condition?.body === 'amount > 5000', `B1 条件表达式读回（实得 ${flows.get('f2')?.condition?.body}）`);
  check(
    (typeof flows.get('f2')?.condition === 'object' ? flows.get('f2').condition.language : undefined) ===
      'https://www.omg.org/spec/DMN/20230324/FEEL/',
    'B1 条件的 language 读回',
  );

  // 闭环：我们读回再导出，对方还能读；且逐字节幂等
  const rt = toXmlSync(back);
  const after = await moddle.fromXML(rt, { lax: true });
  check(structural(after.warnings).length === 0, 'B1 闭环后对方仍零结构类 warning');
  check(toXmlSync(fromXmlSync(rt)) === rt, 'B1 闭环后二次导出逐字节幂等');
}

// ── B2. moddle + camunda 扩展建模 → 我们读 → 再导出 → 对方还认 ──
{
  const d = camModdle.create('bpmn:Definitions', { id: 'D3', targetNamespace: 'http://x' });
  const p = camModdle.create('bpmn:Process', { id: 'P3', isExecutable: true });
  d.get('rootElements').push(p);
  const t = camModdle.create('bpmn:UserTask', { id: 't', name: '审批' });
  t.set('camunda:assignee', 'lisi');
  t.set('camunda:candidateGroups', 'finance');
  t.set('camunda:asyncBefore', true);
  const br = camModdle.create('bpmn:BusinessRuleTask', { id: 'br' });
  br.set('camunda:decisionRef', 'discount');
  p.get('flowElements').push(camModdle.create('bpmn:StartEvent', { id: 's' }), t, br, camModdle.create('bpmn:EndEvent', { id: 'e' }));
  p.get('flowElements').push(
    camModdle.create('bpmn:SequenceFlow', { id: 'f1', sourceRef: p.flowElements[0], targetRef: t }),
    camModdle.create('bpmn:SequenceFlow', { id: 'f2', sourceRef: t, targetRef: br }),
    camModdle.create('bpmn:SequenceFlow', { id: 'f3', sourceRef: br, targetRef: p.flowElements[3] }),
  );
  const { xml: theirXml } = await camModdle.toXML(d, { format: true });
  check(theirXml.includes('camunda:assignee'), 'B2 对方建模文件含 camunda:assignee（对照物本身有效）');

  const back = fromXmlSync(theirXml, { onUnsupported: 'warn' });
  const tn = back.processes[0].nodes.find((n) => n.id === 't');
  const brn = back.processes[0].nodes.find((n) => n.id === 'br');
  check(tn?.extension?.['camunda:assignee'] === 'lisi', `B2 camunda:assignee 保回（实得 ${tn?.extension?.['camunda:assignee']}）`);
  check(brn?.extension?.['camunda:decisionRef'] === 'discount', `B2 camunda:decisionRef 保回（实得 ${brn?.extension?.['camunda:decisionRef']}）`);

  const out = toXmlSync(back);
  const re = await camModdle.fromXML(out, { lax: true });
  const s = structural(re.warnings);
  check(s.length === 0, `B2 再导出后 camunda-moddle 零结构类 warning${s.length ? ` → ${s.map((w) => w.message.split('\n')[0]).join(' | ')}` : ''}`);
  const p2 = re.rootElement?.rootElements?.find((x) => x.$type === 'bpmn:Process');
  const t2 = p2?.flowElements?.find((x) => x.id === 't');
  check(t2?.get('camunda:assignee') === 'lisi', `B2 往返后对方仍把 assignee 当真属性（实得 ${t2?.get('camunda:assignee')}）`);
  check(toXmlSync(fromXmlSync(out, { onUnsupported: 'warn' })) === out, 'B2 camunda 文件二次导出幂等');
}

// ── B3. MIWG 22 份真实语料：转一圈后**不得比基线差** ──
if (existsSync(CORPUS)) {
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.bpmn')).sort();
  let worse = 0;
  let baseTotal = 0;
  let afterTotal = 0;
  const rows = [];
  for (const f of files) {
    const xml = readFileSync(join(CORPUS, f), 'utf8');
    const base = await moddle.fromXML(xml, { lax: true });
    const b = structural(base.warnings).length;
    let out;
    try {
      out = toXmlSync(fromXmlSync(xml, { onUnsupported: 'warn', allowDoctype: true }));
    } catch (e) {
      rows.push(` - ${f}: 我们崩了 ${e?.code ?? ''} ${e?.message ?? e}`);
      worse++;
      continue;
    }
    const re = await moddle.fromXML(out, { lax: true });
    const a = structural(re.warnings).length;
    baseTotal += b;
    afterTotal += a;
    if (a > b) {
      worse++;
      rows.push(` - ${f}: 基线 ${b} → 转后 ${a}｜${structural(re.warnings).slice(0, 2).map((w) => w.message.split('\n')[0]).join(' | ')}`);
    }
  }
  check(worse === 0, `B3 ${files.length} 份真实语料转一圈后不比基线差（基线合计 ${baseTotal} → 转后 ${afterTotal}）`);
  if (rows.length) for (const r of rows) console.log(r);
} else {
  console.log('B3 MIWG 语料不在本机（跳过；先跑 node tooling/fetch-miwg.mjs）');
}

// ═════════════════════════════════════════════════════════════════
// C. 双向闭环幂等
// ═════════════════════════════════════════════════════════════════
console.log('\nC. 双向闭环幂等（ours → XML → 对方 → XML → ours → XML）');
{
  const x1 = toXmlSync(full);
  const r1 = await moddle.fromXML(x1, { lax: true });
  const { xml: x2 } = await moddle.toXML(r1.rootElement, { format: true });
  const back2 = fromXmlSync(x2, { onUnsupported: 'warn' });
  const x3 = toXmlSync(back2);
  check(toXmlSync(fromXmlSync(x3)) === x3, 'C 经对方序列化转一圈后，我们再导出即达稳态（幂等）');
  const nodes3 = back2.processes[0].nodes.length;
  check(nodes3 === full.processes[0].nodes.length, `C 节点数守恒（${full.processes[0].nodes.length} → ${nodes3}）`);
  const flows3 = back2.processes[0].flows.length;
  check(flows3 === full.processes[0].flows.length, `C 连线数守恒（${full.processes[0].flows.length} → ${flows3}）`);
}

console.log(
  failures === 0
    ? '\n互操作实证（多库 × 双向）通过：A 导出侧 moddle / camunda-moddle / bpmnlint / bpmn-engine · B 导入侧 moddle / camunda / MIWG · C 闭环幂等'
    : `\n互操作实证（多库 × 双向）失败：${failures} 项`,
);
process.exit(failures === 0 ? 0 : 1);
