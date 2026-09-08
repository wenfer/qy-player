# QY Player

**专为老版本 Linux 打造的桌面媒体播放器** —— 以 MPV 为内核，支持 Jellyfin / Emby 媒体库、本地文件播放、断点续播、观看历史。

## 为什么做这个项目

Deepin 20.9、Debian 10 (buster) 这类老系统的 glibc 只有 **2.28**：

- 现代版 Electron（22+）和新预编译二进制都要求更新的 glibc，装不上
- 系统自带的 mpv 0.29 过旧，而所有新版 mpv 二进制同样跑不起来

本项目把技术栈钉死在老系统的兼容线上：

| 组件 | 版本 | 原因 |
|---|---|---|
| Electron | **21.4.4** | 最后一个支持 glibc 2.28 的版本 |
| mpv | 0.29（系统）或 **0.32**（自编译，推荐） | 0.32 是老 gcc 8.3 / glibc 2.28 下可自行编译的最近版本，见 [docs/BUILD-MPV.md](docs/BUILD-MPV.md) |
| Node 构建 | 任意（仅开发机需要） | 打包产物不依赖开发机的 glibc |

在老机器上，它提供的是接近现代播放器的体验：海报墙、详情页、进度同步、观看历史，全部可用。

## 功能特性

- **Jellyfin / Emby 海报墙**：直接使用服务器元数据与海报，无需本地刮削
- **播放进度双向同步**：本地记录断点的同时，把进度回传服务器（`/Sessions/Playing/Progress`），网页端、手机端无缝续播
- **观看历史**：本地 SQLite 记录，剧集条目显示「剧集名 - S01E05 - 分集名」
- **直连优先，转码可选**：默认客户端直连软解（画质无损），卡顿时可在详情页一键切换服务端转码（8Mbps h264）
- **本地文件播放**：打开文件 / 文件夹，自动匹配同目录字幕
- **智能字幕**：SRT / ASS / SUB / VTT，文件名语言识别（chs / zh-cn / en / jpn…），延迟微调
- **系统托盘**：关闭窗口最小化到托盘
- **全局快捷键**：多媒体键控制播放

> 注：默认使用**软件解码**（`--hwdec=no`）。老机器的 VA-API/VDPAU 驱动播放在线流不稳定（典型表现为播放约 30 秒后画面冻结），软解更可靠；CPU 较强时画质与稳定性兼得。

## 安装

从 [GitHub Releases](https://github.com/wenfer/qy-player/releases) 下载对应格式：

```bash
# Debian / Ubuntu / Deepin（推荐，自动处理 mpv 等依赖）
sudo dpkg -i qy-player_*_amd64.deb
sudo apt-get install -f

# 通用 Linux（无需安装）
chmod +x QY-Player-*_x86_64.AppImage && ./QY-Player-*_x86_64.AppImage

# Fedora / CentOS / openSUSE
sudo rpm -i qy-player-*.x86_64.rpm

# Arch Linux
sudo pacman -U qy-player-*.pacman
```

系统依赖：`mpv`（deb/rpm/pacman 包会自动声明）。想要更好的字幕渲染和 OSC，可按 [docs/BUILD-MPV.md](docs/BUILD-MPV.md) 自编译 mpv 0.32 放到 `~/.local/bin/`，应用会自动优先使用它。

## 使用说明

1. 首次启动 → 「设置」→「添加服务器」→ 填写 Jellyfin/Emby 地址与账号 → 测试连接 → 保存
2. 「首页」浏览媒体库与继续观看；点海报进详情页，「立即播放」为直连，卡顿换「服务端转码播放」
3. 「本地」页播放本地文件；「历史」页查看/清理观看记录
4. 播放中点击其他内容可带进度切换

### 快捷键

| 快捷键 | 功能 |
|---|---|
| `MediaPlayPause` | 播放 / 暂停 |
| `MediaNextTrack` / `MediaPreviousTrack` | 快进 / 后退 30 秒 |
| `Ctrl+Shift+Q` | 显示 / 隐藏窗口 |
| `Ctrl+Shift+A` | 循环切换画面比例 |

## 开发

```bash
npm install
npm run dev        # 启动开发模式
npm run typecheck  # 类型检查
npm run dist:all   # 打包全部 Linux 格式
```

技术栈：Electron 21 + React 18 + TypeScript + Vite + Tailwind CSS + Zustand + better-sqlite3，MPV 通过 JSON IPC（Unix Socket）通信。

```
src/
  main/           # Electron 主进程
    modules/
      player-core/       # MPV 进程管理 + JSON IPC 封装
      storage/           # SQLite（进度/历史/服务器配置）
      playback-state/    # 进度保存、续播、服务器同步
      subtitle-engine/   # 字幕扫描与语言识别
      online-connector/  # Jellyfin/Emby REST 客户端
      ui-shell/          # 托盘 / 全局快捷键
  preload/        # contextBridge 安全桥梁
  renderer/       # React 前端（Home / Detail / Library / Search / Local / History / Settings）
  shared/         # IPC 通道常量 + 类型定义
```

## 发版

推送 tag 自动触发 GitHub Actions 打包并发布 Release：

```bash
git tag v1.0.x && git push origin v1.0.x
```

产物：AppImage / deb / rpm / pacman / tar.gz / tar.xz（x86_64）。

## 许可证

MIT
