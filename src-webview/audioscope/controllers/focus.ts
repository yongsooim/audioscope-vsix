export function createAudioscopeFocusController() {
  function ensureKeyboardSurfaceTarget(): void {
    if (document.body.tabIndex !== -1) {
      document.body.tabIndex = -1;
    }
  }

  function focusKeyboardSurface(): void {
    if (document.visibilityState !== 'visible') {
      return;
    }

    ensureKeyboardSurfaceTarget();
    window.focus();

    if (document.activeElement !== document.body) {
      document.body.focus({ preventScroll: true });
    }
  }

  function scheduleKeyboardSurfaceFocus(): void {
    queueMicrotask(() => {
      window.requestAnimationFrame(() => {
        focusKeyboardSurface();
      });
    });
  }

  function initializeKeyboardSurfaceFocus(): void {
    ensureKeyboardSurfaceTarget();
    scheduleKeyboardSurfaceFocus();
    window.setTimeout(() => {
      focusKeyboardSurface();
    }, 120);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        scheduleKeyboardSurfaceFocus();
      }
    });
  }

  function isTextEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
      return true;
    }

    return target.closest('textarea') instanceof HTMLTextAreaElement;
  }

  function preventPointerFocus(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    event.preventDefault();
  }

  return {
    initializeKeyboardSurfaceFocus,
    isTextEditableTarget,
    preventPointerFocus,
    scheduleKeyboardSurfaceFocus,
  };
}
