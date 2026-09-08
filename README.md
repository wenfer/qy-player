# QY Player

以 MPV 为内核的本地/在线混合媒体播放器，支持 Jellyfin/Emby 海报墙、外挂字幕、断点续播、多码率切换。

## 功能特性

- **MPV 播放内核**：独立窗口渲染，硬件解码（`--hwdec=auto`），原生 OSC 控制
- **Jellyfin/Emby 海报墙**：直接接入服务器元数据，无需本地刮削
- **本地文件播放**：打开文件/文件夹，自动匹配同目录字幕
- **智能字幕**：支持 SRT/ASS/SUB/VTT，自动语言识别，延迟微调
- **断点续播**：自动保存播放进度，下次点击直接续播
- **多码率切换**：在线播放支持原画/1080p/720p/480p
- **全局快捷键**：MediaPlayPause 等多媒体键支持
- **系统托盘**：关闭窗口最小化到托盘，不退出应用

## 系统要求

- Deepin 20.9 / Debian 10 / Ubuntu 20.04+ 或兼容系统
- MPV 播放器 (`apt install mpv`)
- libmpv1 (`apt install libmpv1`)

## 安装

### 从 .deb 包安装（推荐 Debian/Ubuntu/Deepin）

```bash
sudo dpkg -i qy-player_1.0.0_amd64.deb
sudo apt-get install -f  # 修复依赖
```

### 从 AppImage 运行（通用 Linux，无需安装）

```bash
chmod +x QY-Player-1.0.0-x86_64.AppImage
./QY-Player-1.0.0-x86_64.AppImage
```

### 从压缩包运行

```bash
tar -xzf qy-player-1.0.0.tar.gz
cd qy-player-1.0.0
./qy-player
```

### 从源码运行

```bash
git clone <仓库地址>
cd qy-player
npm install
npm run dev
```

## 打包

### 一键打包所有格式

```bash
npm run dist:all
# 输出: dist/ 目录下所有格式的安装包
```

### 单独打包各格式

```bash
# Debian/Ubuntu/Deepin (.deb)
npm run dist:deb

# RedHat/CentOS/Fedora/openSUSE (.rpm)
# 需先安装: sudo apt install rpm
npm run dist:rpm

# 通用 AppImage（无需安装，双击运行）
npm run dist:appimage

# Arch Linux (.pkg.tar.zst)
# 仅 Arch 系发行版可用
npm run dist:pacman

# 压缩包 (.tar.gz / .tar.xz)
npm run dist:tar
```

### 使用一键打包脚本

```bash
# 打包全部格式
node scripts/build-all.js

# 只打包 deb 和 AppImage
node scripts/build-all.js deb appimage

# 只打包 tar 压缩包
node scripts/build-all.js tar
```

### 国内网络加速

如遇到网络下载失败，配置镜像源：

```bash
# 临时设置环境变量
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run dist:all
```

## 使用说明

### 首次启动

1. 运行 `qy-player` 或点击桌面图标
2. 点击左侧「设置」→「添加服务器」
3. 填写 Jellyfin/Emby 服务器地址和账号
4. 点击「测试连接」验证，然后「保存」

### 播放本地视频

1. 点击左侧「本地」
2. 点击「打开文件」或「打开文件夹」
3. 同目录下的 `.srt/.ass` 字幕文件会自动加载

### 海报墙浏览

1. 点击左侧「首页」
2. 浏览「继续观看」「最近电影」「最近剧集」
3. 点击海报进入详情页，点击播放按钮开始播放
4. 在线视频播放前可选择分辨率

### 快捷键

| 快捷键 | 功能 |
|---|---|
| `MediaPlayPause` | 播放/暂停 |
| `MediaNextTrack` | 快进 30 秒 |
| `MediaPreviousTrack` | 后退 30 秒 |
| `Ctrl+Shift+Q` | 显示/隐藏窗口 |

## 技术栈

- Electron 21 + React 18 + TypeScript
- MPV JSON IPC（Unix Socket）
- Tailwind CSS + Zustand
- better-sqlite3

## 目录结构

```
src/
  main/           # Electron 主进程
    modules/
      player-core/      # MPV IPC 封装
      storage/          # SQLite 数据库
      playback-state/   # 进度管理
      subtitle-engine/  # 字幕引擎
      online-connector/ # Jellyfin/Emby API
      ui-shell/         # 托盘/快捷键
  preload/        # 安全桥梁
  renderer/       # React 前端
    components/     # PosterCard, PlayerControls, Navigation
    pages/          # Home, Detail, Settings, Search, Local
    stores/         # Zustand 状态管理
  shared/         # 类型定义 + IPC 通道常量
```

## 许可证

MIT
