/**
 * XML 域（M2）：命名空间、SAX 解析器、构造器、自有扩展值编解码、`toXml` / `fromXml`。
 *
 * 依赖方向与 `model/` 一致：**本域可以 import `core/` 与 `model/`，反过来不行**。
 */

export * from './namespaces.js';
export * from './sax.js';
export * from './writer.js';
export * from './value.js';
export * from './to-xml.js';
export * from './from-xml.js';
