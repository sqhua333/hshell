# HShell

一个 Xshell 风格的跨平台 SSH / 串口客户端。Electron + React + xterm.js + ssh2 / serialport，
支持多标签终端、会话管理、SFTP、ZMODEM（`rz`/`sz`）、密钥管理、分屏与布局恢复、
会话日志、端口转发（`-L`/`-R`/`-D`）、串口控制台、中英文界面与快捷键。

> 与 NetSarang Xshell 无任何关联；目录中的 `xshell7.zip` 仅为第三方产品形态参考，项目不使用其任何文件。

## 快速开始

```bash
npm install

# 桌面端（需要图形会话）
npm run dev

# 浏览器 UI 预览（模拟 SSH 后端，无需 Electron）
npm run dev:web                         # 默认 http://127.0.0.1:5174
HSHELL_HOST=0.0.0.0 npm run dev:web     # 供 Windows / 局域网访问（见下文）

# 类型检查 / 单元测试 / 构建
npm run typecheck
npm run test
npm run build
npm run e2e:drag-split                  # 拖拽分屏 UI 检查（需先构建，无头运行）
```

如果环境里设置了 `ELECTRON_RUN_AS_NODE=1`（某些 IDE 会注入），启动 Electron 时使用：

```bash
env -u ELECTRON_RUN_AS_NODE npm run dev
```

### 从 Windows 访问浏览器预览

`dev:web` 默认只监听 `127.0.0.1`，而 Windows 的 `127.0.0.1` 指向 Windows 自己，不是这台
Linux 机器。让 Vite 监听所有网卡，再用 Linux 的局域网 IP 访问：

```bash
HSHELL_HOST=0.0.0.0 npm run dev:web
# Vite 会打印：Network: http://192.168.179.128:5174/
```

然后在 Windows 浏览器打开 `http://192.168.179.128:5174`。端口可用 `HSHELL_PORT` 覆盖。

仍然打不开时按顺序排查：

1. **WSL2**：直接用 `http://localhost:5174`，WSL2 会把 localhost 转发到 Linux。
2. **SSH 隧道**（最稳妥，不受 VM 网络和防火墙影响）。在 Windows PowerShell 中执行：
   ```powershell
   ssh -L 5174:127.0.0.1:5174 tsinghua@192.168.179.128
   ```
   保持连接，然后打开 `http://127.0.0.1:5174`。
3. **Linux 防火墙**：`sudo ufw allow 5174/tcp`；确认 `ss -ltnp | grep 5174` 显示
   `0.0.0.0:5174` 而不是 `127.0.0.1:5174`。
4. **虚拟机网络**：VirtualBox NAT 模式需在虚拟机设置中把主机 5174 转发到客户机 5174；
   VMware NAT 通常可直接访问客户机 IP。确认 Windows 能 `ping 192.168.179.128`。

Vite 开发服务器没有鉴权，只应在可信局域网内这样开放，不要暴露到公网。

### 没有可用的 SSH 主机？

启动内置演示服务器（仅监听 127.0.0.1，接受任意认证）：

```bash
npm run mock:sshd      # 127.0.0.1:2222
```

然后在客户端右上角的快速连接输入 `demo@127.0.0.1:2222`，回车即可打开一个真实 PTY 终端。
该演示服务器不实现 SFTP 子系统。

## 界面

- **工具栏**：新建会话、会话管理器、复制/粘贴、重连/断开、SFTP、端口转发、密钥管理、
  撰写窗格、录制/停止、分屏、主题、中英文切换（`EN`/`中`）、快捷键。
- **会话管理器**：分组树、搜索、右键菜单（连接 / 编辑 / 复制 / 删除）、新建分组、
  导入导出菜单；可点击标题栏的图钉按钮自动隐藏为 14px 滑轨，悬停展开。
- **标签页**：多标签、状态圆点、中键关闭；分屏布局与面板尺寸在重启后自动恢复。
- **分屏**：`Ctrl+Shift+S` / `Ctrl+Shift+D` 在当前标签内水平/垂直拆分。每次分屏只
  对半拆开**当前活动面板**，其他面板尺寸不变（例如 50/50 再拆得到 50/25/25）；在
  活动面板上换一个方向分屏会形成嵌套布局，周围面板的窗口大小保持原样。分隔条可
  拖动。面板绝对定位且终端不重建，原面板的连接、滚动内容和正在运行的命令保持
  不变；新面板继承当前活动会话并另开一条连接，其他标签不受影响。也可以从左侧
  会话列表把任意会话拖到终端面板上分屏：靠近哪条边就朝哪个方向拆分（左/上边插到
  前面，右/下边插到后面），因此一个 SSH 会话和一个串口会话可以并排显示；拖拽时
  会高亮目标面板及新面板将占用的半区。`Ctrl+W` 关闭当前分屏（只剩一个面板时关闭
  标签页），也可点击面板右上角的 ×；关闭分屏只结束该面板自己的连接，剩余面板按
  原比例自动合并。
- **终端**：xterm.js、随窗口缩放、WebGL（仅可见 pane）、右键菜单、查找栏、ZMODEM。
- **断线与重连**：15 秒一次的 SSH keepalive（连续 3 次无响应即判定链路失效）可发现
  设备掉电、拔网线等静默断开。传输层异常时按 1s→30s 指数退避自动重连，最多 8 次
  且总时长不超过约 2 分钟；超过任一上限后自动断开，终端显示「重新连接」按钮，不再
  后台无限重试。若主机发送了明确的 SSH 断开消息或正常关闭连接，则立即断开，不重连。
  断开、正在重连、重连成功与连接失败的提示除状态栏/浮层外，还会以 `[HShell]` 前缀
  直接写入终端回滚缓冲，并提示 `Ctrl+Shift+R` 重新连接、`Ctrl+Shift+W` 停止重试。
- **快速命令栏**：每个标签底部固定显示当前会话的快速命令按钮，可自动隐藏。
- **SFTP 面板**：本地/远程双栏，目录导航、上传、下载（含递归）、新建目录、重命名、
  删除、chmod；传输条显示实时进度与速率，可取消；上传/下载均先写临时文件再原子
  替换，失败或取消不会留下半成品；下载对文件名消毒并校验目标目录，不跟随符号链接。
  远程面板默认从主机桌面目录开始（`~/Desktop` 或本地化的 `~/桌面`），不存在时
  回退到登录主目录。
- **跳板机**：会话属性中的「跳板机（ProxyJump）」支持 `user@bastion:22`、
  逗号分隔多跳与 `[IPv6]:port`；每跳独立校验主机密钥，失败时自动回收已建立的连接。
- **状态栏**：连接状态、主机、终端尺寸、编码、传输进度、录制计时、版本。

## 快速命令、触发器与自动化

在「会话属性 → 自动化」中为每个会话配置：

- **快速命令**：添加标签与命令文本，可选择发送时是否追加回车。连接后命令按钮显示在
  当前标签底部的快速命令栏，点击即写入终端。点击栏上的「管理」可直接打开自动化页。
- **触发器**：终端输出中出现指定字符串时执行动作：
  - **发送字符串**：例如匹配 `Password:` 后自动输入口令或确认文本；
  - **弹出通知**：例如匹配 `ERROR` 时在应用内提示。
  模式支持字面量或正则、大小写敏感开关与启用开关；匹配前会剥离 ANSI 转义序列，
  可跨数据块匹配，并带 1.5 秒/规则的冷却以避免输出回显造成循环。
- **突出显示集**：为匹配的行设置背景色与前景色，连接时自动高亮重要输出（见下一节）。

快速命令栏右侧还提供撰写窗格与录制按钮：

- **撰写窗格**（`Ctrl+Shift+M`）：草拟多行文本后一次发送，`Ctrl/Cmd+Enter` 发送、
  `Esc` 关闭，可勾选「发送后追加回车」。
- **脚本录制**（`Ctrl+Alt+R`）：开始后状态栏显示 `REC mm:ss`，记录终端输入/输出与
  相对时间。再次点击（或点击状态栏计时）停止并弹出保存对话框，生成独立的 Node.js
  回放脚本：
  - SSH 会话使用 `ssh2`，可通过 `HSHELL_HOST`、`HSHELL_PORT`、`HSHELL_USERNAME`、
    `SSH_AUTH_SOCK`、`HSHELL_KEY`、`HSHELL_PASSWORD` 覆盖连接参数；
  - 串口会话使用 `serialport`，设备与帧格式来自录制时的会话配置。
  脚本只包含键入内容与输出摘录，不含连接密码或私钥；关闭标签或断开连接会取消录制。
  单次录制上限为 20,000 个事件、4MB 输出、512KB 输入，超出部分会丢弃并在脚本中注明。

侧栏与快速命令栏的自动隐藏状态会保存在本地，重启后保持。

## 配色方案与突出显示

- 会话属性「终端」页可选择 10 套配色：HShell 深色/浅色、Solarized 深色/浅色、
  Dracula、Nord、Gruvbox Dark、Monokai、One Dark、经典绿，并即时预览 8 个色块。
- 配色按会话保存；旧版深/浅主题字段仍会映射到对应配色，已有会话无需重新配置。
- 同一页可添加「突出显示」规则：匹配模式（字面量或正则、大小写敏感）、背景色、
  前景色与启用开关。命中的行会按颜色渲染，规则按顺序匹配，每行只应用首条规则。

## 会话日志与布局恢复

- 在「会话属性 → 高级」中勾选「连接时自动记录终端输出」，可选纯文本（`.log`）或
  asciinema v2（`.cast`）。日志写入 `userData/logs/`（目录 `0700`、文件 `0600`），
  每秒或每 64KB 刷新一次，关闭时强制 flush；单文件达到 10MB 后轮转并保留 5 份。
  asciinema 日志可用 `asciinema play <file>.cast` 回放。
- ZMODEM 协议字节不会写入日志，只有终端显示内容会被记录。
- 标签与嵌套分屏树（方向、面板顺序、尺寸）会保存到 `userData/layouts.json`，并
  兼容旧版平面布局文件。重启后布局自动恢复，但面板不会自动连接：每个恢复的面板
  显示「已恢复上次布局 / 连接」按钮，点击后才建立 SSH 连接。已删除的会话会自动从
  布局中移除。
- 日志可能包含命令与敏感输出，请妥善保管。

## 界面语言

工具栏右侧的 `EN` / `中` 按钮可即时切换英文与中文，选择会保存在本地，应用菜单
也会同步重建。

## 会话导入 / 导出

会话管理器右上角的 `⋯` 菜单：

- **导出会话…**：保存为 JSON，默认不含密码与私钥。勾选「包含私钥文件」后可用至少
  8 位的口令加密嵌入私钥（仅限会话中以文件路径引用且可读取的私钥，保险库密钥不导出）；
  导入时自动处理 ID 冲突。
- **导入会话…**：zod 全量校验，拒绝更高格式版本；文件含加密私钥时会提示输入口令。
- **从 `~/.ssh/config` 导入…**：支持 `Host` / `HostName` / `User` / `Port` /
  `IdentityFile` / `ProxyJump`，按 host/port/user 去重；通配符 Host 会被跳过。

## 密钥管理

点击工具栏的钥匙图标打开「密钥管理」：

- **生成**：Ed25519（推荐）、ECDSA（256/384/521）、RSA（3072/4096），可为私钥设置口令。
- **导入**：粘贴 OpenSSH / PEM 私钥，使用 `ssh2.utils.parseKey` 校验；相同指纹自动去重。
- **复制公钥**：复制 `ssh-ed25519 AAAA…` 形式的公钥，便于粘贴到服务器。
- **安装到当前服务器**：仅在当前会话已连接时可用，通过远端 shell 以 `umask 077`
  追加到 `~/.ssh/authorized_keys`（已存在则不重复写入）。
- 在会话属性的「身份验证」中，可把私钥来源切换为保险库密钥；连接时由主进程解密，
  私钥内容不会下发到界面。

首次使用需初始化保险库：系统密钥环可用时自动使用；否则要求设置至少 8 位主密码，
私钥以 scrypt + AES-256-GCM 加密保存在 `userData/vault.json`。密码无法找回。

## 保存会话密码

在「会话属性 → 身份验证」输入密码后勾选「保存密码」，下次启动应用即可直接连接，
无需重新输入：

- 系统钥匙环可用时，密码由 Electron `safeStorage` 交由系统密钥环加密。
- 没有可用钥匙环（Linux 下 `basic_text`）时，使用 AES-256-GCM 加密，密钥来自
  `userData/credentials.key`（权限 `0600`，随机生成）并绑定本机 machine-id。
  这种方式可以跨重启自动使用，但安全性弱于系统钥匙环：同一系统账户下的其他程序
  理论上可以解密该文件。
- 密码只在主进程中解密，连接时按会话 ID 注入，不会下发到渲染进程。
- 取消勾选并保存会删除已保存的密码；删除会话也会同步清理凭据。
- 导出的会话包不包含密码，也不包含「保存密码」标记。

勾选后若需要更换密码，重新输入新密码并保存即可；编辑时留空表示保留原密码。

## ZMODEM 文件传输（rz/sz）

终端内自动识别 ZMODEM 协议，无需打开 SFTP 面板：

- 远端执行 `sz <文件>`：客户端弹出目录选择框，文件保存到所选目录；重名自动追加序号。
- 远端执行 `rz`：客户端弹出文件选择框（可多选），确认后上传。
- 状态栏显示方向、文件名与进度；协议字节不会污染终端显示。

远端需要安装 `lrzsz`，例如 Ubuntu/Debian：`sudo apt-get install lrzsz`。
传输期间当前终端会被协议占用，完成后恢复正常交互。

## 串口终端

新建或编辑会话时，把「协议」切换为「串口」：

- **设备**：可直接输入（`/dev/ttyUSB0`、`/dev/cu.usbserial-1`、`COM3`）或从下拉列表
  选择，右侧按钮刷新可用设备。
- **参数**：波特率（支持自定义，50–4,000,000）、数据位 5/6/7/8、停止位 1/1.5/2、
  校验 none/even/odd/mark/space、流控 none/RTS-CTS/XON-XOFF，以及连接时是否拉高
  DTR / RTS。
- 串口会话与 SSH 共享标签页、终端、快捷键、会话日志与 ZMODEM；标签与状态栏显示
  `设备 · 波特率 8N1`。
- SFTP、端口转发和「安装公钥」对串口会话不可用；串口没有窗口尺寸，调整窗口大小
  不会向设备发送 `RESIZE`。

Linux 下普通用户访问串口需要加入 `dialout` 组（部分发行版为 `uucp`）：

```bash
sudo usermod -aG dialout "$USER"
# 重新登录后生效
```

没有真实设备时，可以用 `socat` 创建一对虚拟串口来试用：

```bash
socat -d -d pty,raw,echo=0,link=/tmp/ttyA pty,raw,echo=0,link=/tmp/ttyB
# 在 HShell 中连接 /tmp/ttyA（115200 8N1）
# 另一个终端与设备端通信：
picocom -b 115200 /tmp/ttyB       # 或 cat /tmp/ttyB / echo hello > /tmp/ttyB
```

## 端口转发

点击工具栏的链接图标（或「工具 → 端口转发…」）打开管理对话框，规则作用于当前会话：

- **本地 `-L`**：在本地监听，连接经 SSH 服务器转发到目标地址，例如
  `127.0.0.1:8080 → 127.0.0.1:80`（目标地址由服务器解析）。
- **远程 `-R`**：请求服务器监听指定地址/端口，把连接转发回本机目标；
  是否允许非回环监听取决于服务器的 `GatewayPorts` 配置。
- **动态 `-D`**：本地启动 SOCKS5 代理（仅 CONNECT），支持 IPv4、域名与 IPv6；
  `curl --socks5-hostname 127.0.0.1:1080 https://example.com` 即可使用。

端口冲突、权限不足等错误会直接显示在对话框中；会话断开或重连时自动停止并清理
全部监听器与已建立的通道。

## 快捷键（Xshell 风格）

| 快捷键 | 功能 |
|---|---|
| Ctrl+N / Ctrl+T / Ctrl+W | 新建会话 / 新建标签 / 关闭当前分屏（无分屏时关闭标签） |
| Ctrl+Tab / Ctrl+Shift+Tab | 切换标签 |
| Alt+1…9 | 切到第 N 个标签 |
| Ctrl+Shift+C / Ctrl+Insert | 复制 |
| Ctrl+Shift+V / Shift+Insert | 粘贴 |
| Ctrl+Shift+F | 查找 |
| Ctrl+Shift+R / Ctrl+Shift+W | 重连 / 断开 |
| Ctrl+Shift+S / Ctrl+Shift+D | 水平 / 垂直分屏 |
| Ctrl+B / Ctrl+Shift+E | 侧栏 / SFTP |
| Ctrl+Shift+M | 撰写窗格 |
| Ctrl+Alt+R | 开始 / 停止录制 |
| Ctrl++ / Ctrl+- / Ctrl+0 | 字号 |
| F1 / Alt+Enter / F11 | 快捷键帮助 / 全屏 |

终端里的 `Ctrl+C` 仍然发送 SIGINT。右上角的通知提示（包括连接失败）可点击关闭，
也可以按 `Esc` 关闭当前提示；连接失败时终端内的错误面板同样可按 `Esc` 关闭，
下次连接再次失败时会重新出现。有对话框或撰写窗格时 `Esc` 会优先关闭它们。

## 打包分发

```bash
npm run dist:dir        # 未压缩目录 dist/linux-unpacked（本地冒烟用）
npm run dist:linux      # AppImage + deb
npm run dist:win        # NSIS 安装包（在 Linux 上交叉构建需要 wine）
npm run dist:win:portable # 免安装单文件 exe（Linux 交叉构建无需 wine）
npm run dist:win:zip      # 免安装 zip（Linux 交叉构建无需 wine）
npm run dist:mac        # dmg + zip（需要 macOS 主机）
npm run smoke:packaged  # 无头启动 dist/linux-unpacked 并检查 preload 与界面
npm run icon            # 重新生成 build/ 下的图标（需要 Pillow）
```

产物写入 `dist/`。打包启用 ASAR 与 Electron fuses（禁用 `ELECTRON_RUN_AS_NODE`、
`NODE_OPTIONS` 和调试参数，仅从 ASAR 加载应用），并排除 `cpu-features`、ssh2 的
可选原生绑定与测试文件。串口使用的 `@serialport/bindings-cpp` N-API 预编译绑定保留在
`app.asar.unpacked` 中，可直接在 Electron ABI 下加载，无需 `electron-rebuild`。
`.github/workflows/build.yml` 会在 Ubuntu、Windows 和 macOS 上分别产出安装包；
Linux 本机构建 NSIS 需要额外安装 wine（electron-builder 会运行 32 位安装器以生成
卸载程序，因此需要 wine32）。没有 wine 时可用 `dist:win:portable` 或 `dist:win:zip`
产出免安装版本。

Windows 免安装版不需要管理员权限（可执行文件清单为 `asInvoker`）。若双击后系统要求
提权或没有窗口，通常是解压目录受策略限制（如 `Program Files`、AppLocker）或
SmartScreen 拦截未签名程序，请解压到桌面/文档等普通用户目录后再运行。HShell 采用
单实例：已有实例在运行（尤其是以管理员身份启动的实例）时，新启动会弹窗说明并退出。
窗口在创建后立即显示，不等待渲染完成。

发布前请把 `package.json` 中的 `homepage` 与维护者邮箱占位符（`example.com`）
替换为真实信息。

## 安全

- 渲染进程开启 `contextIsolation` + `sandbox`，不暴露 Node 与 `ipcRenderer`。
- IPC 参数用 zod 校验，并校验发送方。
- 会话密码默认只保存在内存；只有勾选「保存密码」时才加密写入
  `userData/credentials.json`（密钥文件 `0600`）。无系统钥匙环时使用本机绑定密钥，
  安全性弱于系统钥匙环，README 的「保存会话密码」一节有说明。私钥口令仍只留在内存。
- 保险库中的私钥使用系统密钥环或主密码（scrypt + AES-256-GCM）加密；界面进程
  只持有 `keyId`，私钥始终留在主进程。
- 只有在用户点击「安装公钥」时才会通过已连接的 SSH 会话修改远端
  `~/.ssh/authorized_keys`。
- 首次连接使用 TOFU 主机密钥确认，并读取 `~/.ssh/known_hosts` 中未哈希的条目。

## 浸泡测试（可选）

默认测试套件不包含长时间、高占用用例。发布前可手动运行：

```bash
# 20 会话 × 3 轮、16MB 终端背压、并发连接风暴、30 次连接/断开循环
HSHELL_SOAK=1 npx vitest run tests/integration/soak.test.ts

# 100MB SFTP 上传 + 下载校验和
HSHELL_SOAK_FULL=1 npx vitest run tests/integration/sftp-transfer.test.ts -t 100MB
```

两个用例均使用进程内 SSH 服务器，不会连接或修改真实的 `~/.ssh`。本机实测
100MB 往返约 11 秒；默认套件 194 个测试通过（171 个单元 + 23 个集成），另有 5 个
浸泡测试默认跳过。串口集成测试通过 `socat` 虚拟串口运行，未安装 `socat` 时自动跳过。

## 已知限制

- 认证支持密码、私钥、ssh-agent 与 keyboard-interactive；不支持 ProxyCommand、
  GSSAPI、OpenSSH 证书与 FIDO 密钥。
- 端口转发支持 `-L` / `-R` / `-D`，不支持 Unix socket 转发。
- 串口会话不支持 SFTP、端口转发与公钥安装；ZMODEM 以外的 XMODEM/YMODEM 协议未实现。
  部分适配器或 PTY 不支持设置 DTR/RTS，此类错误会被忽略而不影响连接。
- 生成的录制回放脚本需要自行安装 `ssh2` 或 `serialport`，并按脚本头部提示提供连接
  凭据（脚本不保存密码/私钥）；录制期间键入的敏感内容会写入脚本，请妥善保管。
- `keepaliveInterval=15s`、`keepaliveCountMax=3` 已启用，但 24 小时保活尚未实跑。
- Windows NSIS 与 macOS dmg 由 CI 构建；Linux 本机交叉构建 NSIS 需要 wine。
- 本地 SFTP 路径由渲染进程传入（已启用 contextIsolation/sandbox）；后续可改为
  opaque token 以进一步收紧。

## 开发计划

完整架构、阶段任务与验收标准见 [PLAN.md](PLAN.md)。
