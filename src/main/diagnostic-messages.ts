/**
 * Text and command-line helpers for startup diagnostics. Kept free of Electron
 * imports so they can be unit tested without a display server.
 */

export interface LaunchFailureContext {
  /** Directory that contains the HShell executable. */
  appDir: string
  /** Directory where startup.log and renderer-errors.log are written. */
  logDir: string
  reason: string
  exitCode: number
}

/**
 * Windows checks the restricted renderer token against the DACL of the install
 * directory. A portable build extracted by hand inherits no ACE for Chromium's
 * AppContainer SIDs, so the sandboxed renderer cannot load its own DLLs and the
 * process launch fails before any renderer code runs.
 */
export function aclFixCommand(appDir: string): string {
  return `icacls "${appDir}" /grant "*S-1-15-2-1:(OI)(CI)(RX)" "*S-1-15-2-2:(OI)(CI)(RX)" /T`
}

export function launchFailureMessage(context: LaunchFailureContext): string {
  return [
    `渲染进程启动失败（reason=${context.reason}，exitCode=${context.exitCode}）。`,
    '',
    '这通常不是安装文件损坏，而是 Windows 的 Chromium 沙箱无法读取 HShell 所在目录。',
    '请用管理员权限打开“命令提示符”，执行下面的命令（只授予读取和执行权限）：',
    '',
    aclFixCommand(context.appDir),
    '',
    '然后结束所有 HShell.exe 进程，用普通权限重新启动。',
    '临时验证：以管理员身份运行 HShell 可以绕开该限制。',
    '',
    `诊断日志目录：${context.logDir}（startup.log、renderer-errors.log）`
  ].join('\n')
}
