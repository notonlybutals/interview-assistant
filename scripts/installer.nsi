Unicode true
!include "MUI2.nsh"
!cd ".."

!define APP_NAME "面试学习助手"
!define APP_EXE "InterviewAssistant.exe"
!define APP_VERSION "1.0.3"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\InterviewAssistant"

Name "${APP_NAME}"
OutFile "release\InterviewAssistant-${APP_VERSION}-Setup-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\InterviewAssistant"
InstallDirRegKey HKCU "Software\InterviewAssistant" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!define MUI_ICON "desktop\build\icon.ico"
!define MUI_UNICON "desktop\build\icon.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "release\win-unpacked\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "--no-sandbox"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "--no-sandbox"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"

  ; Pre-create per-user data directories. Some Windows security tools block
  ; applications from creating these directories themselves on first run.
  CreateDirectory "$APPDATA\interview-assistant-desktop"
  CreateDirectory "$APPDATA\interview-assistant-desktop\backend"
  CreateDirectory "$APPDATA\interview-assistant-desktop\backend\data"
  CreateDirectory "$APPDATA\interview-assistant-desktop\log"
  CreateDirectory "$APPDATA\interview-assistant-desktop\cache"

  WriteRegStr HKCU "Software\InterviewAssistant" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "InterviewAssistant"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\InterviewAssistant"
  RMDir /r "$INSTDIR"
SectionEnd
