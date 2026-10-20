# HShell 开发计划（类 Xshell 跨平台 SSH 客户端）

> 本文件是项目的唯一开发基线。后续任何会话先读本文件，再按「阶段任务」推进，并在文末「进度记录」更新状态。
>
> 项目根目录：`/home/tsinghua/hshell`
> 产品名：**HShell**（包名 `hshell`）
> 文档版本：v1.1（2026-10-17）
>
> **当前状态**：已实现可运行的 Xshell 风格 UI 与核心链路（多标签终端、会话管理器、
> SFTP 面板、分屏、快捷键、真实 SSH 连接）。详见第 12 节「当前实现状态」。

---

## 1. 项目目标

从零实现一个类似 Xshell 7 的跨平台桌面 SSH 客户端，满足：

- 多标签 SSH 终端 + 会话管理（分组、搜索、快速连接、导入导出）
- 串口终端（设备枚举、波特率 / 数据位 / 停止位 / 校验 / 流控 / DTR / RTS）
- SFTP 双栏文件浏览 / 上传 / 下载 / 删除 / 重命名 / 权限修改
- 端口转发：本地 `-L`、远程 `-R`、动态 SOCKS5 `-D`
- 密钥管理（生成 / 导入 / 指纹 / 安装公钥）
- 会话日志（文本 / asciinema v2）、分屏、搜索、主题
- 跳板机（ProxyJump）
- 可打包分发（Linux AppImage/deb、Windows NSIS、macOS dmg）

**非目标（首版不做）**：TELNET/RLOGIN、X11 转发、GSSAPI/Kerberos、FIDO/SK 密钥、`ProxyCommand`、自动更新、Xshell `.xsh` 导入、移动端。

> `xshell7.zip` 是第三方流传的破解版（含 `nslicense.dll`），仅作产品形态参考；本项目不读取、不修改、不依赖它。

---

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | **Electron**（最新稳定版，P0 实测决定） | 无 Rust 工具链；Node 22 可直接复用 ssh2；electron-builder 跨平台打包成熟 |
| 构建 | electron-vite + Vite + TypeScript 5.9 | 主/预加载/渲染三端一体，HMR |
| UI | React 19 + zustand 5 | 组件生态、状态简单可控 |
| 终端 | `@xterm/xterm` 6 + addon-fit / search / unicode11 / webgl | 事实标准，性能与兼容性最好 |
| SSH | `ssh2` 1.17（纯 JS） | 覆盖 PTY shell、SFTP、`forwardOut`/`forwardIn`，无需原生模块 |
| 分屏 | 自绘嵌套布局树（终端） + `react-resizable-panels`（侧栏 / SFTP） | 终端面板绝对定位、不重建；侧栏复用现成可拖拽面板 |
| 校验 | zod 4 | IPC / 导入导出 / 存储 schema |
| 测试 | Vitest + Playwright（可选） | 核心逻辑无需图形环境 |
| 打包 | electron-builder 26 | AppImage/deb/NSIS/dmg |

**不选 Tauri 的原因**：本机无 Rust；SSH 需 `russh` 或 Node sidecar，复杂度反而更高；Ubuntu 20.04 的 WebKitGTK 版本老旧。

**Xshell 本身**是 Windows 原生 C++（Win32 + 自研 SSH 栈 + 自研终端），不可跨平台复刻。本项目用成熟库实现等价功能，不追求二进制层面的同构。

---

## 3. 环境准备

### 3.1 已有环境

- Node v22.22.2、npm 10.9.7
- npm registry 已指向 `https://registry.npmmirror.com`
- 本地 sshd 已运行于 `127.0.0.1:22`（集成测试目标）
- `~/.ssh/id_rsa` 存在（P0 验证是否无口令；若有口令，测试时从环境变量读取）
- 无 Rust；当前自动化 shell 无图形显示（但用户桌面会话可 `npm run dev`）

### 3.2 镜像（必须）

`/home/tsinghua/hshell/.npmrc`：

```ini
registry=https://registry.npmmirror.com
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

构建脚本/终端中同时设置：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

### 3.3 初始化命令（P1 执行）

```bash
cd /home/tsinghua/hshell
npm init -y
npm i --save-dev electron electron-vite vite @vitejs/plugin-react typescript@5.9 electron-builder vitest @types/node @types/react @types/react-dom
npm i react react-dom zustand \
      @xterm/xterm @xterm/addon-fit @xterm/addon-search @xterm/addon-unicode11 @xterm/addon-webgl \
      ssh2 zod react-resizable-panels
```

> `ssh2` 的可选原生依赖（`cpu-features`/`nan`）不要编译：安装时加 `--omit=optional`，`electron-builder.yml` 设 `npmRebuild: false`。产物中不得出现原生 `.node` 模块。

### 3.4 运行与预览

```bash
# Electron 桌面端（需要图形会话）
npm run dev

# 浏览器 UI 预览（无需 Electron；自动使用模拟 SSH 后端）
npm run dev:web                         # 默认仅监听 127.0.0.1:5174
HSHELL_HOST=0.0.0.0 npm run dev:web     # 供 Windows / 局域网访问，端口可用 HSHELL_PORT 覆盖

# 本地演示 SSH 服务器（接受任意认证，提供交互式 shell）
node scripts/mock-sshd.mjs   # 127.0.0.1:2222
# 然后在 UI 的快速连接中输入 demo@127.0.0.1:2222

# 类型检查 / 单元测试 / 构建
npm run typecheck
npm run test
npm run build
```

> 若环境变量中带有 `ELECTRON_RUN_AS_NODE=1`，启动 Electron 前需 `env -u ELECTRON_RUN_AS_NODE ...`。

**从 Windows 访问浏览器预览**：Windows 的 `127.0.0.1` 指向 Windows 自身，因此不能直接用
`http://127.0.0.1:5174` 访问 Linux/虚拟机中的 Vite。用 `HSHELL_HOST=0.0.0.0 npm run dev:web`
启动后，在 Windows 打开 Vite 打印的 `Network` 地址（例如 `http://192.168.179.128:5174`）。
如果仍不通：WSL2 用 `localhost`；或从 Windows 建立 SSH 隧道
`ssh -L 5174:127.0.0.1:5174 tsinghua@<Linux-IP>` 后访问 `http://127.0.0.1:5174`；或放行
Linux 防火墙 5174/tcp；VirtualBox NAT 模式还需在 VM 设置中配置 5174 端口转发。开发服务器无鉴权，
只应在可信局域网内开放。

### 3.5 Electron 兼容性闸门（P0）

Ubuntu 20.04 的 glibc 为 2.31，新版 Electron 可能要求更高。安装后检查：

```bash
objdump -T node_modules/electron/dist/electron | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -3
node_modules/electron/dist/electron --version   # 有显示环境时
```

- 最高依赖版本 ≤ `GLIBC_2.31` 才可在本机运行。
- 若不满足，回退 `electron@40` 或 `electron@38`，并在进度记录中写明最终版本。
- 无显示环境下无法验证 UI 时，以 `ldd`/`objdump` 符号检查 + 后续桌面会话实测为准。

---

## 4. 目录结构

```
/home/tsinghua/hshell/
  PLAN.md
  package.json
  electron.vite.config.ts
  electron-builder.yml
  tsconfig.json / tsconfig.node.json / tsconfig.web.json
  .npmrc
  build/                        # 图标、entitlements、安装器资源
  resources/                    # 应用图标
  src/
    main/
      index.ts                  # app 生命周期、单实例、菜单
      window.ts                 # BrowserWindow、CSP、导航策略
      ipc/register.ts           # ipcMain.handle 注册
      ipc/validate-sender.ts    # 发送方与 payload 校验
      ssh/
        session-manager.ts      # 每会话一个 Client + epoch 状态机
        transport.ts            # connect 参数、认证、hostVerifier
        shell-channel.ts        # PTY 打开、resize、数据批量与背压
        reconnect.ts            # 指数退避
        sftp-service.ts         # 列表/CRUD/传输/进度/取消
        forward-service.ts      # -L / -R
        socks5-server.ts        # -D
        key-service.ts          # 密钥生成/导入/指纹/安装
        known-hosts.ts          # TOFU + OpenSSH known_hosts
      serial/
        manager.ts              # 串口连接、批量/背压、日志、ZMODEM（无 Electron 依赖）
      storage/
        config-store.ts         # 原子 JSON + 迁移 + 备份
        vault.ts                # safeStorage / 主密码加密
        logging.ts              # 会话日志与轮转
        export-import.ts
      util/                     # paths、atomic-write、ports、id
    preload/
      index.ts                  # contextBridge 唯一暴露面
    shared/
      types.ts                  # 领域类型
      jump.ts                   # ProxyJump 链解析/格式化（主进程与界面共用）
      session.ts                # 串口/SSH 会话的显示辅助函数
      ipc-contract.ts           # 通道名与请求/响应类型
      schemas.ts                # zod schema
      errors.ts                 # 错误码
      constants.ts
    renderer/
      index.html
      src/
        main.tsx  App.tsx
        components/
          layout/  tabs/  terminal/  sftp/  sessions/
          tunnels/ keys/ settings/ dialogs/
        stores/                 # zustand: session/runtime/ui/transfer
        lib/                    # terminal-registry、shortcuts、format
        styles/
  tests/
    unit/
    integration/
  scripts/
```

**硬性约束**：`src/main/ssh/**` 与 `src/main/storage/**` 不得 `import 'electron'`。Electron 相关能力（路径、safeStorage、事件发送）通过接口注入，保证可在普通 Node/Vitest 下运行真实 SSH 集成测试。

---

## 5. 关键设计

### 5.1 终端与会话

- 连接流程：`Client.connect(opts)` → `ready` → `client.shell({ term:'xterm-256color', cols, rows })`。
- **尺寸**：终端 `fit()` 后且 cols/rows 非零才连接；resize 50–100ms 防抖，仅在尺寸变化时 `stream.setWindow(rows, cols, height, width)`（参数顺序不可错）。
- **背压**：主进程按 ~16ms 或 32KB 合并 SSH 数据，以 `Uint8Array` 发往渲染进程；渲染进程 `term.write(data, cb)` 后回 `ssh:ack`。主进程未确认字节 > 2MB 时 `stream.pause()`，< 512KB 时 `resume()`。
- **粘贴**：按 ~32KB 分片写入。
- **认证顺序**：agent（`SSH_AUTH_SOCK`）→ 私钥 → 密码 → keyboard-interactive。`keyboard-interactive` 支持多轮，prompt 的 `echo` 决定是否掩码。
- **重连**：状态机 `connecting → authenticating → connected → reconnecting → failed`；每次尝试递增 `epoch`，过期回调全部丢弃。仅传输层异常断开重试（1s→30s 指数退避 + 抖动）；认证失败、host key 不匹配不重试。重连后重建 shell/SFTP/隧道并发送当前终端尺寸，保留 xterm 缓冲。
- **Host key（TOFU）**：不设 `hostHash`，在 `hostVerifier(keyBuffer, cb)` 中解析算法并计算 `SHA256:` 指纹；未知主机弹窗确认，不匹配则硬失败（需先删除记录）。弹窗超时 30s 自动拒绝。已知主机来源：应用内 `known_hosts.json` + `~/.ssh/known_hosts`（首版跳过 hashed 条目并提示）。
- **ZMODEM（rz/sz）**：主进程在 shell 输出流中识别 `**\x18B0` 的 ZRQINIT/ZRINIT 头（允许跨 chunk 分片），确认前仅暂存可能的协议前缀，绝不把协议字节写进 xterm；命中后由 `zmodem.js` 会话接管。`sz`（下载）先选择目录，远端文件名经消毒后以 0600 独占写入；`rz`（上传）支持多选文件。进度经 `zmodem:status` 事件驱动终端右下角的浮动进度条（方向、文件名、字节数、百分比）并在状态栏同步显示；本地写入失败与远端 `rz` 返回 ZSKIP（目录只读/空间不足）都会上报错误并立即中止会话；成功结束时等待 ZFIN 最多 2 秒，超时即 abort，避免终端被协议会话占用数秒，残留控制帧会被丢弃而不回显。支持取消与错误提示。
- **串口会话**：`Session.connectionType = 'serial'` 时复用同一套 runtime/IPC（`ssh:connect|write|ack|disconnect`），由 `main/serial/manager.ts` 驱动 `serialport`。设备路径去掉首尾空白并拒绝控制字符，波特率 50–4,000,000 的整数，数据位 5/6/7/8，停止位 1/1.5/2，校验 none/even/odd/mark/space，流控 none/rtscts/xonxoff。打开后按配置设置 DTR/RTS（PTY 等不支持时忽略失败）。数据流复用 8ms 批量、2MB/512KB ack 背压、`SessionLogger` 与 `ZmodemController`；串口没有窗口尺寸，`resize` 为空操作。SFTP、端口转发、公钥安装对串口会话禁用。
- **资源释放**：关闭 tab/窗口时销毁 xterm、搜索/WebGL addon、日志流、监听器、定时器。

### 5.2 会话与存储

userData 目录下（`app.getPath('userData')`）：

| 文件 | 内容 |
|---|---|
| `config.json` | 全局设置 |
| `sessions.json` | 会话列表 |
| `folders.json` | 分组树 |
| `vault.json` | 加密后的凭据/私钥 |
| `known_hosts.json` | TOFU 记录 |
| `layouts.json` | 标签/分屏布局 |
| `logs/` | 会话日志 |

写入方式：临时文件 + fsync + rename；保留 `.bak`；文件带 `schemaVersion`，加载时执行迁移；损坏文件隔离为 `.corrupt-<时间戳>` 并回退默认值。

### 5.3 数据模型（摘要）

```ts
Folder   { id, name, parentId, sortOrder }
Session  { id, name, folderId, host, port, username,
           auth: { method: 'password'|'key'|'agent'|'keyboard-interactive',
                   credentialId?, keyId?, agent? },
           connectionType?: 'ssh' | 'serial',        // 缺省为 ssh
           serial?: { path, baudRate, dataBits, stopBits, parity, flowControl, dtr?, rts? },
           proxyJump?: JumpHop[],
           terminal: { term, cols, rows, scrollback, encoding, theme },
           sftp: { localDir?, remoteDir? },
           tunnelIds: string[], logging: LogPolicy, color?, tags?,
           createdAt, updatedAt }
JumpHop  { host, port, username, auth }
Credential { id, label, type, encryptedSecret }   // 永不下发渲染进程
SshKey   { id, label, algorithm, publicKey, encryptedPrivateKey,
           encryptedPassphrase?, fingerprint, comment, createdAt }
Tunnel   { id, name, type:'local'|'remote'|'dynamic', bindHost, bindPort,
           targetHost?, targetPort?, autoStart, sessionId? }
Layout   { tabId, tree: SplitNode | PaneNode }
SplitNode{ type:'split', direction:'horizontal'|'vertical', sizes?:number[], children:LayoutNode[] }
PaneNode { type:'pane', sessionId }
```

### 5.4 导出/导入

- 单一 JSON：`{ format:'hshell-sessions', formatVersion:1, exportedAt, app:{name,version}, folders, sessions, keys? }`。
- 默认**不含**密钥与密码（密码只存在内存）；`keys` 仅在「包含密钥」时出现：用用户口令 scrypt(N=2^15,r=8,p=1) 派生密钥 + AES-256-GCM，保存 salt/iv/tag；导入时解密写入 `userData/keys/`（0600、`wx` 独占），并把会话的 `keyPath` 重映射到新文件。
- 导入用 zod 全量校验；拒绝更高版本；ID 冲突重映射；`~/.ssh/config` 导入按 host/port/user 去重；不静默覆盖现有文件。

### 5.5 IPC 契约

- **invoke**：`sessions:*`、`folders:*`、`vault:*`、`ssh:connect|disconnect|reconnect|write|resize|ack`、`sftp:*`、`tunnels:*`、`keys:*`、`settings:*`、`knownHosts:*`、`dialog:pickFiles|pickDirectory|pickSave`。
- **主→渲染**：单通道 `hshell:event`，载荷 `{ type, sessionId?, epoch, seq, payload }`；类型包括 `ssh:data`、`ssh:status`、`ssh:notice`、`ssh:exit`、`ssh:hostkey`、`sftp:progress`、`tunnel:status`、`vault:locked`、`menu:action`。
- 限制：非终端 payload ≤ 64KB；终端写入 ≤ 1MB，超出分片。
- 所有 invoke 参数在 main 侧用 zod 校验；校验 `event.senderFrame` 为主窗口主 frame 且 URL 为打包地址或开发服务器地址。

### 5.6 键盘快捷键（Xshell 风格）

所有快捷键统一由渲染进程的捕获阶段处理，并同步到原生菜单；xterm 通过
`attachCustomKeyEventHandler` 让出这些组合键。**Ctrl+C 仍然发送 SIGINT**，复制使用
Ctrl+Shift+C / Ctrl+Insert。

| 快捷键 | 功能 |
|---|---|
| `Ctrl+N` | 新建会话（打开属性对话框） |
| `Ctrl+O` | 打开会话管理器并聚焦搜索框 |
| `Ctrl+T` | 用最近使用的会话新建标签页 |
| `Ctrl+W` | 关闭当前分屏（无分屏时关闭标签页） |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个标签页 |
| `Alt+1 … Alt+9` | 切换到第 N 个标签页 |
| `Ctrl+Shift+C` / `Ctrl+Insert` | 复制终端选中内容 |
| `Ctrl+Shift+V` / `Shift+Insert` | 粘贴 |
| `Ctrl+Shift+F` | 在终端中查找 |
| `Ctrl+Shift+K` | 清屏 |
| `Ctrl+Shift+R` | 重新连接当前会话 |
| `Ctrl+Shift+W` | 断开当前连接（保留标签页） |
| `Ctrl+Shift+S` | 水平分屏 |
| `Ctrl+Shift+D` | 垂直分屏 |
| `Ctrl+B` | 显示/隐藏会话管理器 |
| `Ctrl+Shift+E` | 显示/隐藏 SFTP 面板 |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | 放大 / 缩小 / 重置终端字号 |
| `Alt+Enter` / `F11` | 切换全屏 |
| `F1` | 快捷键帮助对话框 |
| `Esc` | 关闭当前对话框、查找栏或提示面板 |

新增或调整快捷键时，必须同步修改：
`src/renderer/src/lib/shortcuts.ts`（唯一注册表）、`src/main/menu.ts`（菜单加速键）、
本表格，以及 `src/renderer/src/components/ShortcutsDialog.tsx`（帮助界面自动读取注册表）。

---

## 6. 安全模型

- BrowserWindow：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webviewTag: false`；`app.enableSandbox()`。
- 预加载只通过 `contextBridge.exposeInMainWorld('hshell', ...)` 暴露命名空间方法；**不暴露** `ipcRenderer`。
- 生产 CSP 严格；禁止远程脚本/字体；拦截 `will-navigate` 与 `setWindowOpenHandler`；`shell.openExternal` 仅允许 http/https。
- 凭据：渲染进程只传 `credentialId`/`keyId`；私钥、密码、OTP 永不出 main。
- 保险库：
  - `safeStorage.isEncryptionAvailable()` 且后端不是 `basic_text` → 系统钥匙串；
  - 否则要求主密码（scrypt + AES-256-GCM），启动解锁、空闲锁定；
  - 无安全后端且用户未设主密码 → 默认不落盘密码，仅当次会话使用。
- SFTP 路径安全：
  - 远端路径按 POSIX 规范化，拒绝 NUL 与控制字符；
  - 下载落地文件名为 basename，拒绝 `..`、绝对路径、Windows 保留名（CON/PRN/NUL/COM1…）与尾随点/空格；
  - 目标目录必须经 `realpath` 校验在允许根内；
  - 递归遍历不跟随符号链接，按 realpath 去重防环，限制深度与文件数。
- 拖拽：preload 使用 `webUtils.getPathForFile(file)`，主进程登记 opaque token；渲染进程不能直接传任意本地路径。
- 终端输出视为不可信数据：校验 OSC 8 链接 URL；默认禁用 OSC 52 写入剪贴板。
- 打包：ASAR + Electron fuses（`RunAsNode: false`、`EnableNodeCliInspectArguments: false`、`OnlyLoadAppFromAsar: true`）。

---

## 7. 阶段任务与验收

> 每阶段完成后运行对应验收命令，并在「进度记录」勾选。任何阶段不得跳过验收。

### P0 可行性闸门

任务：
1. 写 `.npmrc`，安装 Electron + ssh2（`--omit=optional`）。
2. 检查 Electron 的 glibc 需求；确定可用主版本。
3. 写 `scripts/ssh-smoke.mjs`：用 Node 直连 `127.0.0.1:22`（`~/.ssh/id_rsa`）：
   - exec `uname -a` 并打印；
   - 打开 shell 执行 `stty size`，验证输出为 `rows cols`；
   - SFTP 列出 `~`；
   - 在远端 `mkdtemp` 下建目录、上传、下载、`rm -rf` 清理。

验收：
```bash
node scripts/ssh-smoke.mjs
```
四项全部成功；记录 Electron 最终版本。

### P1 脚手架

任务：
1. electron-vite + React + TS + zustand 工程；`npm run dev/build/typecheck/test`。
2. `window.ts` 安全配置；preload 暴露 `hshell.ping()`；渲染端显示主进程版本。
3. `electron-builder.yml`：Linux AppImage + deb、`asar: true`、`npmRebuild: false`。
4. Vitest 冒烟测试 1 个。

验收：
```bash
npm run typecheck && npm run test && npm run build
npm run dist:linux -- --dir     # 或 npx electron-builder --linux --dir
```
产物可启动（有桌面会话时 `npm run dev` 实测）。

### P2 存储与会话管理

任务：
- 原子 JSON 存储、schema 迁移、损坏隔离。
- 文件夹树 + 会话 CRUD + 搜索 + 快速连接。
- 导出/导入（默认不含密钥）。
- `~/.ssh/config` 导入（Host/HostName/User/Port/IdentityFile/ProxyJump 子集）。

验收：单测覆盖迁移、导入导出往返、文件夹环检测；重启应用后数据保持。

### P3 终端核心（可运行里程碑）

任务：
- ssh2 shell + xterm + 标签栏 + resize + 背压 ack。
- 密码 / 私钥 / agent / keyboard-interactive 认证。
- TOFU host key 弹窗与拒绝逻辑。
- 重连状态机。
- 快捷键：Ctrl+T/W、Ctrl+Tab、Ctrl+Shift+C/V、Ctrl+Shift+F。

验收：
- 集成测试：shell 输出、`stty size`、resize 生效、断线重连、host key 不匹配被拒绝。
- 桌面会话中 `npm run dev` 可登录 `127.0.0.1` 并正常交互。

### P4 密钥与保险库

任务：
- 生成 RSA/ECDSA/ed25519；导入与 `parseKey` 校验；`SHA256:` 指纹。
- 安装公钥到 `authorized_keys`（exec；测试注入临时路径）。
- 保险库：safeStorage 后端检测、主密码回退、解锁/锁定。

验收：
- 生成的密钥可被 `ssh2.utils.parseKey` 解析；
- 错误主密码无法解锁；
- 搜索磁盘无明文密码/私钥；
- 安装公钥测试只写临时文件。

### P5 SFTP

任务：
- 双栏 UI、列表/元数据、mkdir/rmdir/unlink/rename/chmod。
- 递归上传下载、队列、进度、取消、冲突处理。
- 原子上传（临时名 + rename）、路径与符号链接防护。

验收：
- 传输后 SHA-256 一致；
- 取消后临时文件被清理；
- 路径 sanitizer 模糊测试通过（`..`、绝对路径、控制字符、保留名）。

### P6 端口转发

任务：
- `-L`（`net.createServer` + `forwardOut`）、`-R`（`forwardIn` + `tcp connection`）、`-D`（SOCKS5 CONNECT）。
- 启停、状态展示、错误提示（EADDRINUSE 等）、完整清理。

验收：
- 本地转发访问临时 HTTP 服务；
- `curl --socks5-hostname` 走动态转发；
- 远端转发到本机服务；
- 端口占用有明确错误；停止后无残留监听/socket。

### P7 跳板机

任务：
- 逐跳 `forwardOut` 作为下一跳 `sock`；每跳独立认证与 host key 校验，并支持每跳
  独立的用户名与密码/密钥（结构化 `jumpHosts`）。
- `ProxyJump` 解析与兼容；失败时回收中间连接。

验收：localhost 两跳连接成功；第二跳失败时第一跳被关闭；解析器单测通过。

### P8 分屏 / 搜索 / 日志 / 交互

任务：
- 布局树 + 拖拽分隔条 + 布局持久化。
- 仅可见 pane 启用 WebGL，切换 dispose，`onContextLoss` 回退 DOM。
- 搜索 addon；日志（文本 / asciinema v2、轮转、0600）；主题；中英文；单实例。

验收：4 分屏可用；布局重启恢复；日志正确 flush；长时间切换无 WebGL 泄漏。

### P9 分发

任务：
- 图标、fuses、AppImage/deb、NSIS（Linux 交叉构建或 Windows CI）、macOS CI 配置。
- 安装后冒烟测试。

验收：
- 干净 Ubuntu 22.04 容器可安装运行；
- Windows VM 可安装运行（或 CI 产物验证）；
- ASAR 内无原生模块、无 devDependencies。

### P10 加固

任务：20 会话浸泡、100MB 传输、高吞吐终端背压、重连风暴、24h 保活、依赖审计。

验收：内存无持续增长；无泄漏监听器/socket；已知限制写入文档。

### P11 串口

任务：
- 引入 `serialport`（N-API 预编译绑定，无需 Electron 重编译），主进程 `SerialManager`
  复用 runtime 管理、批量/背压、日志与 ZMODEM。
- 会话属性增加协议选择（SSH / 串口）、设备枚举与刷新、波特率、数据位、停止位、
  校验、流控、DTR/RTS。
- 串口会话禁用 SFTP、端口转发与公钥安装；标签栏、状态栏与侧栏显示
  `path · baud 8N1`。
- 打包保留 `@serialport/bindings-cpp` 的 prebuilds 并 `asarUnpack`。

验收：真实或虚拟串口可双向收发；`RESIZE` 不影响数据；断开后设备可被重新打开；
错误路径/波特率/占用有明确提示；日志与 ZMODEM 仍工作；打包产物可加载串口绑定。

### P12 会话自动化与外观

任务：
- 会话管理器与快速命令栏支持自动隐藏（14px 滑轨，悬停展开），状态持久化。
- 会话管理器右边缘可拖动调整宽度（180–520px），双击恢复 252px，宽度持久化到
  `localStorage`；自动隐藏模式下隐藏拖动手柄，悬停展开时沿用自定义宽度。
- 快速命令为**全局配置**（不绑定会话）：所有标签底部显示同一组按钮，发送到当前
  终端，可选追加回车；「管理」打开独立对话框编辑，列表保存在 `localStorage`
  （`hshell.quickCommands`），首次升级时把旧版各会话内的快速命令合并迁移到全局
  列表并去重。触发规则与突出显示集仍按会话在「自动化」页编辑。
- 触发器：终端输出中出现指定字符串时执行动作（发送字符串或弹出通知），支持
  字面量/正则、大小写敏感、启用开关、每规则冷却时间，ANSI 序列先剥离再匹配。
- 撰写窗格：草拟多行文本（Ctrl/Cmd+Enter 发送、Esc 关闭），发送前可勾选追加回车。
- 脚本录制：记录终端输入/输出与相对时间，停止时生成独立 Node.js 回放脚本
  （SSH 走 ssh2，串口走 serialport），连接凭据不写入脚本；状态栏显示 REC 计时，
  关闭标签/断开连接会取消录制。限制 20k 事件、4MB 输出、512KB 输入。
- 色彩自定义：10 套内置配色（HShell 深/浅、Solarized、Dracula、Nord、Gruvbox、
  Monokai、One Dark、经典绿），按会话保存；突出显示集按行应用背景/前景色，
  基于 xterm marker + decoration，限制装饰数量并在滚动时回收。
- 快捷键与菜单：撰写窗格 `Ctrl/Cmd+Shift+M`，录制/停止 `Ctrl/Cmd+Alt+R`。

验收：全局快速命令在任意标签底部显示并可写入当前会话、可选择追加回车，重启后保持；
自动隐藏/展开正常且重启保持；
触发器在输出命中时发送或通知且不因回显形成循环；撰写窗格多行发送正确；
录制生成的 `.mjs` 通过 `node --check` 且不含凭据；每个会话的配色与突出显示生效；
类型检查、单元测试与打包构建通过。

### P13 会话密码保存

任务：
- 会话属性「身份验证」新增「保存密码」选项（仅密码认证），说明加密存储方式。
- 主进程新增 `CredentialStore`：优先使用系统钥匙环（safeStorage 且非 `basic_text`）；
  否则使用 AES-256-GCM，密钥由 0600 的本机密钥文件与 machine-id 派生，重启后无需
  主密码即可自动复用。
- 连接时若会话未携带密码，主进程按会话 ID 从凭据库注入，密码不下发渲染进程。
- 保存会话时更新/删除凭据；删除会话时同步清理；导出/导入不包含密码与保存标记。
- 兼容旧会话：未勾选时不落盘，保持原有仅内存行为。

验收：勾选保存后重启应用，点击会话可直接连接且无需重新输入密码；磁盘文件中不含
明文密码，凭据密钥文件权限为 0600；取消勾选或删除会话会清除凭据；导出包不含密码；
系统钥匙环可用时优先走 safeStorage；类型检查、单元测试与端到端验证通过。

---

## 8. 测试策略

### 8.1 单元测试（Vitest）

- 路径消毒与 Windows 保留名
- known_hosts 解析（含 hashed 条目的跳过）
- SOCKS5 报文解析
- 重连退避与 epoch
- 存储迁移、损坏恢复
- IPC zod schema
- 导入导出（含加密载荷）
- 串口参数规范化与 `8N1` / 目标字符串格式化
- 输出规则引擎（ANSI 剥离、字面量/正则、跨块匹配、冷却、突出显示行定位）
- 录制器（事件上限、相对时间、SSH/串口回放脚本生成与语法校验、文件名消毒）
- 配色方案解析与旧主题映射、自动化相关 zod schema
- 会话密码凭据库（机器绑定加密往返、safeStorage 优先级、换机后解密失败、文件权限）

### 8.2 集成测试（普通 Node，无需显示）

- 目标：`127.0.0.1:22`，密钥 `~/.ssh/id_rsa`。
- 远端所有写操作限制在 `mkdtemp` 目录内。
- 不修改真实 `~/.ssh/authorized_keys` 与 `known_hosts`。
- 转发测试使用临时端口。
- 串口测试用 `socat` 创建一对 PTY（`pty,raw,echo=0,link=…`），未安装 socat 时整组跳过；
  不访问真实串口设备。

运行：`npm run test:integration`。测试通过环境变量注入 SSH 密钥路径与口令，不在仓库写死凭据。

### 8.3 UI / E2E

- 当前自动化 shell 无显示。优先由用户桌面会话执行 `npm run dev` 验证。
- 如需自动化：经用户同意后安装 Xvfb，用 `xvfb-run -a` + Playwright `_electron.launch`。
- 打包冒烟：`npx electron-builder --linux AppImage deb`，解包检查内容。

---

## 9. 打包配置要点

`electron-builder.yml`：

```yaml
appId: com.hshell.app
productName: HShell
directories:
  buildResources: build
  output: dist
files:
  - out/**/*
  - package.json
asar: true
npmRebuild: false
linux:
  target: [AppImage, deb]
  category: Network
  artifactName: ${productName}-${version}-${os}-${arch}.${ext}
win:
  target: [nsis]
  artifactName: ${productName}-${version}-${os}-${arch}.${ext}
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
mac:
  target: [dmg, zip]
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
```

- 安装依赖时 `--omit=optional`，确保 `cpu-features`/`nan` 不进入产物。
- 串口使用 `serialport` 的 N-API prebuilds；`files` 不再全局排除 `*.node`，改为
  `asarUnpack: node_modules/@serialport/bindings-cpp/prebuilds/**`，避免从 ASAR 内
  `dlopen`。`npmRebuild: false` 下这些预编译绑定可直接在 Electron ABI 下加载。
- `afterPack` 钩子应用 `@electron/fuses`。
- macOS 构建必须在 macOS 主机/CI 上完成；本机只出 Linux 产物。

---

## 10. 如何继续开发（后续会话使用）

新开一个会话，发送：

```
按 /home/tsinghua/hshell/PLAN.md 继续开发，完成 P1。
先阅读 PLAN.md 的「阶段任务」「开发守则」，再实现；完成后运行该阶段验收命令，
并更新 PLAN.md 文末的「进度记录」。
```

要求后续执行者遵守：

1. **先读 PLAN.md**，确认当前阶段与已完成内容，不重复实现已有模块。
2. **一次只推进一个阶段**（除非用户明确要求合并）；每阶段结束必须跑验收。
3. `src/main/ssh/**`、`src/main/storage/**` 保持无 Electron 依赖，便于 headless 测试。
4. 所有 IPC 参数用 zod 校验；新增通道先改 `shared/ipc-contract.ts`。
5. 不把密码、私钥、OTP 发送到渲染进程；不写明文凭据到磁盘。
6. 不改动 `~/.ssh/authorized_keys`、`~/.ssh/known_hosts`（测试用临时路径）。
7. 不依赖 `xshell7.zip` 中的任何文件。
8. 每个阶段完成后更新「进度记录」，必要时在下方追加「实现备注」。

---

## 11. 风险与应对

| 风险 | 应对 |
|---|---|
| Electron 新版本要求 glibc > 2.31 | P0 用 `objdump` 检查；回退 40.x/38.x |
| 无显示环境无法跑 UI | 核心逻辑 headless 可测；UI 由用户桌面验证或装 Xvfb |
| ssh2 能力边界（无 ProxyCommand/GSSAPI/证书/FIDO） | 明确列为非目标；ProxyJump 用嵌套 forwardOut |
| 多终端 WebGL context 上限 | 仅可见 pane 启用，切换 dispose，失联回退 DOM |
| IPC 无流控导致大输出堆积 | ack 背压 + pause/resume + 32KB 分片 |
| 转发规则泄漏 | 每条规则集中管理句柄，停止顺序 listener→socket→channel→unforwardIn |
| 日志含敏感信息 | 默认关闭自动记录敏感会话；提示风险；文件 0600 |
| 串口原生绑定与 Electron ABI 不匹配 | 使用 N-API prebuilds（ABI 稳定），打包 `asarUnpack`，产物启动时枚举端口验证 |

---

## 12. 当前实现状态（2026-10-20）

已完成并验证的 UI / 核心链路：

- **界面**：Xshell 风格工具栏、会话管理器（分组树 / 搜索 / 右键菜单 / 导入导出菜单）、
  多标签、终端区、可调高度的 SFTP 双栏面板、状态栏、欢迎页。
- **终端**：真实 ssh2 PTY shell、xterm.js 渲染、resize、8ms/32KB 批量与 ack 背压、
  密码 / 私钥 / Agent / 键盘交互认证、TOFU 主机密钥对话框、手动重连、断开；
  传输层断开后按 1s→30s 指数退避自动重连（认证失败不做自动重连，改为在终端内
  提示输入密码，可中途手动断开）；
  keepalive 为 15s×3，可发现静默断链，重连最多 8 次且总窗口约 2 分钟，超限后转为
  `closed` 并显示手动「重新连接」，主机明确断开或正常关闭时立即断开、不重试。
- **ZMODEM**：终端内支持 `sz`（远端 → 本地下载）与 `rz`（本地 → 远端上传）；
  自动识别协议头、分片安全、文件名消毒、文件选择框默认打开桌面、终端浮动进度条
  与状态栏进度、取消与错误提示；本地写入失败和远端 ZSKIP 均上报为失败。
- **串口**：会话协议可选 SSH / 串口，设备路径支持手动输入与 `serial.list()` 枚举刷新；
  可配置波特率、数据位、停止位、校验、流控与 DTR/RTS。连接复用 runtime 事件通道、
  8ms 批量与 ack 背压，支持会话日志与 ZMODEM；标签栏、状态栏、侧栏显示
  `设备 · 波特率 8N1`。串口会话自动禁用 SFTP、端口转发与公钥安装。错误信息区分
  设备不存在、权限不足（含 Linux `dialout` 提示）、设备被占用与非法参数。
- **会话**：本地 JSON 持久化（临时文件 + fsync + rename、`.bak`、损坏隔离）、
  schema v2 迁移、分组环检测、CRUD、快速连接（`user@host:port`）、会话属性对话框；
  导出 / 导入 JSON 会话包（默认不含密钥，可选口令加密私钥）；`~/.ssh/config`
  导入（Host/HostName/User/Port/IdentityFile/ProxyJump，自动去重）。
- **SFTP**：远程目录浏览、上传 / 下载（含递归）、新建目录、重命名、删除、chmod；
  本地面板同等的目录操作。本地面板默认打开本机桌面（`Desktop`，兼容本地化的
  `桌面`），远程面板默认打开主机桌面目录（`~/Desktop` / `~/桌面`），桌面目录不
  存在时分别回退到各自的主目录。传输使用临时名（`.hshell-upload-*` / `.hshell-download-*`）
  流式写入后原子 rename，实时进度（字节 / 百分比）显示在面板与状态栏，可随时取消并
  清理临时文件；断线时自动取消该会话的全部传输。远程路径强制绝对路径、拒绝 `..`
  与控制字符；下载文件名经 Windows 保留名 / 控制字符消毒，并做本地目录包含校验，
  不跟随符号链接，限制深度与文件数。
- **密钥与保险库**：生成 RSA / ECDSA / Ed25519、导入私钥、`SHA256:` 指纹、复制公钥、
  通过已连接的会话把公钥追加到 `~/.ssh/authorized_keys`（去重、`umask 077`）；
  私钥与口令只存于加密保险库。优先使用系统密钥环（safeStorage），Linux 后端为
  `basic_text` 或不可用时回退主密码（scrypt + AES-256-GCM），支持解锁 / 锁定。
  会话属性中可选择「私钥文件」或保险库密钥（`keyId`），私钥内容不进入渲染进程。
- **端口转发**：本地 `-L`、远程 `-R`、动态 `-D`（内置 SOCKS5 CONNECT，支持 IPv4、
  域名与 IPv6）。工具栏 / 菜单打开管理对话框，可查看运行状态、停止规则；端口占用等
  错误有明确提示，会话断开、认证失败或重连时自动注销远端监听并销毁本地监听器与通道。
- **跳板机（ProxyJump）**：会话属性中以列表逐跳配置主机、端口、用户名与认证方式
  （密码 / 私钥 / agent / 键盘交互 / 与主机会话相同），因此跳板机与目标机可使用完全
  不同的账号和密码；最多 8 跳。仍兼容 `[user@]host[:port]` 与逗号分隔的 ProxyJump
  字符串及 `~/.ssh/config` 导入。逐跳建立 `forwardOut` 通道作为下一跳的 `sock`，
  每跳独立认证与主机密钥校验。每跳的保存密码使用独立的加密凭据条目，不会写入
  `sessions.json`。任一跳失败会关闭已建立的跳板连接；重连时整条链重建，断开时
  全部回收。
- **分屏 / 查找 / 主题**：水平与垂直分屏、xterm 查找、深浅主题、字号调整。分屏按
  标签独立，布局是一棵可嵌套的 split 树：再次分屏只把**当前活动面板**的份额对半分
  （例如 50/50 → 50/25/25，即新面板占 1/4、原面板仍占 1/2），其他面板尺寸不变；
  在活动面板上按另一方向分屏会生成嵌套子分割，周围面板的矩形完全保持。所有面板
  绝对定位并以 pane id 为 key，拆入或拆出分屏时终端 DOM 节点不移动、不重建，连接、
  滚动内容与正在运行的命令保持不变；新面板继承当前活动面板的会话并另开一条连接，
  其他标签不受影响。分隔条可拖动，只调整相邻两个面板的份额。关闭分屏只结束该面板
  自己的连接；其所在的 split 只剩一个子节点时自动折叠，剩余尺寸按比例归一化。
  除快捷键外，还可从左侧会话列表把**任意会话**（SSH、串口、本地 Shell 均可）拖到
  终端面板上分屏：悬停时显示目标面板轮廓和将要占用的半区，落点最近的边决定分割
  方向与插入侧（左/上边插到目标之前，右/下边插到之后），放下即在新面板打开该会话，
  因此一个 SSH 会话和一个串口会话可以并排显示。拖拽分屏不要求目标会话已经打开，
  也不会影响目标面板已有的连接。已经打开的**标签页**同样可以拖到终端上分屏：标签栏
  中的标签可拖动，落点规则与会话列表一致；放下后源标签的整棵布局（含已分屏的面板）
  会并入目标标签，源标签从标签栏移除。并入的面板使用新的运行时重新建立连接，避免与
  旧标签关闭时的断开操作竞争同一个 runtime id；若源标签正在录制则先停止录制。把活动
  标签拖到它自己的终端上等同于分屏按钮（保留标签，只新增一条连接）。
- **布局持久化**：每个标签的嵌套 split 树（方向、面板顺序与百分比尺寸）写入
  `layouts.json`，同时兼容旧版平面布局；启动时恢复标签与分屏，已删除的会话会被
  跳过并折叠空 split。恢复的面板保持空闲状态并显示「已恢复上次布局 / 连接」按钮，
  避免重启时自动向所有主机发起连接。
- **终端时间戳**：会话属性 →「终端」可开启「在终端左侧显示每行时间戳」，按输出行在
  xterm 左侧的独立窄栏显示本地 `HH:mm:ss`。时间戳不在终端缓冲区中，复制、查找、
  突出显示与触发器均不受影响；开启后终端可用宽度相应缩小并由 `fit()` 重新计算列数。
  行号通过 xterm marker 跟踪，滚动、回滚与 scrollback 裁剪后仍保持对齐；自动换行的
  续行只在逻辑行首标注时间。SSH 串口会话与分屏面板均适用，切换会话属性即时生效。
- **会话日志**：会话属性可开启自动记录终端输出，支持纯文本（`.log`）与
  asciinema v2（`.cast`）。默认写入 `userData/logs/`，也可在「高级」页为每个会话
  指定绝对路径目录（支持 `~` 展开，通过目录选择按钮填写；相对路径会被拒绝并在
  连接时报错）；目录 0700、文件 0600。纯文本日志可勾选「每行添加时间戳」，在
  每个非空行前写入本地 `[YYYY-MM-DD HH:mm:ss]`，跨数据块的行边界也能正确处理；
  asciinema 事件自带相对时间轴，因此该选项对 `.cast` 不生效。日志按 64KB 或 1s
  刷新、关闭时 flush；ZMODEM 协议字节不会写入日志；按 10MB 轮转并保留 5 份。
  文件名为「会话名-YYYYMMDD-HHMMSS.扩展名」，会话名经路径安全消毒；同一秒内
  重名时追加 `-2`、`-3` 等后缀。
- **国际化**：工具栏 `EN / 中` 按钮即时切换中英文，选择存入 `localStorage`
  （`hshell:locale`）；应用菜单随语言重建；界面、对话框、状态栏、快捷键帮助均已
  双语化（`tr(zh, en)` 内联文案，无独立字典）。
- **快捷键**：见 5.6，注册表与帮助对话框已联动；单实例锁与第二次启动聚焦主窗口。
- **自动化与外观（P12）**：会话管理器和每个会话底部的快速命令栏均可自动隐藏为
  14px 滑轨并悬停展开，状态存于 `localStorage`。快速命令是全局配置（
  `hshell.quickCommands`），所有会话共享同一组按钮，点击发送到当前终端（可选追加
  回车），「管理」打开独立的全局编辑对话框；会话属性的「自动化」页按会话编辑
  触发规则（发送/通知、字面量/正则、大小写、启用、冷却）与突出显示集
  （背景/前景色）。触发器在剥离 ANSI
  后的输出上跨数据块匹配；发送动作会写入当前会话并计入录制。撰写窗格支持多行
  草稿与 Ctrl/Cmd+Enter 发送。录制器记录输入/输出与相对时间，停止后生成独立
  Node.js 回放脚本（SSH 使用 ssh2 + `HSHELL_HOST/PORT/USERNAME/KEY/PASSWORD` 环境
  变量，串口使用 serialport），不包含连接凭据；状态栏显示 `REC mm:ss`，关闭标签或
  断开连接会取消。10 套内置配色按会话保存，突出显示使用 xterm marker/decoration
  按行着色并限制数量、回收滚动出屏的装饰。
- **会话密码保存（P13）**：会话属性「身份验证」提供「保存密码」勾选（仅密码认证），
  密码由主进程 `CredentialStore` 加密保存。系统钥匙环不可用（`basic_text`）时，
  使用 AES-256-GCM 与本机密钥文件 + machine-id 派生的密钥加密，文件 `0600`；
  重启后连接时主进程按会话 ID 注入密码，密码不会下发渲染进程。取消勾选或删除会话
  会清除凭据；导出/导入不包含密码或保存标记。端到端验证覆盖「保存 → 重启应用 →
  不输入密码直接连接」，并确认磁盘无明文。
- **终端内密码重试**：密码认证失败（`All configured authentication methods failed`）
  不再直接弹出「连接失败」卡片，而是在该会话的终端里提示 `user@host` 并等待输入：
  字符以 `*` 掩码、回车提交、Ctrl+C 取消；输入只走进程内 IPC 的密码重试通道，
  不写入终端记录/录制，也不回显。主进程用新密码重新认证，成功后立即通过
  `CredentialStore` 加密保存到会话（`savePassword` 置为真）并通知界面刷新会话
  列表；失败则再次提示并标注「密码不正确」。私钥/agent/host key 等其他认证错误
  仍按原逻辑显示失败卡片。
- **启动体验**：窗口创建后立即显示，`index.html` 的静态加载页先于 React 出现
  （首帧约 0.25–0.4 秒）；主进程先创建窗口，再注册 IPC 与菜单。界面主题持久化到
  `<userData>/ui-prefs.json`，同时用于原生窗口背景色；preload 在页面脚本之前通过
  同步 IPC 读取该值，`index.html` 在首帧前应用 `html[data-theme]`。深色主题在
  启动、「重新加载界面」以及从仅使用 localStorage 的旧版本升级时都不会闪白或
  被重置。终端组件（xterm 及 addon，约 676KB）改为按需 chunk，首帧后 1.2 秒预取，
  首屏主包从约 1.6MB 降到约 0.96MB。
- **加固（P10）**：可选浸泡测试覆盖 20 个并发会话连续 3 轮（峰值 20 连接、结束后
  `SshManager` 运行表为空、服务器无残留连接）、16MB 终端输出背压（未确认数据峰值
  < 8MB，ack 后完整收齐）、10 个并发重复 `connect` 收敛为 1 条连接、30 次快速
  连接/断开循环，以及 100MB SFTP 上传 + 下载校验和一致（约 11s，RSS 增长 < 400MB）。
  `keepaliveInterval=15s`、`keepaliveCountMax=3` 已启用；未实际运行 24 小时保活。
  生产依赖 `npm audit --omit=dev` 为 0 漏洞；dev 依赖中 electron-builder 的
  `global-agent/roarr` 有 8 个 moderate 告警，仅影响打包工具链，无修复版本（需升级到
  27 alpha），不进入产物。
- **分发**：`scripts/gen-icon.py` 生成 16–1024px 多尺寸图标、`.ico` 与 `.icns`；
  Electron fuses 在打包时翻转（`RunAsNode` 关闭、`OnlyLoadAppFromAsar`、关闭
  `NODE_OPTIONS` 与 inspect 参数）；AppImage（121MB）与 deb（95MB）已在本机构建，
  并在 Ubuntu 20.04 上以 AppImage 解包、deb 解包方式启动，`scripts/smoke-packaged.mjs`
  通过 CDP 验证渲染进程、preload 桥与工具栏。ASAR 内排除 `cpu-features` 与 ssh2
  的可选 `.node`、测试目录与 devDependencies；串口所需的
  `@serialport/bindings-cpp` prebuilds 放在 `app.asar.unpacked`，打包产物已实测可
  `serial.list()` 并枚举真实设备。Windows `--dir`、免安装单文件
  （`dist:win:portable`，约 94MB）与 zip（`dist:win:zip`，约 146MB）产物已生成并检查，
  ASAR 内包含当前源码。Windows 启动体验：窗口在 `BrowserWindow` 创建后立即显示
  （不再等待 `ready-to-show`，冷启动/杀软扫描时不会长时间没有任何反馈），主进程先
  创建窗口、再同步注册 IPC 与菜单，避免存储初始化推迟首帧；`index.html` 内置静态
  加载页，首帧约 0.25–0.4 秒出现。主题不闪烁：主进程把界面主题持久化到
  `<userData>/ui-prefs.json`，创建窗口时用对应颜色作为原生 `backgroundColor`，并通过
  `additionalArguments: --hshell-theme=…` 传给 preload；`index.html` 在 head 中、
  React bundle 之前的内联脚本同步读取该值并设置 `html[data-theme]`，深色用户从第一帧
  起就是深色（加载页也同步使用深色配色）。主题以主进程记录为准，localStorage 仅作为
  浏览器演示与旧版本的兜底，因此即使 `localStorage` 未落盘也能正确恢复。渲染端把
  xterm 及其 addon 拆成按需 chunk（首包从约 1.6MB 降到约 0.96MB），首帧后 1.2 秒
  预取，打开会话时无需等待。单实例锁
  获取失败时在 Windows 上弹窗说明原因（已有实例，或两个实例权限级别不同），而不是
  静默退出。渲染页面加载失败（例如 `app.asar` 解压不完整、被占用或被杀软拦截）时，
  主进程会把 `did-fail-load`、`render-process-gone`、preload 与渲染进程错误写入
  `<userData>/renderer-errors.log` 并弹窗提示；`index.html` 内置静态加载提示，避免
  出现没有任何信息的白屏。当 `render-process-gone` 的原因为 `launch-failed` 时
  （Windows 便携版常见于解压目录缺少 AppContainer SID 的读取/执行 ACE，Chromium
  沙箱因此无法创建渲染进程），主进程会弹窗说明原因，并给出
  `icacls "<目录>" /grant "*S-1-15-2-1:(OI)(CI)(RX)" "*S-1-15-2-2:(OI)(CI)(RX)" /T`
  修复命令；启动阶段、单实例锁结果、`child-process-gone`、未捕获异常与退出原因写入
  `<userData>/startup.log`，渲染层错误仍写入 `renderer-errors.log`。可执行文件清单为 `asInvoker`，程序本身不要求管理员权限；若解压目录受
  策略限制（如 `Program Files`、AppLocker/SmartScreen 拦截未签名程序），需换到普通
  用户目录运行。NSIS 安装包在 Linux 上交叉构建需要 wine32（electron-builder
  需运行 32 位安装器生成卸载程序，本机未安装），macOS 产物需要 macOS 主机，二者由
  `.github/workflows/build.yml` 在 CI 中构建。
- **验证**：`npm run typecheck` 通过；默认 253 个测试通过（225 个单元 + 28 个集成
  测试；覆盖迁移、导出导入往返、文件夹环、ssh config、ZMODEM 双向协议与
  远端跳过/本地写入失败、串口 ANSI
  颜色透传、断线自动
  重连、重连预算耗尽后自动断开、主机明确断开时不重连、认证失败不做自动重连而是
  终端内提示、终端密码掩码输入/回车提交/Ctrl+C 取消、错误密码再次提示且仅在
  认证成功后保存、
  保险库加解密与 safeStorage 回退、密钥生成/导入/去重、
  authorized_keys 命令转义、SFTP 校验和往返 / 取消清理 / chmod、路径 sanitizer
  模糊测试、`-L`/`-R`/`-D` 转发与端口占用清理、ProxyJump 解析与两跳连接/失败回收、
  日志文本/asciinema 格式与轮转、文件名（会话名-时间戳/同秒冲突后缀）、
  自定义日志目录解析（绝对路径/`~`/相对路径拒绝）、
  逐行时间戳（跨块行边界、asciinema 不受影响）、终端时间戳时钟格式、
  嵌套分屏的份额保持/嵌套方向/删除折叠/几何计算、
  布局树构建恢复与旧平面格式兼容/损坏回退、i18n 切换、串口参数
  规范化与 socat 虚拟串口双向收发 / 日志 / ZMODEM / 错误提示、输出规则引擎与
  跨块匹配/冷却、录制器与回放脚本语法、配色方案解析、自动化 schema、
  启动诊断文案与 ACL 修复命令、界面主题偏好读写（未设置/损坏/归一化）、
  会话管理器宽度夹取、跳板机逐跳凭据恢复与
  密码落盘/导出脱敏、全局快速命令的归一/去重/上限/迁移、本地 SFTP 起始目录）。另有 5 个默认跳过
  的浸泡测试，用 `HSHELL_SOAK=1` /
  `HSHELL_SOAK_FULL=1` 开启（20 会话 ×3 轮、16MB 背压、并发连接风暴、30 次连接
  循环、100MB SFTP 往返），均已在本机通过。`npm run build` 通过；打包后的
  AppImage/deb 以无头 Electron + CDP 验证渲染、preload 桥、语言切换与布局恢复。
  P12 另用无头 Electron + CDP 验证快速命令栏、自动隐藏滑轨、撰写窗格、自动化
  设置页、Dracula 配色与突出显示编辑、`REC` 状态栏及关闭标签取消录制；并通过
  本地 `mock-sshd` 实测触发器（通知、发送后再次命中通知）、快速命令发送与
  突出显示装饰（每行一个 decoration），打包后的 `linux-unpacked` 也通过了 P12
  UI 检查。快速命令改为全局后，CDP 确认多个标签显示同一组按钮、管理对话框写入
  `localStorage`（`hshell.quickCommands`）并在重启后保留。P13 另用密码专用 mock
  sshd 完成端到端验证：保存密码 → 重启应用 →
  直接连接成功；`sessions.json` 与 `credentials.json` 均不含明文，密钥文件权限
  为 0600。另通过无头 Electron + CDP 操作真实「新建会话」对话框：填写密码、
  勾选「保存密码」并保存，确认会话标记、凭据写入与加密存储均正确。分屏专项检查
  同时打开两个标签后对当前标签连续拆分：实测面板矩形为 50/25/25，再在活动面板上
  按另一方向拆分得到嵌套布局且前两个面板矩形完全不变；原终端 DOM 未重建、原连接
  未断开、另一标签仍为单窗口；拖动分隔条只改变相邻份额；关闭新面板后嵌套 split
  自动折叠，仅结束该面板自己的连接。拖拽分屏专项检查用两个不同会话（SSH + 模拟
  串口会话）实测：拖到右边缘时预览恰为右半区，放下后生成左右各半的两个面板且
  会话 id 正确、原连接未断开；再把另一会话拖到左面板上边缘，得到嵌套的上下分屏，
  外层两个面板的矩形保持不变。该场景已固化为可重复执行的无头检查
  `npm run e2e:drag-split`（先 `npm run build`）：拖到右半区生成 50/50 左右分屏，
  再把第三个会话拖到右侧面板下半区，得到外层保持 50/50、右侧嵌套上下 50/50 的
  三面板布局，三条连接均建立，两个分隔条存在；随后打开第四个会话的独立标签，把标签
  拖到首个面板左半区，源标签合并消失、面板变为 25/25/50、并入的会话重新连接，最终
  嵌套布局写入 `layouts.json`。终端时间戳专项检查由 `npm run e2e:timestamps` 固化：
  带时间戳的会话在 xterm 左侧生成 78px 独立栏，提示行显示 `HH:mm:ss`，输入命令后
  新输出行追加新的时间戳；窄栏位于终端缓冲区之外，未开启该选项的会话没有窄栏。
  密码重试专项检查由 `npm run e2e:password` 固化：错误密码连接后终端显示输入提示、
  不出现失败卡片，键入内容仅以 `*` 显示（终端文本中无明文），回车后服务器接受并
  输出 `SHELL READY`；随后 `sessions.json` 的 `savePassword` 变为 `true`，
  `credentials.json` 存在密文条目，两个文件均不含明文密码。
  启动主题专项检查由 `npm run e2e:startup-theme` 固化：确认构建产物在 React bundle
  之前执行主题引导脚本；默认启动为浅色且 `ui-prefs.json` 写入 `light`；切换主题后
  DOM、localStorage 与 `ui-prefs.json` 均为 `dark`；清空 localStorage 后重启，仍由
  主进程传入的主题在首帧恢复深色（`data-theme-source` 为 `preload`）。
  断线专项检查用 SIGSTOP 冻结 mock sshd 模拟设备失联：
  keepalive 在约 60 秒发现链路失效并进入自动重连，预算（8 次/约 120 秒）耗尽后状态
  变为「已断开」而非无限重连，终端缓冲同时打印 `[HShell] 连接已断开…` 与
  `Ctrl+Shift+R` 重连提示；直接结束 mock sshd（明确关闭）时则立即断开、不重试。

尚未完成：Windows NSIS 与 macOS dmg 的实机验证（NSIS 需 wine32，macOS 需 macOS
主机或 CI 运行）；
24 小时保活未实跑；串口仅在 `socat` 虚拟串口与本机 `/dev/ttyS*` 枚举上验证，尚未
在真实 USB 转串口适配器与硬件流控下实跑。

## 13. 进度记录

- [x] P0 可行性闸门
- [x] P1 脚手架
- [x] P2 存储与会话管理（原子存储 / 迁移 / 环检测 / 导出导入 / ssh config 导入）
- [x] P3 终端核心（认证 / TOFU / 背压 / 自动重连 / ZMODEM）
- [x] P4 密钥与保险库（生成 / 导入 / 指纹 / 安装公钥 / safeStorage 与主密码回退）
- [x] P5 SFTP（浏览 / 传输 / 进度 / 取消 / 原子写 / 路径加固）
- [x] P6 端口转发（-L / -R / -D，启停、错误提示与连接断开清理）
- [x] P7 跳板机（ProxyJump 解析、多跳 forwardOut、失败回收与重连重建）
- [x] P8 分屏/搜索/日志/交互（分屏 / 搜索 / 主题 / 快捷键 / 布局持久化 / 日志 / i18n）
- [x] P9 分发（图标 / fuses / AppImage / deb 已构建并冒烟；NSIS 与 dmg 由 CI 构建，
  本机无 wine/macOS，安装包实机验证待外部环境）
- [x] P10 加固（20 会话浸泡 / 100MB 传输 / 背压 / 重连风暴 / 依赖审计；
  24h 保活未实跑，配置已启用）
- [x] P11 串口（设备枚举 / 参数配置 / 数据收发 / 背压 / 日志 / ZMODEM / 打包绑定）
- [x] P12 自动化与外观（自动隐藏 / 快速命令栏 / 触发器 / 撰写窗格 / 脚本录制 /
  配色方案与突出显示集）
- [x] P13 会话密码保存（可选加密保存 / 重启自动复用 / 凭据随会话清理）

### 实现备注

- 日期：2026-10-18
- P2 完成：`src/main/storage/{json-file,migrations,export-import,ssh-config}.ts`；
  `AppStore` 不再依赖 Electron，构造函数接收 userData 目录以便单测。
  磁盘 schema 升到 2（新增 `proxyJump`），加载时剥离密码、修复悬空父分组并打断环。
  导出包格式 `hshell-sessions@1`；私钥以 scrypt+AES-256-GCM 嵌入，导入写入
  `userData/keys/`。导出对话框提供「包含私钥文件」选项，勾选后需输入至少 8 位且
  两次一致的口令；仅嵌入会话中以文件路径引用且可读取的私钥，保险库密钥不导出。
- ZMODEM：`zmodem.js@0.1.10`；自研前置检测器保证协议头不泄漏到终端，上传/下载
  均与真实 zmodem.js 对端做过逐字节往返测试。
- 自动重连：仅传输层错误/断链触发，1s→30s 指数退避 + 0–250ms 抖动；认证失败、
  主机密钥拒绝、键盘交互超时/取消直接进入 `failed`。重连复用同一 runtimeId，
  xterm 缓冲保持不变；关闭 tab 会清除重试定时器与挂起的认证请求。重连预算有限：
  最多 8 次，且从首次掉线起最多约 120 秒，超限后发送 `closed`（终端显示「重新
  连接」）而不是无限重试。主机主动发送 SSH_MSG_DISCONNECT，或在不伴随 socket/
  协议错误的正常关闭中结束连接时，视为明确断开，立即进入 `closed`、不再重连；
  静默掉线由 keepalive（15s×3）在约 60 秒内发现。连接状态变化也会以 `[HShell]`
  前缀写入终端回滚缓冲（掉线、正在重连、重连成功、连接失败），并给出
  `Ctrl+Shift+R` 重连 / `Ctrl+Shift+W` 停止重试的快捷键提示，避免只靠状态栏和
  浮层导致用户漏看。连接失败时终端内的错误面板可按 `Esc` 关闭（状态栏仍保留失败
  原因）；下一次连接失败时会重新出现。
- P4 完成：`storage/vault.ts` 加密保险库，safeStorage 仅在加密可用且 Linux 后端
  不是 `basic_text` 时采用，否则回退主密码（scrypt N=2^15,r=8,p=1 + AES-256-GCM，
  主密码至少 8 位，校验值 `hshell-vault-v1`）。`ssh/key-service.ts` 负责生成与导入，
  元数据写入 `keys.json`，私钥 JSON（含可选口令）只存保险库 `key:<id>`；
  渲染进程仅接触 `keyId`。安装公钥命令严格校验路径（拒绝 `..`、控制字符），
  测试全部使用临时路径，不触碰真实 `~/.ssh/authorized_keys`。会话属性支持
  「私钥文件 / 保险库密钥」两种来源。
- P5 完成：`ssh/paths.ts` 负责远程路径规范化（绝对路径、拒绝 `..`/控制字符/超长）
  与本地文件名消毒、目录包含校验；`manager.ts` 的上传/下载改为逐文件流式传输，
  写入 `.hshell-upload-<rand>` / `.hshell-download-<rand>` 后 rename，失败或取消时
  删除临时文件；`transferId` 贯穿 IPC 与 `sftp:progress` 事件，状态栏点击可取消，
  断开/失败会取消该 runtime 的全部任务；下载对符号链接 `lstat` 跳过，并限制递归
  深度 64、文件数 20000。`SftpPanel` 增加 chmod 与传输条；本地面板经
  `util/start-dir.ts` 打开本机桌面（`Desktop`/`桌面`），远端面板打开主机桌面，
  缺失时分别回退到各自主目录。集成测试用内存 SFTP
  服务器验证 SHA-256 往返、原子性、取消清理与 chmod；单测对 sanitizer 做 500 轮
  确定性模糊测试。
- P6 完成：`ssh/forward-service.ts` 独立管理所有转发规则（不依赖 Electron）。`-L`
  用 `net.createServer` + `forwardOut` 逐连接桥接；`-R` 通过 `forwardIn` 注册并在
  `tcp connection` 中按端口匹配后连接本机目标；`-D` 实现 SOCKS5 握手与 CONNECT
  （IPv4/域名/IPv6、正确的 reply code、握手后的剩余字节不丢失）。每条规则保存
  listener、socket、channel 句柄，停止时按顺序清理并 `unforwardIn`；会话关闭、
  认证失败或重连时自动注销全部规则。错误统一映射为中文提示（EADDRINUSE 等）。
  集成测试用内存 SSH 服务器 + 本地 HTTP/回显服务验证三条链路、停止后端口释放
  以及端口占用错误。
- P7 完成：`shared/jump.ts` 解析 OpenSSH `ProxyJump`（`[user@]host[:port]`、逗号分隔
  多跳、IPv6 方括号、`none`，最多 8 跳，拒绝空格/控制字符/非法端口）。会话保存
  结构化的 `jumpHosts`（主机、端口、用户名、可选 `auth`），管理器优先使用它；每跳
  可配置独立密码、私钥、agent 或键盘交互，未配置 `auth` 时回退到会话认证。客户端
  渲染层将列表同步为 `proxyJump` 字符串，旧数据与 `~/.ssh/config` 导入仍可直接使用。
  管理器按链逐跳建立连接，上一跳的 `forwardOut` 流作为下一跳的 `sock`；每跳独立
  执行主机密钥 TOFU 校验（键盘交互提示中显示跳板机地址）。最终 shell 仍建立在目标
  主机上。任何一跳失败都会调用 `closeJump()` 回收已建立的连接与通道；自动重连会
  重建整条链。跳板机密码按 `jump:<sessionId>:<jumpId>` 单独加密保存，连接时由主
  进程按跳恢复，落盘与导出均脱敏。单测覆盖解析与格式往返、逐跳凭据恢复与脱敏；
  集成测试验证两跳使用不同账号密码、错误跳板密码止步于该跳、目标认证失败时不重试
  且跳板连接被关闭、非法配置快速失败。
- P10 完成（除 24h 实跑）：新增 `tests/integration/soak.test.ts`（`HSHELL_SOAK=1`）
  与 sftp-transfer 中的 100MB 用例（`HSHELL_SOAK_FULL=1`）。测试直接读取
  `SshManager` 的私有运行表确认关闭后清空，并通过内存 SSH 服务器的连接集合判断
  无 socket 泄漏。背压测试在前 2MB 不 ack，验证流被暂停；随后 ack 并校验 16MB
  全部到达。100MB 假 SFTP 服务器原先按 32KB 扩容并整块复制，复杂度 O(n²)
  （首轮耗时 582s）；改为几何扩容后降至约 11s，说明客户端管线本身不是瓶颈。
  `npm audit --omit=dev --registry=https://registry.npmjs.org` 为 0；
  dev 依赖告警来自 electron-builder 的 `global-agent/roarr`，与运行时无关。
- P11 完成：`serialport@13` 的 `@serialport/bindings-cpp` 为 N-API 预编译绑定，实测在
  Electron 44（ABI 149）下无需重编译即可加载。`main/serial/manager.ts` 复用 `ssh:*`
  runtime 通道，实现 32KB 分片写入、8ms/2MB/512KB 背压、`SessionLogger` 与
  `ZmodemController`；`normalizeSerialOptions` 全量校验参数，错误映射为设备不存在 /
  权限不足（Linux 提示 `dialout`）/ 占用。PTY 等不支持 `port.set({dtr,rts})` 的设备
  会忽略该错误。UI 在会话属性中增加协议选择、设备 datalist + 刷新、波特率与帧格式、
  DTR/RTS；SFTP、隧道、公钥安装对串口会话禁用。打包配置不再全局排除 `*.node`，
  而是仅排除 ssh2/cpu-features，并把 serialport prebuilds `asarUnpack`；打包产物已用
  CDP 验证 `serial.list()`。集成测试用 `socat` PTY 对验证双向收发、设备释放、日志、
  ZMODEM 头识别与错误提示，缺少 socat 时自动跳过。
- P12 完成：`lib/output-rules.ts` 提供 ANSI 剥离与通用规则引擎（512 字符跨块携带、
  跳过落在携带区内的重复匹配、每规则冷却），同时用于触发器与突出显示行定位；
  `TerminalPane` 用 marker + decoration 按行着色，限制 400 个装饰并回收已滚出屏幕的
  marker。`lib/recorder.ts` 以相对时间记录输入/输出，生成 SSH（ssh2，支持
  `HSHELL_HOST/PORT/USERNAME/KEY/PASSWORD`）或串口（serialport）回放 `.mjs`，
  等待时间上限 5s、输出仅作为注释摘录；生成的脚本在单测里通过 `node --check`。
  `lib/color-schemes.ts` 内置 10 套配色并保留旧 `theme` 字段映射，会话属性新增
  「自动化」页编辑触发器与突出显示集。`lib/quick-commands.ts` 负责全局快速命令的
  归一化（长度上限、去重、100 条封顶）与旧版按会话数据的合并迁移，列表存于
  `localStorage` 并由 `QuickCommandsDialog` 编辑，`SessionDock` 渲染在每个标签底部，
  与工具栏、状态栏、菜单和快捷键（`Ctrl+Shift+M`、`Ctrl+Alt+R`）联动；侧栏与快速
  命令栏的自动隐藏状态存于 `localStorage`。IPC 新增 `recording:saveScript`，zod
  校验内容与默认文件名，保存时强制 0600。UI 已用无头 Electron + CDP 验证。
- P13 完成：`main/storage/credential-store.ts` 提供会话密码的加密存储，优先注入
  `safeStorage`；当后端为 `basic_text` 或不可用时回退到 AES-256-GCM，密钥由
  `userData/credentials.key`（0600，随机 32 字节）与 `/etc/machine-id`（或主机名）
  经 SHA-256 派生。`sessions:save` 在主进程写会话后按 `auth.savePassword` 更新或
  删除 `session:<id>` 凭据；`ssh:connect` 在密码缺失时注入，渲染进程始终拿不到已保存
  的密码。删除会话会清理凭据；导出 schema 同时剔除 `password` 与 `savePassword`。
  会话属性密码项增加「保存密码」勾选和「已保存；留空保持不变」提示。单测覆盖加密
  往返、换机失败、safeStorage 优先级与 0600 权限；端到端测试使用只接受指定密码的
  mock sshd，验证保存后重启可直接连接；对话框级 UI 检查（无头 Electron + CDP）
  确认「保存密码」勾选与保存链路。
- P9 完成（Linux）：`build/icon.{png,ico,icns}` 与 `build/icons/` 由 `scripts/gen-icon.py`
  生成，deb 安装 9 种 hicolor 尺寸。`electron-builder.yml` 增加 `electronFuses`
  （RunAsNode=false、Cookie 加密开启、NODE_OPTIONS/inspect 关闭、OnlyLoadAppFromAsar）
  与 `electronLanguages` 裁剪；fuse 翻转发生在签名前。ASAR 排除 `cpu-features`、
  全部 `.node`、ssh2 `util/pagent.exe`（pagent 触发整包 unpack）和测试/文档目录，
  产物 704 个条目内无原生模块。`scripts/smoke-packaged.mjs` 通过 CDP 检查启动；
  已验证 AppImage 解包、deb 解包与 `--dir` 产物。Windows `--dir`、portable 与 zip
  可交叉生成，NSIS 需要 wine32；`.github/workflows/build.yml` 提供
  Ubuntu/Windows/macOS 三平台构建。
  已知占位元数据：`homepage`、维护者邮箱使用 `example.com`，发布前应替换。
- P8 完成：`main/storage/session-log.ts` 提供文本与 asciinema v2 两种格式，使用
  `StringDecoder` 处理被切分的 UTF-8，64KB / 1s 刷新、关闭时 flush + fsync；达到
  10MB 后按 `.1`…`.5` 轮转，asciinema 轮转时重写头部。日志在 ZMODEM 控制器的
  `writeTerminal` 回调中写入，从而天然排除协议字节。`main/storage/layout-store.ts`
  以原子 envelope 保存 `layouts.json`；渲染端 `lib/layout.ts` 负责构建/恢复布局，
  恢复时丢弃已删除会话、空标签与非法尺寸。`lib/i18n.ts` 提供 `tr(zh, en)` 与
  `fmt`，语言存于 `localStorage` 并由 App 订阅以触发整树重渲染，主进程菜单通过
  `app:setLocale` 重建。新增 8 个日志测试、10 个布局/存储测试、3 个 i18n 测试。
- 日期：2026-10-17
- 最终版本：Electron 44.9.0（内置 Node 24.22）、electron-vite 6.0、Vite 8.3.4、
  React 19.3、TypeScript 7.0.2、ssh2 1.17、`@xterm/xterm` 6.0、
  react-resizable-panels 4.14。
- Electron 二进制的 glibc 需求实测最高为 `GLIBC_2.25`，可在 Ubuntu 20.04（2.31）运行。
- TypeScript 7 移除了 `baseUrl`，tsconfig 已改用相对 `paths`。
- react-resizable-panels v4 的 API 为 `Group` / `Panel` / `Separator`（`orientation`），
  不是旧版的 `PanelGroup` / `PanelResizeHandle`。
- 主题变量定义在 `:root`，并由 `App.tsx` 同步 `html[data-theme]`，保证通过 portal
  渲染的对话框也能继承主题。启动阶段的主题由主进程 `ui-prefs.json` 经
  `additionalArguments` 同步交给 preload，`index.html` 的内联脚本在首帧前应用，
  React 挂载后继续以 store 中的主题为准。
- 终端面板用 `React.lazy` 延迟加载（`TerminalPane` chunk 约 676KB），首屏只加载
  约 962KB 的主包；首帧后 1.2 秒预取，首次打开会话不会出现明显等待。
- 无头 Electron 在本机运行一段时间后可能以 SIGTRAP/SIGSEGV 退出，属无显示环境下的
  Chromium 限制；真实桌面会话不受影响。UI 验证使用 `--headless --ozone-platform=headless`
  加 CDP（`scripts/cdp-eval.mjs`、`scripts/cdp-type.mjs`）。
- 已知限制：本地 SFTP 路径由可信渲染进程传入（后续改为 opaque token）；
  密码只保存在内存；主机密钥变更当前允许显式覆盖（后续改为必须先删除记录）。
