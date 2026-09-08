# 自编译 mpv 0.32.0（Deepin 10 / Debian buster）

系统自带的 mpv 0.29 过旧。所有新版预编译二进制（官方静态构建、AppImage、Debian bullseye+ 的 deb）都要求比 glibc 2.28 更新的系统，**唯一出路是源码编译**。本文记录完整过程。

## 产物

| 组件 | 版本 | 位置 |
|---|---|---|
| mpv | 0.32.0 | `~/.local/bin/mpv` |
| ffmpeg | 5.1.9 (libavcodec 59.37) | `~/.local/lib` |
| libass | 0.17.3 | `~/.local/lib` |
| LuaJIT | 2.1 (openresty fork) | `~/.local/lib` |
| epoxy / fribidi / harfbuzz / libXss / libXrandr / libXinerama / libXpresent* | 1.5.10 / 1.0.8 / 2.7.4 / 1.2.3 / 1.5.2 / 1.1.4 / - | `~/.local` |

\* xpresent 最终未编译，改为 patch mpv 的 meson.build（0.35 未用上，0.32 不需要）。

## 约束

- 无 sudo：所有依赖编译到 `~/.local`（`--prefix=$HOME/.local`）
- gcc 8.3 / glibc 2.28 / python 3.7
- 网络受限：GitHub / waf.io / ffmpeg.org 不可达；**阿里云 Debian/Ubuntu pool 镜像可用**

## 依赖树（谁需要谁）

```
mpv 0.32 (waf 构建)
├── ffmpeg 5.1.9      ← nasm, zlib(系统)
├── libass 0.17.3     ← fribidi, harfbuzz, fontconfig(系统), freetype(系统)
├── LuaJIT 2.1        ← （无外部依赖）
├── epoxy 1.5.10      ← GL 头(系统) + 补齐的 GLX/KHR 头
├── libXss/libXrandr/libXinerama  ← X11(系统)
└── vo_gpu 需要 GL/glx.h + KHR/khrplatform.h（系统头不完整，从 libglvnd tarball 提取）
```

## 源码下载（全部来自 mirrors.aliyun.com/debian/pool/main/）

```bash
P="http://mirrors.aliyun.com/debian/pool/main"
curl -O "$P/n/nasm/nasm_2.16.03.orig.tar.xz"
curl -O "$P/f/fribidi/fribidi_1.0.8.orig.tar.bz2"
curl -O "$P/h/harfbuzz/harfbuzz_2.7.4.orig.tar.xz"
curl -O "$P/liba/libass/libass_0.17.3.orig.tar.xz"
curl -O "$P/l/luajit/luajit_2.1.0%2Bopenresty20250117.orig.tar.xz"
curl -O "$P/f/ffmpeg/ffmpeg_5.1.9.orig.tar.xz"
curl -O "$P/m/mpv/mpv_0.32.0.orig.tar.gz"
curl -O "$P/m/meson/meson_1.0.1.orig.tar.gz"        # 纯 python，无需安装
curl -O "$P/n/ninja-build/ninja-build_1.10.1-1_amd64.deb"  # dpkg -x 提取二进制
curl -O "$P/libe/libepoxy/libepoxy_1.5.10.orig.tar.gz"
curl -O "$P/libx/libxss/libxss_1.2.3.orig.tar.gz"
curl -O "$P/libx/libxrandr/libxrandr_1.5.2.orig.tar.gz"
curl -O "$P/libx/libxinerama/libxinerama_1.1.4.orig.tar.gz"
curl -O "$P/libg/libglvnd/libglvnd_1.3.2.orig.tar.gz"  # 提供 GL/glx.h + KHR/khrplatform.h
```

## 构建

环境（`~/build/env.sh`）：

```bash
export PREFIX=$HOME/.local
export PATH=$PREFIX/bin:$PATH
export PKG_CONFIG_PATH=$PREFIX/lib/pkgconfig:$PREFIX/lib/x86_64-linux-gnu/pkgconfig:$PKG_CONFIG_PATH
export LD_LIBRARY_PATH=$PREFIX/lib:$PREFIX/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH
export CPATH=$PREFIX/include:$CPATH
export MESON="python3 $HOME/build/src/meson-1.0.1/meson.py"
export NINJA=$PREFIX/bin/ninja
```

### 1. meson + ninja（基础设施）

```bash
dpkg -x ninja-build_*.deb ninja-extract
cp ninja-extract/usr/bin/ninja ~/.local/bin/
# meson 直接用 python3 ~/build/src/meson-1.0.1/meson.py 调用
```

### 2. nasm（ffmpeg 需要）

```bash
./configure --prefix=$PREFIX && make -j12 && make install
```

### 3. epoxy（GL 加载器）

```bash
$MESON setup build --prefix=$PREFIX --libdir=lib -Dglx=yes -Degl=no -Dx11=true -Dtests=false
$NINJA -C build -j12 && $NINJA -C build install
```

### 4. fribidi / harfbuzz / libass（meson，注意各包选项类型不同）

```bash
# fribidi
$MESON setup build --prefix=$PREFIX --libdir=lib -Ddocs=false
# harfbuzz
$MESON setup build --prefix=$PREFIX --libdir=lib -Dtests=disabled -Ddocs=disabled -Dbenchmark=disabled -Dintrospection=disabled
# libass（harfbuzz/fribidi 是 0.17 的强制依赖，无选项；test 是 boolean、asm 是 feature 类型）
$MESON setup build --prefix=$PREFIX --libdir=lib -Dtest=false -Dfontconfig=enabled -Dasm=disabled
```

### 5. LuaJIT

```bash
make -j1 && make install PREFIX=$PREFIX
```

### 6. GL 头补齐（关键坑：系统缺 GL/glx.h 和 KHR/khrplatform.h）

```bash
cp libglvnd-1.3.2/include/GL/*.h ~/.local/include/GL/
mkdir -p ~/.local/include/KHR && cp libglvnd-1.3.2/include/KHR/khrplatform.h ~/.local/include/KHR/
ln -sf /usr/lib/x86_64-linux-gnu/libGL.so.1 ~/.local/lib/libGL.so   # 链接 shim
```

`~/.local/lib/pkgconfig/gl.pc`（手写 shim，Version 1.7.0）：

```
prefix=$HOME/.local
includedir=/usr/include
libdir=$HOME/.local/lib
Name: gl
Version: 1.7.0
Libs: -L$libdir -lGL
Cflags: -I/usr/include
```

### 7. ffmpeg 5.1.9

```bash
./configure --prefix=$PREFIX \
  --enable-shared --disable-static \
  --disable-programs --disable-doc --disable-debug \
  --disable-autodetect --enable-zlib --enable-iconv \
  --disable-alsa --disable-sndio
make -j12 && make install
```

`--disable-autodetect` 很重要：否则会探测一堆缺失的外部库报错。无 TLS 库 → https 不可用（局域网 http 无影响）。

### 8. mpv 0.32（waf 构建的 waf 获取是最大坑）

**waf 获取**：waf.io / gitlab archive（需登录）/ pypi / Debian pool（只有 1.5.x）全部不可用。
**可行方案**：从 Debian pool 的 **lv2_1.18.2 源码包**提取 bundled waf 2.0.21：

```bash
curl -O "$P/l/lv2/lv2_1.18.2.orig.tar.bz2"
tar xf lv2_1.18.2.orig.tar.bz2
# lv2-1.18.2/waf 是最小启动脚本 + lv2-1.18.2/waflib 是库本体
cp -r lv2-1.18.2/waflib mpv-0.32.0/
cp lv2-1.18.2/waf mpv-0.32.0/
```

（该 waf 是 "Minimal waf script"，要求 waflib 直接位于项目目录。）

```bash
python3 waf configure --prefix=$PREFIX \
  --disable-libmpv-shared --disable-libmpv-static \
  --lua=luajit --disable-javascript \
  --disable-uchardet --disable-libarchive --disable-libbluray --disable-dvdnav --disable-cdda --disable-dvbin \
  --disable-vulkan --disable-shaderc \
  --disable-egl --disable-wayland --disable-drm --disable-gbm \
  --disable-vaapi --disable-vdpau \
  --disable-jack --disable-pulse --disable-sdl2 --disable-openal \
  --disable-zimg --disable-rubberband \
  --disable-manpage-build --disable-html-build --disable-cplugins
python3 waf build -j12 && python3 waf install
```

## 接入应用

`src/main/modules/player-core/mpv-process.ts`：
- 二进制查找：`~/.local/bin/mpv` 优先，fallback 系统 `mpv`
- spawn env 注入 `LD_LIBRARY_PATH=~/.local/lib`（编译时无 rpath）

## 版本注意

- mpv 0.32 的 OSC **不支持** `osc-mouseseek`（0.34+ 才有），`osc-seekrangealpha` 支持
- mpv 0.35.1 需要 libplacebo（vo_gpu 强制），libplacebo 需要 glslang/spirv-tools 链条，gcc 8.3 下风险高，故选 0.32
- mpv 0.32 的 JSON IPC 与本项目 player-core 完全兼容（loadfile 字符串 options 仍支持）

## 如需卸载

```bash
rm -rf ~/.local/bin/{mpv,nasm,ninja} ~/.local/lib/{libav*,libsw*,libass*,libluajit*,libXss*,libXrandr*,libXinerama*,libepoxy*,libfribidi*,libharfbuzz*} ~/.local/include/{GL,KHR} ~/.local/share/{man,doc} 2>/dev/null
```
