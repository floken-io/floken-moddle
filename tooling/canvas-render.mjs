/*
 * 画布对照物：**bpmn-visualization**（Process Analytics 出品，基于 mxGraph 的**真实渲染**库，
 * 与 bpmn-js 同族但独立）。verify 第十七道门禁。
 *
 * 为什么它和前面所有对照物都不一样：前面验的都是「**解析**器认不认」，
 * 而**画布真的会把 DI 画出来** —— 坐标、泳道、连线走向错一点，图上就是错的或空的。
 * 这是唯一能证明「我们写出的 `bpmndi:*` 真的能用」的手段。
 *
 * 依赖：沙箱里的 `jsdom` + `bpmn-visualization`（都在 `.workbuddy/_bpmn-sandbox/node_modules`）。
 * 缺失则跳过，不 fail。
 *
 * 用法：node canvas-render.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const WS = join(PKG, '..', '..');
const SB = join(WS, '.workbuddy', '_bpmn-sandbox', 'node_modules');
const MIWG = join(WS, '.workbuddy', 'miwg');
const OUT = join(WS, '.workbuddy', 'xsd-out');

const JSDOM = join(SB, 'jsdom', 'lib', 'api.js');
const BV = join(SB, 'bpmn-visualization', 'dist', 'bpmn-visualization.esm.js');
if (!existsSync(JSDOM) || !existsSync(BV)) {
  console.log('· check:canvas — 跳过（沙箱缺 jsdom / bpmn-visualization）');
  process.exit(0);
}

const { toXmlSync, fromXmlSync } = await import(pathToFileURL(join(PKG, 'dist', 'index.js')).href);

// ── 注入浏览器全局（mxGraph 强依赖 DOM / SVG） ────────────────────
const { JSDOM: JsdomCtor } = await import(pathToFileURL(JSDOM).href);
const dom = new JsdomCtor('<!doctype html><html><body><div id="c"></div></body></html>', {
  pretendToBeVisual: true,
});
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
for (const k of [
  'Element',
  'HTMLElement',
  'SVGElement',
  'Node',
  'MutationObserver',
  'getComputedStyle',
  'DOMParser',
  'XMLSerializer',
  'Event',
  'CustomEvent',
  'Image',
]) {
  if (w[k] !== undefined) globalThis[k] = w[k];
}
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const { BpmnVisualization } = await import(pathToFileURL(BV).href);
const container = w.document.getElementById('c');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

/** 渲染一份 XML，返回 { ids: Map<id, kind>, svgNodes: number } */
const render = (xml) => {
  const bv = new BpmnVisualization({ container });
  bv.load(xml);
  const ids = new Map();
  for (const el of bv.bpmnElementsRegistry.getModelElementsByIds([]) ?? []) {
    ids.set(el.id, el.kind);
  }
  return { bv, ids, svgNodes: container.querySelectorAll('*').length };
};

console.log('\n画布对照物：bpmn-visualization（mxGraph 真实渲染）');

// ── 1. 我们导出的样本：图元数 + kind 必须与模型一致 ───────────────
const model = {
  schemaVersion: '1.0.0',
  id: 'D1',
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
};
const oursXml = toXmlSync(model);
const r = render(oursXml);
const expectKind = {
  s: 'startEvent',
  g: 'exclusiveGateway',
  t1: 'userTask',
  e: 'endEvent',
  f1: 'sequenceFlow',
  f2: 'sequenceFlow',
  f3: 'sequenceFlow',
};
const got = r.bv.bpmnElementsRegistry.getModelElementsByIds(Object.keys(expectKind));
check(got.length === 7, '我们导出的文件：7 个图元全部被画布识别', `实得 ${got.length}`);
let kindBad = 0;
for (const el of got) {
  if (el.kind !== expectKind[el.id]) {
    kindBad++;
    console.log(`        ${el.id}: 期望 ${expectKind[el.id]}，实得 ${el.kind}`);
  }
}
check(kindBad === 0, '每个图元的 **kind** 都正确（不是"渲染了但认错类型"）');
check(r.svgNodes > 20, 'SVG 里真的画出了东西（不是空画布）', `${r.svgNodes} 个 SVG 节点`);

// ── 2. 泳道图：池 / 泳道也必须画出来 ─────────────────────────────
const laneModel = {
  schemaVersion: '1.0.0',
  id: 'D1',
  collaborations: [
    { id: 'C1', participants: [{ id: 'PA1', name: '采购部', processRef: 'P1' }], messageFlows: [] },
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
};
const laneXml = toXmlSync(laneModel);
const rl = render(laneXml);
const laneEls = rl.bv.bpmnElementsRegistry.getModelElementsByIds(['L1', 'L2', 'PA1', 's', 't1']);
check(
  laneEls.length === 5,
  '泳道图：两条泳道 + 池 + 节点全部被画布识别',
  `实得 ${laneEls.length}（${laneEls.map((e) => `${e.id}:${e.kind}`).join(', ')}）`,
);

// ── 3. MIWG 语料转一圈后仍能渲染（不抛） ─────────────────────────
if (existsSync(MIWG) && existsSync(OUT)) {
  const files = readdirSync(MIWG).filter((f) => f.endsWith('.bpmn')).sort();
  let broke = 0;
  let rendered = 0;
  for (const f of files) {
    const rt = join(OUT, `miwg-${f}`);
    if (!existsSync(rt)) continue;
    try {
      const rr = render(readFileSync(rt, 'utf8'));
      if (rr.svgNodes > 0) rendered++;
    } catch (e) {
      broke++;
      console.log(`        ${f} 渲染抛错：${String(e.message ?? e).slice(0, 100)}`);
    }
  }
  check(broke === 0, `MIWG ${files.length} 份语料转一圈后画布渲染不抛错`, `抛错 ${broke} 份，成功 ${rendered} 份`);
}

process.exit(failures ? 1 : 0);
