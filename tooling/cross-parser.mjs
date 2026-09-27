/*
 * **跨解析器结构等价**门禁（verify 第二十道）
 *
 * 为什么还要这一道：前面十九道验的是「**能不能**读回来」（数量守恒、XSD 合法、画布能画）。
 * 但对**引擎**来说真正致命的是另一种问题 ——
 *   元素个数一个不少，可**连线的两端对错了 / 网关默认分支丢了 / 边界事件没挂对宿主**。
 * 这类错,A-num conserving 的检查一条都抓不到。
 *
 * 所以这里改成抽 **结构指纹**：把每份文件在**每一家眼里**的图抽成一串可比对的行
 * （节点清单 / 连线 / 默认分支 / 边界事件宿主 / 子流程归属 / 泳道成员 / 消息流 / DI 覆盖），
 * 然后断言：
 *
 *   A. **同一家 parser 看不见我们碰过文件** —— 语料原文件与我们转一圈的产物，指纹逐字相同
 *      （这是最干净的承诺：任何一家的视角下我们都只是一个恒等变换）
 *   B. **我们模型的意图 == 五家从我们导出结果里读出来的东西** —— 自家样本做不到 A（没有"原文"），
 *      就反过来比：我们模型里写的图，与五家解析我们 XML 得到的图，节点集与连线集必须一致
 *
 * 口径纪律（本轮实测定的，不许随手改）：
 *   - **类型名只报不判**：Flowable 把 `<task>` 读成 `manualTask`、Camunda 读成 `task`，
 *     这是**语料原文就存在的跨工具分歧**，与我们的转换无关。故跨工具比对只比 **id 集** 与 **流元组**。
 *   - **每家各自比**：A 的判定永远是「同一 parser 的前后」，不需要任何归一化猜想。
 *   - **BpmnModdle 每次新建实例**（血泪教训：复用会串味 id 表）。
 *
 * 缺依赖则跳过，不 fail。用法：node cross-parser.mjs
 */
import { javaAvailable, runJava } from './lib/run-java.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const WS = join(PKG, '..', '..');
const SB = join(WS, '.workbuddy', '_bpmn-sandbox', 'node_modules');
const JARS = join(WS, '.workbuddy', '_bpmn-sandbox', 'jars');
const MIWG = join(WS, '.workbuddy', 'miwg');
const OUT = join(WS, '.workbuddy', 'cross-out');
const JAVAP = join(HERE, 'javaparser');

const BM = join(SB, 'bpmn-moddle', 'dist', 'index.js');
const CAM_JSON = join(SB, 'camunda-bpmn-moddle', 'resources', 'camunda.json');
const ZB_JSON = join(SB, 'zeebe-bpmn-moddle', 'resources', 'zeebe.json');
const CAM_JARS = [
  'camunda-bpmn-model-7.20.0.jar',
  'camunda-xml-model-7.20.0.jar',
  'slf4j-api-1.7.36.jar',
];
const FLW_JARS = [
  'flowable-bpmn-model-7.1.0.jar',
  'flowable-bpmn-converter-7.1.0.jar',
  'flowable-engine-common-api-7.1.0.jar',
  'slf4j-api-1.7.36.jar',
  'commons-lang3-3.14.0.jar',
];

const javaOk = javaAvailable();
const has = (arr) => arr.every((j) => existsSync(join(JARS, j)));
const camundaReady = javaOk && has(CAM_JARS);
const flowableReady = javaOk && has(FLW_JARS);

if (!existsSync(BM) || !existsSync(join(PKG, 'dist', 'index.js'))) {
  console.log('· check:graph-equiv — 跳过（沙箱缺 bpmn-moddle 或 dist 不在本机）');
  process.exit(0);
}

const { toXmlSync, fromXmlSync } = await import(
  pathToFileURL(join(PKG, 'dist', 'index.js')).href
);
const { BpmnModdle } = await import(pathToFileURL(BM).href);

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

// ─────────────────────────────────────────────────────────────────
// 指纹工具
// ─────────────────────────────────────────────────────────────────
const lower = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const idOf = (o) => (o == null ? '?' : typeof o === 'string' ? o : String(o.id ?? '?'));

/** 归一化成可比对的字符串：排序后拼接（行序无关） */
const norm = (lines) => [...new Set(lines)].sort().join('\n');

const pickN = (lines) => lines.filter((l) => l.startsWith('N\t'));
const pickF = (lines) => lines.filter((l) => l.startsWith('F\t'));
/** 跨工具只比 id 与连线端点 —— 类型名各家有分歧（见文件头口径纪律） */
const nodeIds = (lines) => new Set(pickN(lines).map((l) => l.split('\t')[2]));
const flowTuples = (lines) =>
  new Set(pickF(lines).map((l) => {
    const p = l.split('\t');
    return p[3] + '>' + p[4];
  }));

// ── 我们自己的模型 → 指纹 ─────────────────────────────────────────
function fpOurModel(def) {
  const lines = [];
  /*
   * ★ `sequenceFlow` 在 BPMN 里本身就是 **flowElement**（我们只是把它单独放在 `flows` 里），
   * 所以每家 parser 的**节点集**里都有连线。比对时两边口径必须一致，
   * 否则每家都会凭空"多"出全部连线 —— 一度看起来像 15 处不一致，其实是我这一边漏了。
   */
  const flows = (scope, list, parentId) => {
    for (const f of list ?? []) {
      lines.push('N\t' + scope + '\t' + f.id + '\t' + 'sequenceFlow');
      if (parentId) lines.push('C\t' + scope + '\t' + f.id + '\t' + parentId);
      lines.push('F\t' + scope + '\t' + f.id + '\t' + f.from + '\t' + f.to);
    }
  };
  for (const proc of def.processes ?? []) {
    const scope = proc.id ?? '?';
    const walkNodes = (nodes, parentId) => {
      for (const n of nodes ?? []) {
        lines.push('N\t' + scope + '\t' + n.id + '\t' + n.type);
        if (parentId) lines.push('C\t' + scope + '\t' + n.id + '\t' + parentId);
        if (n.defaultFlow) lines.push('G\t' + scope + '\t' + n.id + '\t' + n.defaultFlow);
        if (n.attachedTo) lines.push('B\t' + scope + '\t' + n.id + '\t' + n.attachedTo + '\t' + String(!!n.cancelActivity));
        if (n.nodes || n.flows) {
          flows(scope, n.flows, n.id);
          walkNodes(n.nodes, n.id);
        }
      }
    };
    walkNodes(proc.nodes, null);
    flows(scope, proc.flows, null);
    for (const ls of proc.laneSets ?? []) {
      for (const lane of ls.lanes ?? []) {
        if (!lane.nodeIds?.length) lines.push('L\t' + scope + '\t' + lane.id + '\t-');
        else for (const m of lane.nodeIds) lines.push('L\t' + scope + '\t' + lane.id + '\t' + m);
      }
    }
  }
  for (const c of def.collaborations ?? []) {
    for (const p of c.participants ?? [])
      lines.push('A\t' + c.id + '\t' + p.id + '\t' + String(p.processRef ?? '?'));
    for (const m of c.messageFlows ?? [])
      lines.push('M\t' + m.id + '\t' + m.from + '\t' + m.to);
  }
  return lines;
}

// ── bpmn-moddle 系 → 指纹 ─────────────────────────────────────────
function fpModdle(defs) {
  const lines = [];
  const T = (o) => {
    const t = o?.$type;
    if (!t) return '?';
    const parts = String(t).split(':');
    return parts[1] ?? parts[0];
  };
  const L = (s) => lower(String(s ?? '?'));

  const walk = (els, scope, parentId) => {
    for (const fe of els ?? []) {
      const id = fe.id ?? '?';
      lines.push('N\t' + scope + '\t' + id + '\t' + L(T(fe)));
      /*
       * ★ `sequenceFlow` 在 BPMN 里本身就是 **flowElement**（只不过我们模型把它单独放在
       * `flows` 里）。比对时两边口径必须一致，否则每家都会"多"出全部连线。
       */
      if (parentId) lines.push('C\t' + scope + '\t' + id + '\t' + parentId);
      if (T(fe) === 'SequenceFlow')
        lines.push('F\t' + scope + '\t' + id + '\t' + idOf(fe.sourceRef) + '\t' + idOf(fe.targetRef));
      if (fe.default) lines.push('G\t' + scope + '\t' + id + '\t' + idOf(fe.default));
      if (T(fe) === 'BoundaryEvent')
        lines.push('B\t' + scope + '\t' + id + '\t' + idOf(fe.attachedToRef) + '\t' + String(!!fe.cancelActivity));
      if (fe.flowElements || fe.artifacts)
        walk([...(fe.flowElements ?? []), ...(fe.artifacts ?? [])], scope, id);
    }
  };

  for (const r of defs?.rootElements ?? []) {
    const k = T(r);
    if (k !== 'Process') continue;
    const scope = r.id ?? '?';
    walk([...(r.flowElements ?? []), ...(r.artifacts ?? [])], scope, null);
    for (const ls of r.laneSets ?? []) {
      for (const lane of ls.lanes ?? []) {
        const refs = lane.flowNodeRef ?? [];
        if (!refs.length) lines.push('L\t' + scope + '\t' + lane.id + '\t-');
        else for (const m of refs) lines.push('L\t' + scope + '\t' + lane.id + '\t' + idOf(m));
      }
    }
  }
  for (const r of defs?.rootElements ?? []) {
    if (T(r) !== 'Collaboration') continue;
    for (const p of r.participants ?? [])
      lines.push('A\t' + r.id + '\t' + p.id + '\t' + idOf(p.processRef));
    for (const m of r.messageFlows ?? [])
      lines.push('M\t' + m.id + '\t' + idOf(m.sourceRef) + '\t' + idOf(m.targetRef));
  }
  for (const d of defs?.diagrams ?? []) {
    for (const pe of d.plane?.planeElement ?? []) {
      const be = pe.bpmnElement;
      if (be) lines.push('DI\t' + idOf(be));
    }
  }
  return lines;
}

/** 每次都要新建实例 —— 复用会把 id 表串味（这是 earlier 踩过的坑） */
async function parseModdle(xml, options) {
  const m = new BpmnModdle(options);
  const { rootElement, warnings } = await m.fromXML(xml);
  return { lines: fpModdle(rootElement), warnings: warnings ?? [] };
}

const moddleFlavors = [
  { name: 'moddle', options: undefined },
  existsSync(CAM_JSON)
    ? { name: 'moddle+camunda', options: { camunda: JSON.parse(readFileSync(CAM_JSON, 'utf8')) } }
    : null,
  existsSync(ZB_JSON)
    ? { name: 'moddle+zeebe', options: { zeebe: JSON.parse(readFileSync(ZB_JSON, 'utf8')) } }
    : null,
].filter(Boolean);

// ─────────────────────────────────────────────────────────────────
// Java 侧：一次跑一批，按 \t 行协议收指纹
// ─────────────────────────────────────────────────────────────────
function javaFingerprints(tool, jars, files) {
  const map = new Map();
  for (let i = 0; i < files.length; i += 15) {
    const batch = files.slice(i, i + 15);
    const rj = runJava({
      sandboxRoot: WS,
      label: `cross-${tool}`,
      classpath: jars.map((j) => join(JARS, j)),
      source: join(JAVAP, `${tool}.java`),
      args: batch,
    });
    if (!rj.ok && !rj.stdout.trim())
      console.log(`        [${tool}] Java 调用失败：${rj.error} ${rj.stderr.slice(0, 200)}`);
    const out = rj.stdout;
    let cur = null;
    for (const line of out.split('\n')) {
      if (!line.trim() || line.startsWith('SLF4J')) continue;
      const p = line.split('\t');
      if (p[0] === 'SRC') {
        cur = p[2];
        map.set(cur, []);
      } else if (p[0] === 'FERR') {
        map.set(p[2], ['FAIL:' + p.slice(3).join('\t')]);
      } else if (cur && p.length > 1) {
        map.get(cur).push(line);
      }
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────
console.log('\n跨解析器结构等价：同一份 XML 在每一家眼里，必须是同一张图');

mkdirSync(OUT, { recursive: true });

// 语料：原文件 + 我们转一圈
const pairs = [];
if (existsSync(MIWG)) {
  for (const f of readdirSync(MIWG).filter((x) => x.endsWith('.bpmn')).sort()) {
    const orig = join(MIWG, f);
    const rt = join(OUT, `miwg-${f}`);
    try {
      writeFileSync(rt, toXmlSync(fromXmlSync(readFileSync(orig))));
    } catch (e) {
      check(false, `语料转一圈 · ${f}`, String(e.message ?? e).slice(0, 120));
      continue;
    }
    pairs.push({ label: f, orig, rt });
  }
}

// 自家导出的样本（没有"原文"，走 B 判定）
const samples = {
  'ours-simple': {
    schemaVersion: '1.0.0',
    id: 'D1',
    processes: [
      {
        id: 'P1',
        executable: true,
        nodes: [
          { id: 's', type: 'startEvent', name: '开始' },
          { id: 'g', type: 'exclusiveGateway', name: '分流', defaultFlow: 'f2' },
          { id: 'm', type: 'parallelGateway', name: '并行', defaultFlow: undefined },
          { id: 't1', type: 'userTask', name: '审批' },
          { id: 'e', type: 'endEvent', name: '结束' },
        ],
        flows: [
          { id: 'f1', from: 's', to: 'g' },
          { id: 'f2', from: 'g', to: 't1' },
          { id: 'f3', from: 't1', to: 'm' },
          { id: 'f4', from: 'm', to: 'e' },
        ],
      },
    ],
  },
  'ours-nested': {
    schemaVersion: '1.0.0',
    id: 'D1',
    processes: [
      {
        id: 'P1',
        nodes: [
          { id: 's', type: 'startEvent' },
          {
            id: 'sub',
            type: 'subProcess',
            name: '子流程',
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
            attachedTo: 'sub',
            cancelActivity: false,
            eventDefinition: { type: 'timer', timeDuration: 'PT1H' },
          },
          { id: 'e', type: 'endEvent' },
        ],
        flows: [
          { id: 'f1', from: 's', to: 'sub' },
          { id: 'f2', from: 'sub', to: 'e' },
          { id: 'f3', from: 'be', to: 'e' },
        ],
      },
    ],
  },
  'ours-lanes': {
    schemaVersion: '1.0.0',
    id: 'D1',
    collaborations: [
      {
        id: 'C1',
        participants: [{ id: 'PA1', name: '采购部', processRef: 'P1' }],
        messageFlows: [],
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
          { id: 's', type: 'startEvent' },
          { id: 't1', type: 'userTask' },
          { id: 'e', type: 'endEvent' },
        ],
        flows: [
          { id: 'f1', from: 's', to: 't1' },
          { id: 'f2', from: 't1', to: 'e' },
        ],
      },
    ],
  },
};

// ── 收集所有指纹 ─────────────────────────────────────────────────
/** tool → Map<path, string[]>（value[0] 可能是 'FAIL:...'） */
const fps = new Map();
const toolNames = [];

for (const fl of moddleFlavors) {
  const m = new Map();
  for (const { orig, rt } of pairs) {
    const a = await parseModdle(readFileSync(orig, 'utf8'), fl.options);
    const b = await parseModdle(readFileSync(rt, 'utf8'), fl.options);
    m.set(orig, a.lines);
    m.set(rt, b.lines);
  }
  for (const [name, model] of Object.entries(samples)) {
    const xml = toXmlSync(model);
    const r = await parseModdle(xml, fl.options);
    m.set('sample:' + name, r.lines);
  }
  fps.set(fl.name, m);
  toolNames.push(fl.name);
}

if (camundaReady) {
  const files = pairs.flatMap((p) => [p.orig, p.rt]);
  const sampleFiles = Object.entries(samples).map(([name, model]) => {
    const p = join(OUT, `sample-${name}.bpmn`);
    writeFileSync(p, toXmlSync(model));
    return p;
  });
  const ordering = [...files, ...sampleFiles];
  const raw = javaFingerprints('CamundaFp', CAM_JARS, ordering);
  const m = new Map();
  for (const p of ordering) m.set(p, raw.get(p) ?? ['FAIL:no result']);
  for (const p of sampleFiles) {
    const key = 'sample:' + p.split('sample-')[1].replace('.bpmn', '');
    m.set(key, m.get(p));
  }
  fps.set('camunda', m);
  toolNames.push('camunda');
} else {
  console.log('  ·   Camunda Java 不在位（跳过该对照物）');
}

if (flowableReady) {
  const files = pairs.flatMap((p) => [p.orig, p.rt]);
  const sampleFiles = Object.entries(samples).map(([name, model]) =>
    join(OUT, `sample-${name}.bpmn`),
  );
  const ordering = [...files, ...sampleFiles];
  const raw = javaFingerprints('FlowableFp', FLW_JARS, ordering);
  const m = new Map();
  for (const p of ordering) m.set(p, raw.get(p) ?? ['FAIL:no result']);
  for (const p of sampleFiles) {
    const key = 'sample:' + p.split('sample-')[1].replace('.bpmn', '');
    m.set(key, m.get(p));
  }
  fps.set('flowable', m);
  toolNames.push('flowable');
} else {
  console.log('  ·   Flowable Java 不在位（跳过该对照物）');
}

console.log(`  ·   参与比对的解析器：${toolNames.join(' / ')}`);

// ── A. 每一家都看不见我们碰过文件 ────────────────────────────────
let changed = 0;
const examples = [];
for (const tool of toolNames) {
  const m = fps.get(tool);
  for (const { label, orig, rt } of pairs) {
    const a = m.get(orig) ?? [];
    const b = m.get(rt) ?? [];
    if (a[0]?.startsWith('FAIL:') || b[0]?.startsWith('FAIL:')) {
      changed++;
      examples.push(`${tool}/${label}: ${a[0]?.startsWith('FAIL:') ? a[0] : b[0]}`.slice(0, 140));
      continue;
    }
    if (norm(a) !== norm(b)) {
      changed++;
      const sa = new Set(a);
      const sb = new Set(b);
      const gone = [...sa].filter((x) => !sb.has(x));
      const come = [...sb].filter((x) => !sa.has(x));
      examples.push(
        `${tool}/${label}: 少 ${gone.length} 条、多 ${come.length} 条${gone.length ? `（如 ${gone[0]}）` : ''}${come.length ? `（如 ${come[0]}）` : ''}`,
      );
    }
  }
}
for (const e of examples.slice(0, 12)) console.log(`        ${e}`);
check(
  changed === 0,
  `A. 语料 ${pairs.length} 份 × ${toolNames.length} 家：同一家 parser 看不出我们转过一圈`,
  `${changed} 处前后不一`,
);

// ── B. 我们模型的意图 == 各家从我们导出结果读出来的图 ────────────
let mismatch = 0;
for (const tool of toolNames) {
  const m = fps.get(tool);
  for (const [name, model] of Object.entries(samples)) {
    const key = 'sample:' + name;
    const theirs = m.get(key) ?? [];
    if (theirs[0]?.startsWith('FAIL:')) {
      mismatch++;
      console.log(`        ${tool}/${name}: ${theirs[0]}`.slice(0, 160));
      continue;
    }
    const mine = fpOurModel(model);
    const idsA = nodeIds(mine);
    const idsB = nodeIds(theirs);
    const flA = flowTuples(mine);
    const flB = flowTuples(theirs);
    const missN = [...idsA].filter((x) => !idsB.has(x));
    const extraN = [...idsB].filter((x) => !idsA.has(x));
    const missF = [...flA].filter((x) => !flB.has(x));
    const extraF = [...flB].filter((x) => !flA.has(x));
    if (missN.length || extraN.length || missF.length || extraF.length) {
      mismatch++;
      console.log(
        `        ${tool}/${name}: 节点缺[${missN.join(',')}] 多[${extraN.join(',')}] 连线缺[${missF.join(',')}] 多[${extraF.join(',')}]`,
      );
    }
  }
}
check(
  mismatch === 0,
  `B. 自家 ${Object.keys(samples).length} 个样本 × ${toolNames.length} 家：节点集与连线集与我们模型的意图一致`,
  `${mismatch} 处不一致`,
);

// ── C. 报（不判）：跨工具类型名分歧，留作证据 ────────────────────
// 同 id 各家给出的类型名不一致的地方 —— 这是**各家解析器自身的建模差异**
// （最典型：`<task>` Camunda 认 task、Flowable 认 manualTask），与我们的转换无关。
// 之所以要对它单独取证：万一哪天这项从"原文就有"变成"转一圈后新增"，就是真 bug。
let typeDiv = 0;
let typeDivFiles = 0;
for (const { label, orig } of pairs) {
  const byId = new Map();
  for (const tool of toolNames) {
    for (const l of pickN(fps.get(tool).get(orig) ?? [])) {
      const [, , id, type] = l.split('\t');
      if (!byId.has(id)) byId.set(id, new Map());
      byId.get(id).set(tool, type);
    }
  }
  let n = 0;
  let sample = '';
  for (const [id, tm] of byId) {
    const vals = new Set(tm.values());
    if (vals.size > 1) {
      n++;
      if (!sample) sample = `${id}: ${[...tm].map(([t, v]) => `${t}=${v}`).join(' ')}`;
    }
  }
  if (n > 0) {
    typeDiv += n;
    typeDivFiles++;
    if (typeDivFiles <= 4) console.log(`        ${label} 有 ${n} 个 id 类型名不一致，如 ${sample}`);
  }
}
console.log(
  `  ·   跨工具类型名分歧合计 ${typeDiv} 处（分布在 ${typeDivFiles}/${pairs.length} 份语料上）—— 原文即有，不参与判定`,
);

process.exit(failures ? 1 : 0);
