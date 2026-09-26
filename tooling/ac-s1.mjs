/**
 * AC-S1 实证：导出的 BPMN 必须能被**标准工具**解析并渲染。
 *
 * 判据用 **bpmn-moddle 10.3.0**（bpmn-js 的解析内核，Camunda Modeler / bpmn-js 走同一套描述符）：
 * - `fromXML` **零 warning** —— 有 warning 就说明产出了它不认识的 XML；
 * - 每个语义元素（FlowNode / SequenceFlow）**都有对应 DI** ——
 *   缺 DI 正是 bpmn-js 弹 `no diagram to display` 的根因。
 *
 * 沙箱（`.workbuddy/_bpmn-sandbox`）不在本机时**跳过**（exit 0），不判 fail：
 * bpmn-moddle 只是一次性实证的对照物，既不进依赖链、也不进 dist（Q38）。
 *
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §13 AC-S1
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const wsRoot = dirname(dirname(pkgRoot));
const MODDLE = join(wsRoot, '.workbuddy/_bpmn-sandbox/node_modules/bpmn-moddle/dist/index.js');
const SAMPLE = join(pkgRoot, 'examples/expense.bpmn');

const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  console.error(`  FAIL ${m}`);
  process.exitCode = 1;
};

if (!existsSync(MODDLE)) {
  console.log('· ac-s1 — 跳过（沙箱 bpmn-moddle 不在本机；属预期，它不是依赖）');
  process.exit(0);
}
if (!existsSync(SAMPLE)) {
  bad(`样例文件缺失：${SAMPLE}（先跑 node examples/gen-sample.mjs）`);
  process.exit(1);
}

const { BpmnModdle } = await import('file:///' + MODDLE.replace(/\\/g, '/'));
const moddle = new BpmnModdle({});
const xml = readFileSync(SAMPLE, 'utf8');
const { rootElement, warnings } = await moddle.fromXML(xml, { lax: true });

let failures = 0;
const check = (cond, msg) => (cond ? ok(msg) : (failures++, bad(msg)));

// 1. 解析零 warning
check(
  warnings.length === 0,
  `bpmn-moddle 解析零 warning（实得 ${warnings.length}）` +
    (warnings.length ? `\n       ${warnings.map((w) => w.message.split('\n')[0]).join('\n       ')}` : ''),
);

// 2. 根元素
check(rootElement?.$type === 'bpmn:Definitions', `根元素是 bpmn:Definitions（实得 ${rootElement?.$type}）`);

// 3. process 与 DI 图形一一对应（"no diagram to display" 的直接判据）
const proc = rootElement.rootElements?.find((e) => e.$type === 'bpmn:Process');
check(!!proc, '至少有一个 bpmn:Process');
// 语义元素要**递归**收集：子流程内元素挂在 subProcess.flowElements 上，
// 但它们同样需要 DI —— 漏收集会把「正确」判成「悬空」。
const collect = (list) =>
  (list ?? []).flatMap((e) => [e.id, ...collect(e.flowElements)]);
const semantic = collect(proc?.flowElements);
const plane = rootElement.diagrams?.[0]?.plane;
const drawn = (plane?.planeElement ?? []).map((de) => de.bpmnElement?.id).filter(Boolean);
const missing = semantic.filter((id) => !drawn.includes(id));
const orphan = drawn.filter((id) => !semantic.includes(id));
check(missing.length === 0, `${semantic.length} 个语义元素全部有 DI（缺：${missing.join(',') || '无'}）`);
check(orphan.length === 0, `DI 无悬空引用（多出：${orphan.join(',') || '无'}）`);

// 4. 图形本身合法：shape 有 bounds、edge 至少两个 waypoint
let badGeom = 0;
for (const de of plane?.planeElement ?? []) {
  if (de.$type === 'bpmndi:BPMNShape') {
    const b = de.bounds;
    if (!b || b.width === undefined || b.height === undefined) badGeom++;
  } else if (de.$type === 'bpmndi:BPMNEdge') {
    if (!de.waypoint || de.waypoint.length < 2) badGeom++;
  }
}
check(badGeom === 0, `所有 DI 图形几何完整（异常 ${badGeom} 个）`);

// 5. 自有扩展可读回（引擎语义落点）
const task = proc?.flowElements?.find((e) => e.$type === 'bpmn:UserTask');
const approval = task?.extensionElements?.values?.find((v) => v.$type === 'floken:approval');
check(!!approval, `floken:approval 被解析为扩展元素（${approval ? '可读' : '未找到'}）`);

// 6. 二次导出幂等（同一 JSON 两次导出字节一致）
const { toXmlSync } = await import('file:///' + join(pkgRoot, 'dist/index.js').replace(/\\/g, '/'));
const { fromXmlSync } = await import('file:///' + join(pkgRoot, 'dist/index.js').replace(/\\/g, '/'));
const back = fromXmlSync(xml);
const twice = toXmlSync(back);
check(twice === xml, '二次导出逐字节一致（幂等）');

console.log(
  failures === 0
    ? '\nAC-S1 实证通过：bpmn-moddle 10.3.0 零 warning 解析，DI 覆盖完整'
    : `\nAC-S1 实证失败：${failures} 项`,
);
process.exit(failures === 0 ? 0 : 1);
