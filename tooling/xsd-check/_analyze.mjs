/* 临时分析：把 XSD 违规按类型聚合，判断修哪些 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WS = 'D:/XT/Desktop/学习中/流程引擎开发';
const XSD = join(WS, '.workbuddy/xsd');
const MIWG = join(WS, '.workbuddy/miwg');
const OUT = join(WS, '.workbuddy/xsd-out');

const { toXmlSync, fromXmlSync } = await import(
  'file:///D:/XT/Desktop/学习中/流程引擎开发/项目文件/floken-moddle/dist/index.js'
);

const files = [];
if (existsSync(MIWG)) {
  for (const f of readdirSync(MIWG).filter((x) => x.endsWith('.bpmn')).sort()) {
    files.push({ p: join(MIWG, f), tag: 'origin' });
    files.push({ p: join(OUT, `miwg-${f}`), tag: 'roundtrip' });
  }
}

const per = new Map();
for (let i = 0; i < files.length; i += 20) {
  const b = files.slice(i, i + 20);
  const out = execFileSync(
    'java',
    ['D:/XT/Desktop/学习中/流程引擎开发/项目文件/floken-moddle/tooling/xsd-check/XsdCheck.java', XSD, ...b.map((x) => x.p)],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  for (const line of out.split('\n')) {
    const [k, ...r] = line.split('\t');
    if (k === 'FILE') per.set(r[0], { n: +r[1], e: [] });
    else if (k === 'ERR') per.get(r[0])?.e.push(r.slice(1).join('\t'));
  }
}

const buckets = new Map();
let originBad = 0;
let rtBad = 0;
for (const f of files) {
  const r = per.get(f.p);
  if (!r || r.n === 0) continue;
  if (f.tag === 'origin') originBad++;
  else rtBad++;
  for (const e of r.e) {
    // 抽取特征：违规码 + 出现问题的元素/属性名
    const code = (e.match(/cvc-[a-z0-9.\-]+/) ?? ['?'])[0];
    let key = code;
    const elem = e.match(/元素 '([^']+)'/)?.[1] ?? e.match(/属性 '([^']+)'/)?.[1] ?? '';
    key += ' :: ' + elem;
    const b = buckets.get(key) ?? { key, n: 0, origin: 0, rt: 0, sample: e };
    b.n++;
    if (f.tag === 'origin') b.origin++;
    else b.rt++;
    buckets.set(key, b);
  }
}
console.log(`语料原文件违规 ${originBad} 份 / 转一圈违规 ${rtBad} 份\n`);
const rows = [...buckets.values()].sort((a, b) => b.n - a.n);
for (const b of rows) {
  console.log(`${String(b.n).padStart(4)}  原${String(b.origin).padStart(3)} 转${String(b.rt).padStart(3)}  ${b.key}`);
  console.log(`        ${b.sample.slice(0, 160)}`);
}
console.log('\n总计违规', rows.reduce((s, b) => s + b.n, 0));
