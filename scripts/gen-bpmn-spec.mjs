#!/usr/bin/env node
/**
 * gen-bpmn-spec.mjs — S0：生成 floken-moddle 的 BPMN 2.0 类型表。
 *
 * 一次性脚本，**不进 dependencies**（生成的产物是我们自己的数据文件）。
 * 源有两个，各司其职：
 *   ① bpmn-moddle 的描述符 JSON（MIT）—— 提供类型全集与属性明细（137/318）。
 *   ② OMG Semantic.xsd 原件 —— 提供 `abstract` 的权威判定，并①做交叉校验。
 *
 * 为什么需要 XSD：描述符里的 `isAbstract` 不完整（119 个类型根本没这个字段），
 * 且 OMG 的 abstract 有时挂在 `<xsd:element>` 而不是 `<xsd:complexType>` 上
 * （`tGateway` 就是这么丢的）。只信一边都会算错 —— 本项目上一次就把
 * 可执行节点数算成 25（把 SubProcess 误判成抽象），正确是 26。
 *
 * 用法：
 *   node scripts/gen-bpmn-spec.mjs [--src <描述符目录>] [--xsd <Semantic.xsd>] [--out <目录>] [--check]
 *   --check 只做交叉校验、不写文件（CI 可用来钉死 toeset）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const WS = resolve(PKG, '../..');

/* ─────────────────────────── CLI ─────────────────────────── */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const SRC = arg('src', join(WS, '.workbuddy/_bpmn-sandbox/node_modules/bpmn-moddle/resources/bpmn/json'));
const XSD = arg('xsd', join(WS, '.workbuddy/tmp/Semantic.xsd'));
const OUT = arg('out', join(PKG, 'src/spec'));
const CHECK_ONLY = argv.includes('--check');

/* ─────────────────── ① 描述符：类型全集与属性 ─────────────────── */
/** 四个描述符，顺序即输出顺序。NS 与 uRI 写死 —— OMG 发布后不可改。 */
const DESCRIPTORS = [
  { file: 'bpmn.json', prefix: 'bpmn', ns: 'semantic', uri: 'http://www.omg.org/spec/BPMN/20100524/MODEL' },
  { file: 'bpmndi.json', prefix: 'bpmndi', ns: 'di', uri: 'http://www.omg.org/spec/BPMN/20100524/DI' },
  { file: 'di.json', prefix: 'di', ns: 'di', uri: 'http://www.omg.org/spec/DD/20100524/DI' },
  { file: 'dc.json', prefix: 'dc', ns: 'dc', uri: 'http://www.omg.org/spec/DD/20100524/DC' },
];

const loadDescriptor = (file) =>
  JSON.parse(readFileSync(join(SRC, file), 'utf8'));

/* ─────────────── ② XSD：abstract 的权威判定 ─────────────── */
/**
 * 权威抽象 = complexType@abstract  ∪  对应全局 element@abstract。
 * 只取 complexType 会漏掉 tGateway（OMG 把 abstract 写到了 element 上）。
 */
function readAbstractFromXsd(xsdPath) {
  const raw = readFileSync(xsdPath, 'utf8');
  const abs = new Set();
  let ctCount = 0;

  // complexType name="tXxx" ... abstract="true"
  const ctRe = /<xsd:complexType\b([^>]*)>/g;
  for (let m; (m = ctRe.exec(raw)); ) {
    const attrs = m[1];
    const name = /name="(t[A-Za-z0-9]+)"/.exec(attrs)?.[1];
    if (!name) continue;
    ctCount += 1;
    if (/abstract="true"/.test(attrs)) abs.add(name);
  }

  // element name="xxx" type="tXxx" ... abstract="true"
  const elRe = /<xsd:element\b([^>]*?)\/>/g;
  const elFromType = new Map();
  for (let m; (m = elRe.exec(raw)); ) {
    const attrs = m[1];
    const type = /type="(t[A-Za-z0-9]+)"/.exec(attrs)?.[1];
    const name = /name="([A-Za-z0-9]+)"/.exec(attrs)?.[1];
    if (!type || !name) continue;
    if (/abstract="true"/.test(attrs)) {
      abs.add(type);
      elFromType.set(type, name);
    }
  }
  return { abs, ctCount, elFromType };
}

/* ─────────────── ③ abstract 裁定规则（留痕） ─────────────── */
/**
 * 描述符标 True，但 XSD 侧没有 abstract 依据 —— 仍判 True，理由写死在这里：
 *   FlowElementsContainer / InteractionNode : XSD 里**没有**这两个 complexType，
 *       它们是描述符为了复用而引入的中间类型，永远不会出现在 XML 里。
 *   CallableElement : XSD 的 tCallableElement 与 <element callableElement> 都没标 abstract，
 *       这是 OMG 的一处疏漏 —— Process / GlobalTask 才是可实例化的子类，
 *       实践中所有工具链都按抽象处理。描述符口径正确。
 */
const DESC_ONLY_ABSTRACT = Object.freeze({
  FlowElementsContainer: 'XSD 无此 complexType（描述符层的复用中间类型）',
  InteractionNode: 'XSD 无此 complexType（描述符层的复用中间类型）',
  CallableElement: 'OMG 未在 tCallableElement / <element callableElement> 标 abstract，属规范疏漏',
});

/* ─────────────────────────── 主流程 ─────────────────────────── */
const xsd = readAbstractFromXsd(XSD);
const toXsdName = (n) => `t${n.charAt(0).toUpperCase()}${n.slice(1)}`;

const groups = [];
const audit = { xsdComplexTypes: xsd.ctCount, xsdAbstract: xsd.abs.size, conflicts: [], accepted: [] };

for (const desc of DESCRIPTORS) {
  const json = loadDescriptor(desc.file);
  const types = json.types ?? [];
  const specs = [];

  for (const t of types) {
    const superClass = t.superClass
      ? (Array.isArray(t.superClass) ? t.superClass : [t.superClass])
      : [];

    // ── abstract 裁定 ──
    let isAbstract = t.isAbstract === true;
    const xsdName = toXsdName(t.name);
    const xsdAbstract = xsd.abs.has(xsdName);
    const existsInXsd = new RegExp(`<xsd:complexType\\s+name="${xsdName}"`).test(
      readFileSync(XSD, 'utf8'),
    );
    if (xsdAbstract && !isAbstract) {
      // XSD 说抽象、描述符没标 → 描述符漏了，以 XSD 为准。
      // 目前集合中不存在这种情况；一旦出现会在此处炸掉，防止静默升级错位。
      audit.conflicts.push(`${desc.prefix}:${t.name}（XSD 抽象，描述符未标）`);
      isAbstract = true;
    }
    if (existsInXsd && xsdAbstract === false && isAbstract) {
      const reason = DESC_ONLY_ABSTRACT[t.name];
      if (!reason) audit.conflicts.push(`${desc.prefix}:${t.name}（描述符抽象，XSD 未标，且无登记理由）`);
      else audit.accepted.push(`${t.name}：${reason}`);
    }

    specs.push({
      name: t.name,
      ns: desc.prefix,
      superClass,
      isAbstract,
      existsInXsd,
      properties: (t.properties ?? []).map(normProperty),
    });
  }

  groups.push({ ...desc, specs, enumerations: json.enumerations ?? [] });
}

function normProperty(p) {
  const out = { name: p.name, type: p.type };
  for (const flag of ['isAttr', 'isMany', 'isReference', 'isVirtual', 'isReadOnly', 'isId', 'isBody', 'isUnique']) {
    if (p[flag] === true) out[flag] = true;
  }
  if (p.default !== undefined) out.default = p.default;
  if (p.xml) out.xml = p.xml;
  if (p.redefines) out.redefines = p.redefines;
  if (p.replaces) out.replaces = p.replaces;
  if (p.subsettedProperty) out.subsettedProperty = p.subsettedProperty;
  return out;
}

/* ─────────────────────────── 报告 ─────────────────────────── */
const semantic = groups[0].specs;
const graphic = groups.slice(1).flatMap((g) => g.specs);
const countProps = (specs) => specs.reduce((n, s) => n + s.properties.length, 0);

const stats = {
  semanticTypes: semantic.length,
  semanticProperties: countProps(semantic),
  semanticAbstract: semantic.filter((s) => s.isAbstract).length,
  graphicTypes: graphic.length,
  graphicProperties: countProps(graphic),
  totalTypes: groups.reduce((n, g) => n + g.specs.length, 0),
  enumerations: groups.reduce((n, g) => n + g.enumerations.length, 0),
};

console.log('── S0 生成报告 ─────────────────────────────');
console.log(`XSD complexType=${audit.xsdComplexTypes}  权威 abstract=${audit.xsdAbstract}`);
for (const g of groups) {
  console.log(`  ${g.file.padEnd(12)} ns=${g.prefix.padEnd(7)} types=${String(g.specs.length).padStart(3)} props=${String(countProps(g.specs)).padStart(3)} enums=${g.enumerations.length}`);
}
console.log(`  → 语义层 ${stats.semanticTypes} 类型 / ${stats.semanticProperties} 属性（抽象 ${stats.semanticAbstract}）`);
console.log(`  → 图形层 ${stats.graphicTypes} 类型 / ${stats.graphicProperties} 属性`);
console.log(`  → 描述符合计 ${stats.totalTypes} 类型`);
console.log('── abstract 裁定 ───────────────────────────');
console.log(`  XSD 权威 ${audit.xsdAbstract} 个；描述符 True ${semantic.filter((s) => s.isAbstract).length} 个`);
for (const line of audit.accepted) console.log(`  接受 [描述符口径] ${line}`);
for (const line of audit.conflicts) console.log(`  ✗ 冲突 ${line}`);
const subProcess = semantic.find((s) => s.name === 'SubProcess');
console.log(`  SubProcess.isAbstract = ${subProcess?.isAbstract}（false 才是 26 类可执行节点的依据）`);

if (audit.conflicts.length > 0) {
  console.error('\n✗ abstract 交叉校验出现未登记冲突，拒绝生成。请更新 DESC_ONLY_ABSTRACT 并写明理由。');
  process.exit(1);
}
if (stats.semanticTypes !== 137 || stats.semanticProperties !== 318) {
  console.error(`\n✗ 规模与契约不符：期望 137/318，实测 ${stats.semanticTypes}/${stats.semanticProperties}`);
  process.exit(1);
}
if (CHECK_ONLY) {
  console.log('\n✓ --check 通过，未写文件。');
  process.exit(0);
}
/* ─────────────────────────── 产物生成 ─────────────────────────── */
const tsStr = (v) => JSON.stringify(v);
const PROP_FLAGS = ['isAttr', 'isMany', 'isReference', 'isVirtual', 'isReadOnly', 'isId', 'isBody', 'isUnique'];

const banner = (title, extraLines) => {
  const lines = [
    '/**',
    ` * ${title}`,
    ' *',
    ' * ⚠️ **自动生成，请勿手改** —— 改了也会被下一次 gen:spec 覆盖。',
    ' *   要改就改 scripts/gen-bpmn-spec.mjs。',
    ' *',
    ' * 源文件（生成期依赖，MIT，不进 dependencies）：bpmn-moddle 的描述符 JSON。',
    ' * abstract 校正源：OMG Semantic.xsd 原件（complexType@abstract ∪ element@abstract）。',
  ];
  for (const line of extraLines ?? []) lines.push(line === '' ? ' *' : line);
  lines.push(' * @see 流程引擎包文档/01-包需求-floken-moddle.md §3');
  lines.push(' */');
  return lines.join('\n');
};

const renderProp = (p, indent) => {
  const parts = ['name: ' + tsStr(p.name), 'type: ' + tsStr(p.type)];
  for (const flag of PROP_FLAGS) if (p[flag]) parts.push(flag + ': true');
  if (p.default !== undefined) parts.push('default: ' + tsStr(p.default));
  if (p.xml) parts.push('xml: ' + tsStr(p.xml));
  if (p.redefines) parts.push('redefines: ' + tsStr(p.redefines));
  if (p.replaces) parts.push('replaces: ' + tsStr(p.replaces));
  if (p.subsettedProperty) parts.push('subsettedProperty: ' + tsStr(p.subsettedProperty));
  return indent + '{ ' + parts.join(', ') + ' }';
};

const renderType = (s, indent) => {
  const head = ['name: ' + tsStr(s.name), 'ns: ' + tsStr(s.ns)];
  if (s.superClass.length) head.push('superClass: ' + tsStr(s.superClass));
  if (s.isAbstract) head.push('isAbstract: true');
  if (!s.existsInXsd) head.push('existsInXsd: false');
  if (s.properties.length === 0) {
    return indent + '{ ' + head.join(', ') + ', properties: EMPTY_PROPERTIES }';
  }
  const lines = [indent + '{ ' + head.join(', ') + ','];
  lines.push(indent + '  properties: [');
  const inner = s.properties.map((p) => renderProp(p, indent + '    '));
  inner.forEach((line, i) => lines.push(line + (i < inner.length - 1 ? ',' : '')));
  lines.push(indent + '  ],');
  lines.push(indent + '}');
  return lines.join('\n');
};

/** @param opts.exported 是否带 `export`（分组常量不导出，只导出 DI_TYPES 与 DI_TYPE_GROUPS） */
const renderGroup = (constName, specs, nsDoc, opts = {}) => {
  const lines = ['/** ' + nsDoc + ' */'];
  lines.push((opts.exported === false ? '' : 'export ') + 'const ' + constName + ': readonly BpmnTypeSpec[] = [');
  const items = specs.map((s) => renderType(s, '  '));
  items.forEach((t, i) => lines.push(t + (i < items.length - 1 ? ',' : '')));
  lines.push('];');
  return lines.join('\n') + '\n';
};

const IMPORT_LINE = "import type { BpmnTypeSpec, PropertySpec } from './spec-types.js';\n";
const EMPTY_PROPS_DECL = [
  '/** 复用同一个冻结空数组，避免每个无属性类型各建一份 */',
  'const EMPTY_PROPERTIES: readonly PropertySpec[] = Object.freeze([]);',
  '',
].join('\n');

mkdirSync(OUT, { recursive: true });

/* — 语义层（137 / 318） — */
const abstractNames = semantic.filter((s) => s.isAbstract).map((s) => s.name);
const semanticLines = [
  banner('BPMN 2.0 语义层类型表 —— 137 类型 / 318 属性定义（自动生成）', [
    '',
    ' * abstract 裁定：描述符标 True 的 17 个照单全收；其中 FlowElementsContainer /',
    ' * InteractionNode / CallableElement 在 XSD 侧拿不到 abstract 依据，仍取 True ——',
    ' * 理由登记在 scripts/gen-bpmn-spec.mjs 的 DESC_ONLY_ABSTRACT 里（前两个 XSD 压根',
    ' * 没有对应 complexType，第三个是 OMG 漏标）。',
    ' * ★ SubProcess **不是**抽象类型 —— 这是「26 类可执行节点」的依据。',
  ]),
  '',
  IMPORT_LINE,
  EMPTY_PROPS_DECL,
  renderGroup('BPMN_TYPES', semantic, 'BPMN 语义层：http://www.omg.org/spec/BPMN/20100524/MODEL'),
  '/** 语义层中的抽象类型（' + abstractNames.length + ' 个）：不可实例化，只作为 superClass 存在 */',
  'export const BPMN_ABSTRACT_TYPES: readonly string[] = Object.freeze([',
  abstractNames.map((n) => '  ' + tsStr(n) + ',').join('\n'),
  ']);',
  '',
];
writeFileSync(join(OUT, 'bpmn.generated.ts'), semanticLines.join('\n'), 'utf8');

/* — 图形交换层（bpmndi 6 + di 11 + dc 7 = 24） — */
const graphicGroups = groups.slice(1);
const graphicLines = [
  banner('BPMN 图形交换（DI）类型表 —— ' + stats.graphicTypes + ' 类型 / ' + stats.graphicProperties + ' 属性（自动生成）', [
    '',
    ' * 与语义层**分开记账**：对外口径「BPMN 137 类型 / 318 属性」**只算语义层**，',
    ' * 图形交换是另外的 ' + stats.graphicTypes + ' 类型。两者混报就会把 137 说成 161。',
  ]),
  '',
  IMPORT_LINE,
  EMPTY_PROPS_DECL,
];
// 分组常量用 _GROUP 后缀且**不导出** —— di 组若叫 DI_TYPES 会跟下面的合计常量撞名。
for (const g of graphicGroups) {
  graphicLines.push(renderGroup(g.prefix.toUpperCase() + '_GROUP', g.specs, g.prefix + '：' + g.uri, { exported: false }));
}
graphicLines.push('');
graphicLines.push('/** 图形交换层合计（bpmndi + di + dc） */');
graphicLines.push('export const DI_TYPES: readonly BpmnTypeSpec[] = [');
for (const g of graphicGroups) graphicLines.push('  ...' + g.prefix.toUpperCase() + '_GROUP,');
graphicLines.push('];');
graphicLines.push('');
graphicLines.push('/** 按命名空间分组的图形类型，便于按 ns 单独取用 */');
graphicLines.push('export const DI_TYPE_GROUPS: Readonly<Record<string, readonly BpmnTypeSpec[]>> = Object.freeze({');
for (const g of graphicGroups) {
  graphicLines.push('  ' + tsStr(g.prefix) + ': ' + g.prefix.toUpperCase() + '_GROUP,');
}
graphicLines.push('});');
graphicLines.push('');
writeFileSync(join(OUT, 'di.generated.ts'), graphicLines.join('\n'), 'utf8');

/* — 枚举 — */
const enumLines = [banner('BPMN 2.0 枚举字面量（自动生成）', [
  '',
  ' * 描述符里共 ' + stats.enumerations + ' 个 enumeration，这里全部落盘。',
]), ''];
for (const g of groups) {
  for (const e of g.enumerations) {
    const constName = g.prefix.toUpperCase() + '_' + e.name;
    enumLines.push('/** ' + g.prefix + ':' + e.name + ' */');
    enumLines.push('export const ' + constName + ': readonly string[] = Object.freeze([');
    for (const v of e.literalValues ?? []) enumLines.push('  ' + tsStr(v.name) + ',');
    enumLines.push(']);');
    enumLines.push('');
  }
}
enumLines.push('/** 全部枚举，按 `<ns>:<name>` 索引 */');
enumLines.push('export const ENUMERATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({');
for (const g of groups) {
  for (const e of g.enumerations) {
    enumLines.push('  ' + tsStr(g.prefix + ':' + e.name) + ': ' + g.prefix.toUpperCase() + '_' + e.name + ',');
  }
}
enumLines.push('});');
enumLines.push('');
writeFileSync(join(OUT, 'enums.generated.ts'), enumLines.join('\n'), 'utf8');

console.log('');
console.log('✓ 已生成：');
console.log('  ' + join(OUT, 'bpmn.generated.ts'));
console.log('  ' + join(OUT, 'di.generated.ts'));
console.log('  ' + join(OUT, 'enums.generated.ts'));
console.log(
  '\n规模：语义 ' + stats.semanticTypes + '/' + stats.semanticProperties +
  '，图形 ' + stats.graphicTypes + '/' + stats.graphicProperties +
  '，枚举 ' + stats.enumerations,
);
