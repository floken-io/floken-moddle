/**
 * FR-S15 实证：拿 **MIWG 互操作测试套件**的 22 份真实 BPMN 当语料，跑
 * 「导入 → 导出 → 再导入」，看解析器在真实世界的脏文件上会不会崩。
 *
 * 语料是**一次性抓取**的（`tooling/fetch-miwg.mjs` → 工作区 `.workbuddy/miwg/`），
 * 不在包内、不进依赖链；语料不在本机时**跳过**（exit 0）。
 *
 * 口径（导入宽容、导出严格）：
 * - 导入一律 `onUnsupported:'warn'` —— MIWG 里有大量我们没承诺的元素（pool/lane/messageFlow…），
 *   「认不出」是**预期**，重点是**不崩、不丢**；
 * - 二次导出必须**逐字节幂等**（`toXml(fromXml(toXml(x))) === toXml(x)`）。
 *
 * 用法：node tooling/fetch-miwg.mjs && node tooling/miwg.mjs
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §10 FR-S15
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const CORPUS = join(dirname(dirname(pkgRoot)), '.workbuddy/miwg');

if (!existsSync(CORPUS)) {
  console.log('· miwg — 跳过（语料不在本机；先跑 node tooling/fetch-miwg.mjs）');
  process.exit(0);
}
if (!existsSync(join(pkgRoot, 'dist/index.js'))) {
  console.error('· miwg — dist 未构建，先跑 tsup');
  process.exit(1);
}

const { fromXmlSync, toXmlSync } = await import('file:///' + join(pkgRoot, 'dist/index.js').replace(/\\/g, '/'));

const files = readdirSync(CORPUS).filter((f) => f.endsWith('.bpmn')).sort();
const rows = [];

for (const f of files) {
  const xml = readFileSync(join(CORPUS, f), 'utf8');
  const diags = [];
  const row = { file: f, nodes: 0, flows: 0, planes: 0, diags: 0, err: null, idempotent: null };
  try {
    const def = fromXmlSync(xml, {
      onUnsupported: 'warn',
      onDiagnostic: (d) => diags.push(d),
      allowDoctype: true,
    });
    row.diags = diags.length;
    for (const p of def.processes) {
      row.nodes += p.nodes.length;
      row.flows += p.flows.length;
    }
    row.planes = def.layout?.planes?.length ?? 0;

    const out1 = toXmlSync(def);
    const back = fromXmlSync(out1, { onUnsupported: 'warn' });
    const out2 = toXmlSync(back);
    row.idempotent = out1 === out2;
  } catch (e) {
    row.err = `${(e && e.code) || ''} ${(e && e.message) || e}`.trim();
  }
  rows.push(row);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('文件', 14), pad('节点', 6), pad('连线', 6), pad('plane', 7), pad('诊断', 6), pad('幂等', 6), '错误');
for (const r of rows) {
  console.log(
    pad(r.file, 14),
    pad(r.nodes, 6),
    pad(r.flows, 6),
    pad(r.planes, 7),
    pad(r.diags, 6),
    pad(r.idempotent === null ? '-' : r.idempotent ? 'yes' : 'NO', 6),
    r.err ?? '',
  );
}

const crashed = rows.filter((r) => r.err);
const notIdem = rows.filter((r) => !r.err && r.idempotent === false);
const total = rows.length;
console.log(
  `\n合计 ${total} 份：导入成功 ${total - crashed.length}、` +
    `二次导出幂等 ${total - crashed.length - notIdem.length}；崩溃 ${crashed.length}、不幂等 ${notIdem.length}`,
);
if (crashed.length) {
  console.log('\n崩溃明细：');
  for (const r of crashed) console.log(` - ${r.file}: ${r.err}`);
  process.exit(1);
}
if (notIdem.length) {
  console.log('\n不幂等明细：');
  for (const r of notIdem) console.log(` - ${r.file}`);
  process.exit(1);
}
console.log('FR-S15 实证通过：真实语料导入不崩、二次导出幂等');
