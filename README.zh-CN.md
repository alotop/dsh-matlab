# @alotop/dsh-matlab-bridge

在 [DSH](https://github.com/deepseek-ai) 会话里**运行和交互式单步调试** MATLAB 代码，底层是一个常驻的 MATLAB Engine 会话。

[![npm](https://img.shields.io/npm/v/@alotop/dsh-matlab-bridge.svg)](https://www.npmjs.com/package/@alotop/dsh-matlab-bridge)
[![license](https://img.shields.io/npm/l/@alotop/dsh-matlab-bridge.svg)](LICENSE)

[English](README.md)

---

## 为什么需要它

MATLAB 在 DSH 默认的 `workspace-write` 文件沙箱下**根本无法启动**。它在启动时会写工作区之外的位置（偏好设置、许可缓存），然后直接崩掉：

```
Fatal Startup Error: System error: File system inconsistency
```

把偏好目录重定向到可写位置**也没用**。所以用 shell 去驱动 `matlab -batch`，代价是**每一次调用都要一次沙箱提权**。

本插件改为通过非受限的 `ctx.subprocess` 通道启动驱动进程，这笔代价只需付一次——而且它保持一个 MATLAB Engine 会话存活，这正是一切调试能力的前提。

### 为什么必须常驻会话，而不是 `matlab -batch`

`matlab -batch` 每次调用都要**约 20 秒冷启动**，而且什么都不保留：变量、打开的图形、断点全部丢失。更关键的是它**无法单步调试**——断点命中时 MATLAB 自己的命令循环被阻塞，要发出 `dbstep` 必须有带外求值器，而官方 MATLAB Engine API 提供的正是这个。

```
DSH 会话 ──ctx.subprocess.spawn──▶ python ml_driver.py
                                    │ matlab.engine
                                    ▼
                          常驻、可调试的 MATLAB
```

## 环境要求

| | |
|---|---|
| MATLAB | R2020a 或更新（需要 `exportgraphics`）。任意标准安装即可，用的是它自带的 `extern/engines/python`。 |
| Python | 3.9 – 3.13，需在 `PATH` 上 |
| Node.js | 20 或更新 |

引擎自带的声明是支持 Python 3.9–3.12，但它附带的是**稳定 ABI（`abi3`）**扩展模块，实测在 3.13 上也能正常装载和运行。

## 安装

```sh
# 1. 把包装进你的 DSH profile
dsh plugin --profile <profile> add @alotop/dsh-matlab-bridge

# 2. 在「已安装的那份」里铺开 Engine 运行库
node "<profile>/node_modules/@alotop/dsh-matlab-bridge/scripts/setup-engine.mjs"

# 3. 重启 DSH，让新的 bundle 层被组装进去
```

第 2 步会从你**已经装好的** MATLAB 里复制引擎，并生成引擎定位原生库所需的 `_arch.txt`。不下载任何东西，也不再分发任何 MathWorks 代码——详见 [LICENSE](LICENSE)。

**第 2 步必须针对「已安装的那份」执行，不要跑仓库里的检出。** 脚本会写到它自己旁边的 `python/pylibs`，而插件是从自己的安装位置加载运行库的——铺到别处，已安装的那份仍然是空的。同一份安装也提供 `<profile>/node_modules/.bin/dsh-matlab-bridge-setup` 这个命令。

### 为什么要声明 `dsh.bundle`

`dsh plugin add` 只有在包的 `package.json` 声明了 `dsh.bundle` 时，才会把它记为 **profile layer**。本包把它指向 [`cordis.patch.yml`](cordis.patch.yml)，由后者插入 `matlab-bridge` 这一行。没有它，安装照样成功但**什么都不会注册**，DSH 也会明确提示：*declares no dsh.bundle — installed as a plain dependency, not a profile layer*。

### 备选：写成 preset 行

同一个插件也可以不用 profile bundle，而是从 agent preset 组装。该行只注册工具、不发布服务，因此直接放在 preset 顶层即可，不需要 `isolate` realm。

```yaml
- id: matlab-bridge
  name: '@alotop/dsh-matlab-bridge'
```

### 独立使用，或从检出安装

用于开发这个桥接本身，或者包还没发到 npm 之前：

```sh
npm pack                                                       # 得到 alotop-dsh-matlab-bridge-<版本>.tgz
npx ./alotop-dsh-matlab-bridge-<版本>.tgz                      # 直接从 tarball 跑安装命令
npm install -g ./alotop-dsh-matlab-bridge-<版本>.tgz           # 或全局安装
npm install --no-save ./alotop-dsh-matlab-bridge-<版本>.tgz    # 或装进某个工程
```

只想试一下 tarball 时记得加 `--no-save`；否则 npm 会在那个工程的 `package.json` 里记下一条指向 tarball 的 `file:` 依赖。

**只有一个包。** `dsh-matlab-bridge-setup` 是它的一个 `bin` 入口，不是独立包——`npx @alotop/dsh-matlab-bridge` 之所以能跑起它，是因为它是该包唯一的可执行文件。

### 行配置

全部可选，正常机器上无需任何配置。

```yaml
- id: matlab-bridge
  name: '@alotop/dsh-matlab-bridge'
  config:
    pythonPath: python3.12        # 默认：PATH 上第一个 python3 / python
    workDir: /path/to/project     # 默认：调用方会话的 cwd
    figureDir: /tmp/figures       # 默认：<workDir>/.matlab-figures
    timeoutMs: 180000             # 默认：180000
```

## 工具

### `matlab_run`

在常驻会话里运行 MATLAB 代码，返回命令窗口输出。**变量、图形、数据跨调用保留。** 用 `disp`/`fprintf` 打印，或者传入单个裸表达式让它显示值。失败时返回 MATLAB 错误信息与错误栈。

### `matlab_debug`

驱动 MATLAB 调试器。动作：`break`、`breakError`、`clearBreaks`、`run`、`status`、`stack`、`vars`、`get`、`eval`、`step`、`stepIn`、`stepOut`、`continue`、`quit`、`finish`。

一次真实会话：

```
matlab_debug action=break file=myfunc line=12   → ok
matlab_debug action=run   code="myfunc(data)"   → state: paused
matlab_debug action=vars                        → 暂停帧的局部变量
matlab_debug action=get   name=startIndex       → 7
matlab_debug action=eval  code="n - k + 1"      → 8
matlab_debug action=step                        → state: paused（下一行）
matlab_debug action=continue                    → state: completed
```

`eval` 在**暂停帧内部**求值，所以可以在不改文件的前提下验证对某个活变量的推断。断点打在注释或空行上会绑定到下一个可执行行，与 MATLAB 编辑器行为一致。

### `matlab_figure`

检查与导出图形。`list` 列出打开的 figure，`save` 把每张图导出为 150 DPI 的 PNG 并返回路径，`close` 关闭一张或全部。

先用 `matlab_run` 画图，再导出——figure 留在会话里。**拿到路径后要用 `read_image` 把 PNG 读回来**；只拿路径等于没看图。

### `matlab_session`

`start`、`status`、`stop`。MATLAB 启动要几十秒，所以会话保持热态并复用。`status` 会报告包路径、驱动是否在跑、以及引擎运行库是否已经铺开。

## 工作原理

| 文件 | 作用 |
|---|---|
| `src/plugin.mjs` | Cordis 插件：定位自身文件、持有驱动进程、注册工具 |
| `python/ml_driver.py` | 常驻驱动。stdin/stdout 上是行分隔 JSON，持有一个 MATLAB Engine 会话 |
| `python/mfiles/dsh_evalbase.m` | 在 base 工作区求值，复现命令窗口的回显语义 |
| `python/mfiles/dsh_figure_*.m` | 以 JSON 形式列举与导出 figure |
| `scripts/setup-engine.mjs` | 从本地 MATLAB 铺开引擎运行库 |
| `python/selftest.py` | 对真实 MATLAB 的端到端自检 |

### 为什么协议要带 `@@DSH:` 前缀

MATLAB Engine 会把 MATLAB 命令窗口输出转发到驱动的 stdout，裸 JSON 协议会和这些输出抢同一个流。因此每一行协议都带 `@@DSH:` 前缀，不带前缀的行一律视为 MATLAB 输出（诊断信息），而不是去解析它。

### 命令窗口回显语义

`dsh_evalbase.m` 调用 `evalc('evalin(''base'', code)')`，并且**刻意不给 `evalin` 输出参数**。这才让捕获行为与命令窗口一致：赋值回显 `x = 41`，裸表达式回显 `ans = 42`，无值语句不输出。反过来，去要输出参数会把这三者全部抑制；而靠源码文本猜"是不是表达式"则会误判命令语法（如 `dbstop in f at 4`）和无输出参数的调用（如 `disp('hi')`）。

## 开发

```sh
git clone https://github.com/alotop/dsh-matlab.git
cd dsh-matlab
npm run setup      # 从本地 MATLAB 铺开引擎运行库
npm run selftest   # 对真实 MATLAB 的端到端检查（会启动一个）
npm run check      # 语法检查插件与脚本
```

`npm run selftest` 覆盖协议、输出捕获、错误上报、图形导出，以及完整的断点单步链路。它失败 = 驱动有问题，而不是插件或传输层的问题，故障域因此很小。

## 已知限制

- **图形以文件交付，不是内联图像。** `matlab_figure` 返回 PNG 路径。工具结果理论上可以携带内联图像块，但那要走附件服务换取引用；路径加 `read_image` 已经能让图可见，且不依赖任何服务契约。
- **驱动被强杀可能遗留 MATLAB 进程。** 驱动在 `atexit` 里退出引擎，但被硬终止时 `atexit` 不会执行。用 `matlab_session` 的 `action="stop"` 正常收尾。
- **MATLAB 忙时查询会排队。** 引擎在单线程上串行处理请求，所以后台运行未命中时发出的 `dbstack` 探测会阻塞到该调用让出控制权。`run` 已改为先查完成状态再探栈，规避了最糟的情况。
- **单步调试目前只在 Windows 上验证过。** 引擎铺开逻辑支持 `glnxa64` 与 `maca64`/`maci64`，但只有 Windows 跑过完整的端到端。欢迎其他平台的反馈。

## 许可

[MIT](LICENSE)。本包不再分发任何 MathWorks 代码；见许可文件末尾的说明。
