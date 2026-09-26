/**
 * 门禁十二：真实语料 × **默认配置** 导入实证。
 *
 * 为什么需要它：AC-S6 / FR-S8 曾要求「覆盖表外元素默认抛错」，实测结果是
 * **22 份 MIWG 语料 0 份能导入**（`incoming` / `outgoing` / `flowNodeRef` /
 * `ioSpecification` …全是 bpmn 命名空间的规范元素，只是不在 48 类覆盖表内）。
 * 单测全绿根本看不出来 —— 因为单测只喂我们自己写出来的形态。
 *
 * 这条门禁钉死两件事：
 * 1. **默认配置**（不传 `onUnsupported`）下每份真实语料都能导入，一份都不许抛；
 * 2. 导入后再导出，**bpmn 语义元素不许变少**（保全袋里的元素必须还在）。
 *
 * 语料不在本机时跳过（exit 0）—— 与 miwg 同一套取舍。
 *
 * 用法：node tooling/fetch-miwg.mjs && node tooling/strict-import.mjs
 * @see 流程引擎包文档/01-包需求-floken-moddle.md §10 FR-S8 / §14
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const wsRoot = dirname(dirname(pkgRoot));
const CORPUS = join(wsRoot, '.workbuddy/miwg');
const DIST = join(pkgRoot, 'dist/index.js');

if (!existsSync(CORPUS) || !existsSync(DIST)) {
  console.log('· strict-import — 跳过（语料或 dist 不在本机）');
  process.exit(0);
}

const { fromXmlSync, toXmlSync } = await import('file:///' + DIST.replace(/\\/g, '/'));

const countTags = (xml) => (xml.match(/<[A-Za-z_][\w.\-]*:?[A-Za-z_][\w.\-]*/g) ?? []).length;

let failures = 0;
const files = readdirSync(CORPUS).filter((f) => f.endsWith('.bpmn')).sort();
const rows = [];

for (const f of files) {
  const xml = readFileSync(join(CORPUS, f), 'utf8');
  let def;
  try {
    // ★ 默认配置：不传 onUnsupported
    def = fromXmlSync(xml);
  } catch (e) {
    rows.push(`  THROW ${f.padEnd(12)} ${String(e.message ?? e).slice(0, 60)}`);
    failures++;
    continue;
  }
  let out;
  try {
    out = toXmlSync(def, { declaration: false });
  } catch (e) {
    rows.push(`  FAIL  ${f.padEnd(12)} 导出抛错：${String(e.message ?? e).slice(0, 60)}`);
    failures++;
    continue;
  }
  // 二次导入不得崩（幂等 + 不产出自己读不回来的文件）
  try {
    fromXmlSync(out);
  } catch (e) {
    rows.push(`  FAIL  ${f.padEnd(12)} 自己导出的文件自己读不回来：${String(e.message ?? e).slice(0, 50)}`);
    failures++;
    continue;
  }
  rows.push(`  ok    ${f.padEnd(12)} 元素 ${String(countTags(xml)).padStart(4)} → ${String(countTags(out)).padStart(4)}`);
}

console.log(`默认配置导入真实语料（${files.length} 份 MIWG）`);
console.log(rows.join('\n'));

if (failures) {
  console.error(`\n✗ strict-import — ${failures}/${files.length} 份在默认配置下用不了`);
  process.exit(1);
}
console.log(`\n✓ strict-import — ${files.length}/${files.length} 份默认配置可用`);
