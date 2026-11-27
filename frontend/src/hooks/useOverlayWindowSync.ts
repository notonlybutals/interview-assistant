import { useEffect, useRef } from 'react'
import { useUiPrefsStore } from '@/stores/uiPrefsStore'

export function useOverlayWindowSync(_isRecording: boolean, _appMode: string) {
  void _isRecording
  void _appMode
  const interviewOverlayEnabled = useUiPrefsStore((s) => s.interviewOverlayEnabled)
  const interviewOverlayOpacity = useUiPrefsStore((s) => s.interviewOverlayOpacity)
  const interviewOverlayFontSize = useUiPrefsStore((s) => s.interviewOverlayFontSize)
  const interviewOverlayFontColor = useUiPrefsStore((s) => s.interviewOverlayFontColor)
  const interviewOverlayShowBg = useUiPrefsStore((s) => s.interviewOverlayShowBg)
  const interviewOverlayMode = useUiPrefsStore((s) => s.interviewOverlayMode)
  const interviewOverlayFocusWidthPct = useUiPrefsStore((s) => s.interviewOverlayFocusWidthPct)
  const interviewOverlayFocusHeightPct = useUiPrefsStore((s) => s.interviewOverlayFocusHeightPct)
  const interviewOverlayPromptMaxWidth = useUiPrefsStore((s) => s.interviewOverlayPromptMaxWidth)
  const interviewOverlayPromptAutoFollow = useUiPrefsStore((s) => s.interviewOverlayPromptAutoFollow)
  const interviewOverlayMaxLines = useUiPrefsStore((s) => s.interviewOverlayMaxLines)
  const applyInterviewOverlayState = useUiPrefsStore((s) => s.applyInterviewOverlayState)

  const overlaySyncUntilRef = useRef(0)
  const prevEnabledRef = useRef(interviewOverlayEnabled)

  useEffect(() => {
    if (!window.electronAPI?.syncOverlayWindow) return
    overlaySyncUntilRef.current = Date.now() + 500

    const payload: Record<string, unknown> = {
      enabled: interviewOverlayEnabled,
      opacity: interviewOverlayOpacity,
      fontSize: interviewOverlayFontSize,
      fontColor: interviewOverlayFontColor,
      showBg: interviewOverlayShowBg,
      mode: interviewOverlayMode,
      focusWidthPct: interviewOverlayFocusWidthPct,
      focusHeightPct: interviewOverlayFocusHeightPct,
      promptMaxWidth: interviewOverlayPromptMaxWidth,
      promptAutoFollow: interviewOverlayPromptAutoFollow,
      maxLines: interviewOverlayMaxLines,
    }

    // enabled OFF → force hide overlay + show main window
    if (prevEnabledRef.current && !interviewOverlayEnabled) {
      payload.visible = false
    }
    prevEnabledRef.current = interviewOverlayEnabled

    window.electronAPI.syncOverlayWindow(payload).catch(() => {})
  }, [
    interviewOverlayEnabled,
    interviewOverlayOpacity,
    interviewOverlayFontSize,
    interviewOverlayFontColor,
    interviewOverlayShowBg,
    interviewOverlayMode,
    interviewOverlayFocusWidthPct,
    interviewOverlayFocusHeightPct,
    interviewOverlayPromptMaxWidth,
    interviewOverlayPromptAutoFollow,
    interviewOverlayMaxLines,
  ])

  useEffect(() => {
    return () => {
      const destroyOverlay = window.electronAPI?.destroyOverlay
      if (destroyOverlay) {
        destroyOverlay().catch(() => {})
      }
    }
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.onOverlayState) return
    const removeOverlayListener = window.electronAPI.onOverlayState((payload) => {
      // 500ms 内是主进程回显我们自己的样式 sync；但「可见性」是主进程/悬浮窗侧
      // 发起的状态变化（例如点了悬浮窗的 × 关闭按钮），必须立即接受，否则前端仍
      // 认为悬浮窗是打开的，下一次 Ctrl+O 会被当成「关闭」→ 看起来像 Ctrl+B。
      if (Date.now() < overlaySyncUntilRef.current) {
        if (typeof payload.visible === 'boolean') {
          const current = useUiPrefsStore.getState().interviewOverlayVisible
          if (current !== payload.visible) {
            applyInterviewOverlayState(payload, { persistStyle: false })
          }
        }
        return
      }
      applyInterviewOverlayState(payload, { persistStyle: true })
    })
    return () => removeOverlayListener?.()
  }, [applyInterviewOverlayState])
}
