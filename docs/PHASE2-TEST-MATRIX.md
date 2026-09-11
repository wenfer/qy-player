# 二期测试矩阵（PHASE2-TEST-MATRIX）

状态标注：`[机]` 机器已验证（自动化）；`[人]` 待目标机/人工验证。
回归范围 QYP2-001～038；门禁命令全绿为发布前提。

## 1. 自动化门禁（全绿）

| 门禁 | 结果 |
|---|---|
| `npm test -- --run` | 610 tests / 48 files 全绿 |
| `npm run typecheck` | 0 错误 |
| `npm run build:main` / `build:preload` / `build:renderer` | 通过 |
| `npm run dist:all` | 容器内产出 AppImage/deb/tar.gz/tar.xz；rpm/pacman 需 `rpmbuild`/`bsdtar`（容器缺失，CI 环境补齐）`[人]` |
| `git diff --check` | 干净 |
| `npm run lint` | eslint 未随依赖安装（`sh: eslint: not found`）——本地补装或 CI 复跑 `[人]` |

## 2. 硬约束核验（Checkpoint F 五项）

| 约束 | 位置 | 状态 |
|---|---|---|
| Electron 21.4.4 | `package.json` electron ^21.4.4 | `[机]` |
| `--hwdec=no` | `player-core/mpv-process.ts` | `[机]` |
| mpv stdout/stderr drain | 同上（空 data 监听） | `[机]` |
| `time-pos: null` 不归零 | `player-core/index.ts`（null 丢弃）+ 回归测试 | `[机]` |
| 关闭窗口 = 退出 | `main/index.ts` window-all-closed → quit | `[机]` |

## 3. 能力矩阵（来源 × 能力）

| 能力 | 本地 | WebDAV | Jellyfin | Emby |
|---|---|---|---|---|
| 浏览/详情 | `[机]` | `[机]` | `[机]` | `[机]` |
| 播放/续播 | `[机]`(resolver) | `[机]`(resolver) | `[机]` | `[机]` |
| 剧集一键续播 | `[机]`(renderer) | — | `[机]`(renderer) | `[人]` |
| 自动下一集 | `[机]`(main) | — | `[机]`(renderer) | `[人]` |
| 技术信息 probe | `[机]` | `[机]` | — | — |
| 字幕导入 | `[机]` | `[机]` | — | — |
| 安全删除 | `[机]` | `[机]`(412/confirm) | — | — |
| 刮削 | `[机]` | `[机]` | `[机]`(fixture) | `[人]` |
| 首页统一行 | `[机]` | `[机]` | `[机]` | `[人]` |

## 4. 待目标机手工矩阵（发布前必跑）

1. Deepin 20.9 / Debian 10 安装 deb/AppImage；启动、退出、托盘、快捷键。
2. mpv 0.29 与 0.32：真实播放、seek、probe 技术信息、字幕切换、
   短视频 EOF 自动下一集（倒计时/取消/设置关闭/最后一集）。
3. WebDAV 兼容矩阵：Nextcloud/Apache/NAS/Alist（连接、播放、seek probe、
   删除 412/确认、扫描）。
4. TMDB 真实 key 全链路：配置→单项→批量→确认→取消→恢复；密钥不泄漏
   （诊断摘要复查）。
5. 混合来源流程：local+WebDAV+Jellyfin+Emby 的继续观看/最近添加/搜索。
6. 1280×800 无横向滚动（刮削任务页/详情页/删除对话框）。

## 5. 未批准例外清单

- 无未批准的 suppression/`.skip`/stub（防篡改审查通过）。
- 各任务 Evidence 中的越界接线文件清单待人工追认（已逐条列出）。
- ADR-0006（豆瓣入口）待人工三方评审签认——签认前豆瓣保持不可启用。
