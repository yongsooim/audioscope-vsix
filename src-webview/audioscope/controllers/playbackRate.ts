import type { AudioscopeElements } from '../core/elements';

export function normalizePlaybackRateSelection(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 1;
  }

  return numericValue;
}

interface PlaybackRateControllerDeps {
  elements: AudioscopeElements;
  state: any;
}

export function createAudioscopePlaybackRateController({ elements, state }: PlaybackRateControllerDeps) {
  function getPlaybackRateOptionButtons() {
    return Array.from(elements.playbackRateMenu.querySelectorAll<HTMLButtonElement>('.transport-rate-option'));
  }

  function getPlaybackRateLabel(value) {
    const normalizedValue = String(normalizePlaybackRateSelection(value));
    const selectedOption = Array.from(elements.playbackRateSelect.options).find((option) => option.value === normalizedValue);
    return selectedOption?.textContent?.trim() || `${normalizedValue}x`;
  }

  function syncPlaybackRateControl() {
    const normalizedValue = String(normalizePlaybackRateSelection(state.playbackRate));
    const buttonLabel = getPlaybackRateLabel(normalizedValue);

    elements.playbackRateButton.textContent = buttonLabel;
    elements.playbackRateButton.disabled = elements.playbackRateSelect.disabled;
    elements.playbackRateButton.dataset.open = state.playbackRateMenuOpen ? 'true' : 'false';
    elements.playbackRateButton.setAttribute('aria-expanded', state.playbackRateMenuOpen ? 'true' : 'false');

    for (const optionButton of getPlaybackRateOptionButtons()) {
      const isSelected = optionButton.dataset.rate === normalizedValue;
      optionButton.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      optionButton.tabIndex = isSelected ? 0 : -1;
    }
  }

  function initializePlaybackRateControl() {
    const fragment = document.createDocumentFragment();

    for (const option of Array.from(elements.playbackRateSelect.options)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'transport-rate-option';
      button.dataset.rate = option.value;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', option.selected ? 'true' : 'false');
      button.tabIndex = option.selected ? 0 : -1;
      button.textContent = option.textContent?.trim() || `${option.value}x`;
      button.addEventListener('click', () => {
        applyPlaybackRateSelection(option.value);
        closePlaybackRateMenu({ restoreFocus: true });
      });
      fragment.append(button);
    }

    elements.playbackRateMenu.replaceChildren(fragment);
    syncPlaybackRateControl();
  }

  function positionPlaybackRateMenu() {
    if (!state.playbackRateMenuOpen) {
      return;
    }

    const triggerRect = elements.playbackRateButton.getBoundingClientRect();
    const menuWidth = Math.max(Math.ceil(triggerRect.width), Math.ceil(elements.playbackRateMenu.offsetWidth || 0));
    const menuHeight = Math.ceil(elements.playbackRateMenu.offsetHeight || 0);
    const viewportPadding = 8;
    const verticalOffset = 6;
    const spaceAbove = triggerRect.top - viewportPadding;
    const spaceBelow = window.innerHeight - triggerRect.bottom - viewportPadding;
    const openAbove = spaceAbove > spaceBelow && spaceAbove >= menuHeight;
    const top = openAbove
      ? Math.max(viewportPadding, Math.round(triggerRect.top - menuHeight - verticalOffset))
      : Math.min(
        Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding),
        Math.round(triggerRect.bottom + verticalOffset),
      );
    const left = Math.min(
      Math.max(viewportPadding, Math.round(triggerRect.right - menuWidth)),
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );

    elements.playbackRateMenu.style.minWidth = `${menuWidth}px`;
    elements.playbackRateMenu.style.top = `${top}px`;
    elements.playbackRateMenu.style.left = `${left}px`;
  }

  function focusPlaybackRateOption(index) {
    const buttons = getPlaybackRateOptionButtons();

    if (buttons.length === 0) {
      return;
    }

    const normalizedIndex = Math.max(0, Math.min(index, buttons.length - 1));

    for (const [buttonIndex, optionButton] of buttons.entries()) {
      optionButton.tabIndex = buttonIndex === normalizedIndex ? 0 : -1;
    }

    buttons[normalizedIndex]?.focus();
  }

  function openPlaybackRateMenu({ focusSelected = true } = {}) {
    if (state.playbackRateMenuOpen || elements.playbackRateButton.disabled) {
      return;
    }

    state.playbackRateMenuOpen = true;
    elements.playbackRateLayer.hidden = false;
    elements.playbackRateMenu.hidden = false;
    syncPlaybackRateControl();
    positionPlaybackRateMenu();

    if (focusSelected) {
      const selectedIndex = getPlaybackRateOptionButtons()
        .findIndex((optionButton) => optionButton.dataset.rate === String(normalizePlaybackRateSelection(state.playbackRate)));
      focusPlaybackRateOption(selectedIndex >= 0 ? selectedIndex : 0);
    }
  }

  function closePlaybackRateMenu({ restoreFocus = false } = {}) {
    if (!state.playbackRateMenuOpen && elements.playbackRateMenu.hidden) {
      return;
    }

    state.playbackRateMenuOpen = false;
    elements.playbackRateLayer.hidden = true;
    elements.playbackRateMenu.hidden = true;
    elements.playbackRateMenu.style.top = '';
    elements.playbackRateMenu.style.left = '';
    elements.playbackRateMenu.style.minWidth = '';
    syncPlaybackRateControl();

    if (restoreFocus) {
      elements.playbackRateButton.focus();
    }
  }

  function togglePlaybackRateMenu() {
    if (state.playbackRateMenuOpen) {
      closePlaybackRateMenu({ restoreFocus: true });
      return;
    }

    openPlaybackRateMenu();
  }

  function applyPlaybackRateSelection(value) {
    const normalizedValue = String(normalizePlaybackRateSelection(value));

    if (elements.playbackRateSelect.value === normalizedValue) {
      syncPlaybackRateControl();
      return;
    }

    elements.playbackRateSelect.value = normalizedValue;
    elements.playbackRateSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function movePlaybackRateFocus(direction) {
    const buttons = getPlaybackRateOptionButtons();

    if (buttons.length === 0) {
      return;
    }

    const activeIndex = buttons.findIndex((button) => button === document.activeElement);
    const startIndex = activeIndex >= 0 ? activeIndex : buttons.findIndex((button) => button.dataset.rate === String(state.playbackRate));
    const nextIndex = Math.max(0, Math.min(buttons.length - 1, startIndex + direction));
    focusPlaybackRateOption(nextIndex);
  }

  function isPlaybackRateUiTarget(target) {
    return target instanceof Node
      && (
        elements.playbackRateControl.contains(target)
        || elements.playbackRateMenu.contains(target)
        || elements.playbackRateLayer.contains(target)
      );
  }

  return {
    applyPlaybackRateSelection,
    closePlaybackRateMenu,
    focusPlaybackRateOption,
    getPlaybackRateLabel,
    getPlaybackRateOptionButtons,
    initializePlaybackRateControl,
    isPlaybackRateUiTarget,
    movePlaybackRateFocus,
    openPlaybackRateMenu,
    positionPlaybackRateMenu,
    syncPlaybackRateControl,
    togglePlaybackRateMenu,
  };
}
