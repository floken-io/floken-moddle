/**
 * 语料保真度实证（verify 第十三道）
 *
 * ★ 与 `strict-import`（第十二道）的分工：
 * - `strict-import` 只问「默认配置能不能导入」→ 曾经 **22/22 通过**，
 *   而实际上 **4 份语料导入后内容是空的**、2 份静默少了 participant / documentation。
 *   「不抛错」和「内容还在」是两件事，只测前者等于没测。
 * - 本门禁问两件事：
 *   ① **信息守恒**：源文件的元素计数 vs 往返后的计数，逐类比对；
 *   ② **可校验**：导入结果再跑 `validateDefinition`，**合法语料不该产出 error**。
 *
 * 语料一次性抓取到工作区 `.workbuddy/miwg/`（`tooling/fetch-miwg.mjs`），
 * 不在包内、不进依赖链；语料缺失时**跳过**（exit 0）。
 *
 * 用法：node tooling/corpus-fidelity.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const CORPUS = join(dirname(dirname(pkgRoot)), '.workbuddy/miwg');

if (!existsSync(CORPUS)) {
  console.log('· corpus-fidelity — 跳过（语料不在本机；先跑 node tooling/fetch-miwg.mjs）');
  process.exit(0);
}
if (!existsSync(join(pkgRoot, 'dist/index.js'))) {
  console.error('· corpus-fidelity — dist 未构建，先跑 tsup');
  process.exit(1);
}

const { fromXmlSync, toXmlSync, validateDefinition } = await import(
  'file:///' + join(pkgRoot, 'dist/index.js').replace(/\\/g, '/')
);

/** 命名空间前缀任意：语料里 `bpmn:` / `semantic:` / 默认无前缀都有 */
const P = '(?:[A-Za-z_][\\w.-]*:)?';
const c = (xml, re) => (xml.match(re) ?? []).length;

const NODES = new RegExp(`<${P}(?:startEvent|endEvent|intermediateThrowEvent|intermediateCatchEvent|boundaryEvent|task|userTask|serviceTask|scriptTask|sendTask|receiveTask|manualTask|businessRuleTask|callActivity|subProcess|transaction|adHocSubProcess|exclusiveGateway|inclusiveGateway|parallelGateway|complexGateway|eventBasedGateway)[\\s/>]`, 'g');
const METRICS = {
  nodes: (x) => c(x, NODES),
  flows: (x) => c(x, new RegExp(`<${P}sequenceFlow[\\s/>]`, 'g')),
  eventDefinitions: (x) => c(x, new RegExp(`<${P}\\w*EventDefinition[\\s/>]`, 'g')),
  lanes: (x) => c(x, new RegExp(`<${P}lane[\\s/>]`, 'g')),
  participants: (x) => c(x, new RegExp(`<${P}participant[\\s/>]`, 'g')),
  messageFlows: (x) => c(x, new RegExp(`<${P}messageFlow[\\s/>]`, 'g')),
  documentations: (x) => c(x, new RegExp(`<${P}documentation[\\s/>]`, 'g')),
  collaborations: (x) => c(x, new RegExp(`<${P}collaboration[\\s/>]`, 'g')),
};

const files = readdirSync(CORPUS).filter((f) => f.endsWith('.bpmn')).sort();
const rows = [];
let failures = 0;
let totalErrors = 0;
let totalDiagnostics = 0;

for (const f of files) {
  const src = readFileSync(join(CORPUS, f), 'utf8');
  const before = {};
  for (const [k, fn] of Object.entries(METRICS)) before[k] = fn(src);

  let after = {};
  try {
    const def = fromXmlSync(src);
    after = {};
    const out = toXmlSync(def, { declaration: false, autoLayout: false });
    for (const [k, fn] of Object.entries(METRICS)) after[k] = fn(out);

    const ds = validateDefinition(def);
    totalDiagnostics += ds.length;
    totalErrors += ds.filter((d) => d.severity === 'error').length;
  } catch (e) {
    rows.push(`${f.padEnd(14)}  THROW ${(e && e.code) || e}`);
    failures++;
    continue;
  }

  const diffs = Object.keys(METRICS)
    .filter((k) => before[k] !== after[k])
    .map((k) => `${k} ${before[k]}→${after[k]}`);
  if (diffs.length) failures++;
  rows.push(`${f.padEnd(14)}  ${diffs.length ? 'LOSS ' + diffs.join(', ') : 'OK'}`);
}

console.log('语料保真度（源 vs 往返后，逐类计数）');
console.log(rows.join('\n'));
console.log(`\n  ${files.length} 份 · 不守恒 ${failures} 份 · 导入后诊断 ${totalDiagnostics} 条（error ${totalErrors} 条）`);

if (totalErrors > 0) {
  console.error(`  FAIL：合法语料导入后被自己的校验器判 ${totalErrors} 条 error`);
  failures++;
}
if (failures) {
  console.error(`  FAIL：${failures} 项不通过`);
  process.exit(1);
}
console.log('  PASS：内容守恒 + 零 error 诊断');
