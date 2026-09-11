# tests/fixtures/douban — 合成 fixture 声明

本目录所有文件均为**合成内容**（按 `docs/decisions/0006-douban-provider.md`
文档化的结构锚点手写），**不是**对豆瓣的真实抓取或镜像：

- `subject-suggest.json`：subject_suggest 端点的形状样本（JSON 数组无法
  内嵌注释，故以本文件为该文件的合成声明）；
- `subject-detail.html` / `subject-detail-tv.html`：条目页 JSON-LD 骨架，
  文件内有 HTML 注释声明。

用途：`tests/main/plugins/douban-contract.test.ts` 用锚点校验器离线检测
上游结构变化。豆瓣改版时更新这些文件，锚点不匹配会大声失败。
