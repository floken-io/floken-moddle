# Changelog

本包遵循 [Semantic Versioning](https://semver.org/)，格式参考 [Keep a Changelog](https://keepachangelog.com/)。
0.x 阶段跨包依赖写 `>=x.y.z <1.0.0`（不用 `^`）。

## 0.0.3 — 2026-09-27

### 修正

- `files` 白名单补 `CHANGELOG.md`（0.0.2 漏了，导致本文件没进 tarball）。

## 0.0.2 — 2026-09-27

### 文档

- README 补成对外文档：安装、最小可用示例（解析 / 校验 / 导出 / 坐标 DI）、
  BPMN 覆盖度口径、导入导出行为约定、`includeExtensions` 与扩展保留说明。
- 去掉包内已不实的表述（本包不是占位骨架）。

## 0.0.1 — 2026-09-27

首个发布版本。

### 完成

- **BPMN 2.0 元模型**：137 个类型 / 318 个属性；可执行元素覆盖按 48 类登记
  （35 类一等字段兑现 + 13 类按原始 XML 保全，往返不丢）。
- **XML ↔ JSON 双向转换**：读写全自研（不依赖第三方 XML 库），默认拒绝 XXE；
  导出顺序按官方 XSD `sequence`，不是排版偏好。
- **DI / 坐标**：一图一 plane，导入遍历全部 `BPMNDiagram`，缺失时 `autoLayout()` 补。
- **校验**：结构、引用、id（NCName）、布局四类诊断，按错误契约返回诊断而非抛错。
- **实测门禁**：52 份文件过官方 OMG XSD（JDK JAXP，零第三方）零违规；
  MIWG 语料 22/22 导入且往返守恒幂等；与 Camunda 7 Java 模型互操作；
  bpmn-visualization 真实画布渲染。
- 运行时依赖只有 `zod`。
