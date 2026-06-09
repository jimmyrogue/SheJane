; Custom NSIS include for the SheJane (石间) Windows installer.
;
; Why this exists: the app runs on Electron 33, which requires Windows 10+.
; Electron 23 dropped Windows 7/8/8.1 support entirely. Without this guard a
; Win7 user gets a cryptic "未指定的错误" while the installer creates the Start
; Menu shortcut, the app installs anyway, and then it silently fails to launch
; (Electron 33 can't run on Win7). We refuse EARLY with a clear message instead.
;
; WinVer.nsh ships with NSIS (bundled by electron-builder's makensis) and uses
; RtlGetVersion under the hood, so ${AtLeastWin10} reports correctly even though
; an unmanifested installer would otherwise see a spoofed Win8 version number.
;
; Wired in via electron-builder.yml -> nsis.include: build/installer.nsh.
; electron-builder invokes the `customInit` macro from its generated `.onInit`.

!include "WinVer.nsh"

!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST \
      "石间 需要 Windows 10 或更高版本，无法在当前系统上安装。$\r$\n$\r$\n\
请升级到 Windows 10 / 11（64 位）后重试。"
    Quit
  ${EndIf}
!macroend
