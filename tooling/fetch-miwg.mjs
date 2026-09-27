/**
 * 一次性抓取 **MIWG 互操作测试套件**的参考语料（FR-S15 的输入）。
 *
 * 语料落在**工作区级** `.workbuddy/miwg/`：
 * - 不进包内（不会打进 npm tarball、不进 git 包仓）；
 * - 不在 `os.tmpdir()`（沙箱里写 tmpdir 会被静默终止）。
 *
 * 用法：node tooling/fetch-miwg.mjs
 * 之后：node tooling/miwg.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const OUT = join(dirname(dirname(pkgRoot)), '.workbuddy/miwg');

const API = 'https://api.github.com/repos/bpmn-miwg/bpmn-miwg-test-suite/contents';
const HF = { Accept: 'application/vnd.github+json', 'User-Agent': '@floken/moddle' };

async function list(dir) {
  const r = await fetch(`${API}/${encodeURIComponent(dir)}?ref=master`, { headers: HF });
  if (!r.ok) throw new Error(`列目录失败 ${dir}: HTTP ${r.status}`);
  return r.json();
}

async function download(path) {
  const r = await fetch(`${API}/${path.split('/').map(encodeURIComponent).join('/')}?ref=master`, {
    headers: HF,
  });
  if (!r.ok) throw new Error(`下载失败 ${path}: HTTP ${r.status}`);
  const json = await r.json();
  if (json.encoding !== 'base64') throw new Error(`意外的编码：${path}`);
  return Buffer.from(json.content, 'base64').toString('utf8');
}

mkdirSync(OUT, { recursive: true });
const entries = await list('Reference');
const files = entries.filter((e) => e.type === 'file' && e.name.toLowerCase().endsWith('.bpmn'));
console.log(`Reference 目录共 ${files.length} 份 .bpmn`);

let n = 0;
for (const f of files) {
  const text = await download(f.path);
  const out = join(OUT, f.name);
  writeFileSync(out, text, 'utf8');
  n += 1;
  console.log(`  ✓ ${f.name} (${text.length} 字符)`);
}
console.log(`\n已写入 ${n} 份到 ${OUT}`);
