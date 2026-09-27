/*
 * **bpmn-js 真实导入器**对照物（verify 第十九道门禁）。
 *
 * 为什么在 `check:canvas`（bpmn-visualization）之外还要它：
 * bpmn-js 是 Camunda Modeler 的底层，它导入时跑的是**自己的一整套 behavior**
 * （BPMN 语义校验 + diagram-js 的元素建模 + 默认 DI 兜底），而且 bpmn-js 对
 * `bpmndi:*` 的挑剔程度远高于纯解析器 —— 本包历史上最难的两个 bug
 * （DI id 撞车、shape 嵌套）都是它先报出来的。
 *
 * 依赖：`jsdom` + `esbuild` + `bpmn-js`（都在 `.workbuddy/_bpmn-sandbox/node_modules`）。
 * 缺失则跳过，不 fail。用法：node bpmnjs-import.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { runRedirected } from './lib/run-process.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const WS = join(PKG, '..', '..');
const SB = join(WS, '.workbuddy', '_bpmn-sandbox');
const MODULES = join(SB, 'node_modules');
const MIWG = join(WS, '.workbuddy', 'miwg');

const JSDOM = join(MODULES, 'jsdom', 'lib', 'api.js');
const MODELLER = join(MODULES, 'bpmn-js', 'lib', 'Modeler.js');
const VIEWER = join(MODULES, 'bpmn-js', 'lib', 'Viewer.js');
const ESBUILD = join(MODULES, '@esbuild', 'win32-x64', 'esbuild.exe');

if (
  !existsSync(JSDOM) ||
  !existsSync(MODELLER) ||
  !existsSync(VIEWER) ||
  !existsSync(ESBUILD) ||
  !existsSync(join(PKG, 'dist', 'index.js'))
) {
  console.log('· check:bpmnjs — 跳过（沙箱缺 jsdom / esbuild / bpmn-js，或 dist 不在本机）');
  process.exit(0);
}

const { toXmlSync, fromXmlSync } = await import(
  pathToFileURL(join(PKG, 'dist', 'index.js')).href
);

/*
 * 入口必须写在**沙箱里**，且用**相对路径**引入：
 *   · 放在仓库 tooling/ 下会找不到 `node_modules`（esbuild "Could not resolve"）；
 *   · `file://` 形式的 specifier esbuild 也不认。
 */
const ENTRY = join(SB, '.bpmn-js-entry.mjs');
const BUNDLE = join(SB, '.bpmn-js.bundle.mjs');
writeFileSync(
  ENTRY,
  `export { default as Modeler } from './node_modules/bpmn-js/lib/Modeler.js';\n` +
    `export { default as Viewer } from './node_modules/bpmn-js/lib/Viewer.js';\n`,
  'utf8',
);
const bundle = runRedirected({
  cwd: WS,
  label: 'esbuild-bpmn-js',
  cmd: ESBUILD,
  args: [
    ENTRY,
    '--bundle',
    '--format=esm',
    '--platform=neutral',
    '--main-fields=module,main',
    '--loader:.css=empty',
    `--outfile=${BUNDLE}`,
  ],
});
if (!bundle.ok || !existsSync(BUNDLE)) {
  console.log(
    `· check:bpmnjs — 跳过（esbuild 打包失败）：${(bundle.stderr || bundle.error || '').slice(0, 300)}`,
  );
  process.exit(0);
}

// ── jsdom 全局（diagram-js 要 DOM / SVG） ────────────────────────
const { JSDOM: JsdomCtor } = await import(pathToFileURL(JSDOM).href);
const dom = new JsdomCtor('<!doctype html><html><body><div id="c" style="width:1200px;height:600px"></div></body></html>', {
  pretendToBeVisual: true,
});
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
for (const k of [
  'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver',
  'getComputedStyle', 'DOMParser', 'XMLSerializer', 'Event', 'CustomEvent', 'Image',
]) {
  if (w[k] !== undefined) globalThis[k] = w[k];
}
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

/*
 * ★ jsdom 不实现 SVG 的几何度量方法（`getBBox` / `getCTM` / `getScreenCTM` …），
 * 而 diagram-js 一设 root 就算 viewbox → 没有它们会抛 `activeLayer.getBBox is not a function`。
 * 这是 **jsdom 的能力缺口，不是 BPMN 的问题**，所以在这里补齐（返回 0 盒单位矩阵即可，
 * 我们只验"导入能不能成立 / warning 有没有变多"，不验像素）。
 */
const svgProto = w.SVGElement?.prototype ?? {};
if (!svgProto.getBBox)
  svgProto.getBBox = function getBBox() {
    return { x: 0, y: 0, width: 0, height: 0 };
  };
const identityCTM = () => ({
  a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
  inverse() { return identityCTM(); },
  multiply(m) { return m; },
});
if (!svgProto.getCTM) svgProto.getCTM = identityCTM;
if (!svgProto.getScreenCTM) svgProto.getScreenCTM = identityCTM;
if (!w.SVGSVGElement?.prototype?.createSVGPoint)
  w.SVGSVGElement.prototype.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform: () => ({ x: 0, y: 0 }) });

/*
 * tiny-svg 还会读 `el.transform.baseVal` / `el.transform.baseVal.consolidate()` ——
 * jsdom 连 `transform` 这个动画属性都没有，于是 "Cannot read properties of undefined
 * (reading 'baseVal')"。同样按 unit/inert 值补齐。
 */
const emptyTransform = {
  baseVal: {
    numberOfItems: 0,
    consolidate: () => null,
    clear: () => undefined,
    getItem: () => null,
    removeItem: () => null,
    appendItem: () => undefined,
    initialize: () => undefined,
  },
  animVal: { numberOfItems: 0, getItem: () => null },
};
if (!('transform' in svgProto))
  Object.defineProperty(svgProto, 'transform', {
    get: () => emptyTransform,
    configurable: true,
  });

/*
 * tiny-svg 的 transform 工具链要用 `createSVGMatrix` / `createSVGTransform` / `createSVGRect`
 * （jsdom 一律没实现）。一次补齐——若这里还缺别的，脚本会自行跳过并在报告里说明，
 * 不要为了让对照物跑起来而无限补垫片：补到最后验的是垫片，不是 BPMN。
 */
const svgRootProto = w.SVGSVGElement?.prototype ?? {};
const matrix = () => ({
  a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
  multiply(m) { return m; },
  inverse() { return matrix(); },
  translate: (x, y) => matrix(),
  scale: (s) => matrix(),
  rotate: (r) => matrix(),
});
if (!svgRootProto.createSVGMatrix) svgRootProto.createSVGMatrix = matrix;
if (!svgRootProto.createSVGTransform)
  svgRootProto.createSVGTransform = () => ({ setMatrix: () => undefined, matrix: matrix() });
if (!svgRootProto.createSVGRect)
  svgRootProto.createSVGRect = () => ({ x: 0, y: 0, width: 0, height: 0 });

const { Viewer } = await import(pathToFileURL(BUNDLE).href);

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

/** 用 bpmn-js 导入，返回 { elements, warnings }；抛错则 throw */
const importWith = async (xml) => {
  const viewer = new Viewer({ container: w.document.getElementById('c') });
  const res = await viewer.importXML(xml);
  const warnings = Array.isArray(res?.warnings) ? res.warnings : [];
  const registry = viewer.get('elementRegistry');
  const elements = registry ? registry.getAll() : [];
  viewer.destroy?.();
  return { elements, warnings };
};

/*
 * ★ 区分两类 warning：
 *   · **jsdom 缺 SVG 度量 API** 导致的"画不出来"（`... is not a function` / `getBBox` /
 *     `getContext` / `baseVal`）—— 这是 jsdom 的能力缺口，**原文与转一圈一律同吃**，
 *     与 BPMN 无关，不计入判定；
 *   · 其余（引用悬空、元素不成立 …）才是真·导入问题。
 * 不这么分开，门禁会因为"在假浏览器里画不出 SVG"而一直红。
 */
const JSDOM_GAP = /is not a function|getBBox|getContext|baseVal|getScreenCTM/;
const realWarnings = (ws) => ws.filter((x) => !JSDOM_GAP.test(String(x.message ?? x)));

console.log('\nbpmn-js 真实导入器（Camunda Modeler 底层）');

// ── 1. 自家导出的样本：能进 come in 且图元齐 ─────────────────────
const sample = {
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
try {
  const r = await importWith(toXmlSync(sample));
  const ids = new Set(r.elements.map((e) => e.id));
  check(
    ['s', 'g', 't1', 'e', 'f1', 'f2', 'f3'].every((x) => ids.has(x)) && r.elements.length >= 7,
    '我们导出的文件：7 个图元全部进入 bpmn-js 的元素表',
    `实得 ${r.elements.length} 个`,
  );
  const diMissing = r.elements.filter((el) => !el.di).map((el) => el.id);
  check(diMissing.length === 0, '每个图元都带上了 DI（bpmn-js 认得坐标）', `缺 DI：${diMissing.slice(0, 5).join(',')}`);
  const real = realWarnings(r.warnings);
  check(
    real.length === 0,
    '导入零 warning（jsdom 的 SVG 渲染缺口另算，见脚本注释）',
    `真 warning ${real.length} 条${real.length ? `：${real.slice(0, 2).map((x) => String(x.message ?? x).slice(0, 100)).join(' | ')}` : ''}，画布类 ${r.warnings.length - real.length} 条`,
  );
} catch (e) {
  check(false, '我们导出的文件能被 bpmn-js 导入', String(e.message ?? e).slice(0, 160));
}

// ── 2. MIWG 语料：转一圈后 warning 数不比原文差 ──────────────────
if (existsSync(MIWG)) {
  const files = readdirSync(MIWG).filter((f) => f.endsWith('.bpmn')).sort();
  let worse = 0;
  let thrown = 0;
  const rows = [];
  for (const f of files) {
    const src = readFileSync(join(MIWG, f), 'utf8');
    let rt;
    try {
      rt = toXmlSync(fromXmlSync(src));
    } catch (e) {
      worse++;
      continue;
    }
    let base;
    let after;
    try {
      base = await importWith(src);
      after = await importWith(rt);
    } catch (e) {
      // 原文就导入失败的不算我们的锅，但要记下来
      thrown++;
      rows.push(`${f}: bpmn-js 导入抛错 ${String(e.message ?? e).slice(0, 60)}`);
      continue;
    }
    const bReal = realWarnings(base.warnings);
    const aReal = realWarnings(after.warnings);
    // 元素表里的图元数也不能变少（坐标丢、元素被吞，这里先掉）
    if (aReal.length > bReal.length || after.elements.length < base.elements.length) {
      worse++;
      rows.push(
        `${f}: warning ${bReal.length} → ${aReal.length}，图元 ${base.elements.length} → ${after.elements.length}｜` +
          aReal.slice(0, 1).map((x) => String(x.message ?? x).slice(0, 90)).join(''),
      );
    }
  }
  for (const r of rows.slice(0, 8)) console.log(`        ${r}`);
  check(thrown === 0, `MIWG ${files.length} 份语料（原 + 转一圈）bpmn-js 都能导入`, `抛错 ${thrown} 份`);
  check(worse === 0, '转一圈后 bpmn-js 的 warning 数不比原文多', `${worse} 份变差`);
}

process.exit(failures ? 1 : 0);
