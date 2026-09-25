# floken-moddle

BPMN 2.0 的机器可读版本 + floken 的 JSON 模型 + JSON\u2194XML 转换 + 校验。

> 这是从中国式流程引擎项目拆出的五个包之一。当前为**骨架占位**，实现见
> `流程引擎包文档/01-包需求-floken-moddle.md`。

## 定位

- 持有自有 BPMN 2.0 类型表（137 类型 / 318 属性）。
- `floken:approval` 中国式审批语义只住 `extension`，引擎原生识别。
- 零 DOM、零数据库、零 UI 框架；浏览器 / Node / SSR 同构。

## 开发

```bash
pnpm install
pnpm build      # tsup -> dist (ESM-only + .d.ts)
pnpm verify      # 六道发布门禁
```

## 依赖方向

两个「层」之一，与 `floken-feel` 互不依赖；被 `engine` / `designer` / `dmn` 消费。
