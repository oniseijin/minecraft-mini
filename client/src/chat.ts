/**
 * Minecraft-classic chat log + modern keep-open input: Enter/T opens the input
 * with the recent history stacked above it — non-fading, scrollable (wheel +
 * PageUp/PageDown) while open. Enter SENDS and keeps the chat open (input
 * clears and keeps focus); an empty Enter or Esc closes it, and the caller
 * (main.ts) re-locks the pointer. While the chat is closed only the last few
 * messages show, each fading out ~10 s after it arrived; opening re-renders
 * the full recent history from the ~50-message buffer. Sender names render in
 * the player's stable identity color (identity.ts); system lines (join/leave)
 * are dimmer and prefix-free. The local player's own messages render as
 * "You:". This module is DOM-only — main.ts owns pointer lock around
 * open()/close().
 */

const MAX_DOM_CLOSED = 5; // messages visible while the chat is closed
const MAX_DOM_OPEN = 15; // messages visible while open (scrollable)
const HISTORY_CAP = 50; // messages kept for reopening
const MESSAGE_FADE_MS = 10000; // fade only applies while the chat is closed
const SCROLL_STEP = 96; // px per PageUp/PageDown

export interface ChatUiOptions {
  /** Scrollback container (#chat-log). */
  log: HTMLElement;
  /** Input row (#chat-box), hidden while the chat is closed. */
  box: HTMLElement;
  input: HTMLInputElement;
  /** Called with the trimmed text when the player sends a message. */
  send(text: string): void;
  /** After Escape/empty-Enter removed the input from the DOM flow. */
  onClose(): void;
  /** Current local player name — own messages render as "You:". */
  selfName(): string;
}

export interface ChatMessage {
  from: string;
  text: string;
  /** Per-player identity color for the sender name (identity.ts). */
  color?: string;
  /** System lines (join/leave): dimmer, no sender color, not "own". */
  system?: boolean;
}

export interface ChatUi {
  readonly isOpen: boolean;
  open(): void;
  /** Esc / empty-Enter: hides the input; the caller re-locks the pointer. */
  close(): void;
  addMessage(from: string, text: string, opts?: { color?: string; system?: boolean }): void;
  dispose(): void;
}

export function createChatUi(options: ChatUiOptions): ChatUi {
  const { log, box, input, send, onClose } = options;
  let isOpen = false;
  const fadeTimers = new Map<Element, number>();
  /** Message buffer, oldest first (source of truth for re-rendering). */
  const history: ChatMessage[] = [];

  const isOwn = (msg: ChatMessage): boolean => !msg.system && msg.from === options.selfName();

  function lineFor(msg: ChatMessage): HTMLDivElement {
    const line = document.createElement('div');
    line.className = 'msg';
    if (isOwn(msg)) line.classList.add('own');
    if (msg.system) line.classList.add('system');
    const from = document.createElement('span');
    from.className = 'from';
    from.textContent = msg.system ? '' : `${isOwn(msg) ? 'You' : msg.from}:`;
    if (msg.color && !isOwn(msg)) from.style.color = msg.color;
    if (msg.system) {
      line.textContent = msg.text; // "✦ Steve joined" — no sender prefix
      return line;
    }
    line.append(from, ` ${msg.text}`);
    return line;
  }

  function clearFade(line: Element): void {
    const timer = fadeTimers.get(line);
    if (timer !== undefined) {
      clearTimeout(timer);
      fadeTimers.delete(line);
    }
  }

  /** Trims the DOM to `limit` oldest-first and (re)arms fade timers only while closed. */
  function trimDom(limit: number): void {
    while (log.children.length > limit) {
      const oldest = log.firstElementChild;
      if (!oldest) break;
      clearFade(oldest);
      oldest.remove();
    }
    if (limit > MAX_DOM_CLOSED) {
      for (const line of log.children) clearFade(line);
    }
  }

  function armFade(line: HTMLElement): void {
    if (isOpen) return; // history never fades while the chat is open
    const timer = window.setTimeout(() => {
      line.classList.add('faded');
      fadeTimers.delete(line);
    }, MESSAGE_FADE_MS);
    fadeTimers.set(line, timer);
  }

  function scrollBottom(): void {
    log.scrollTop = log.scrollHeight;
  }

  /** Full re-render of the recent history (on open). */
  function render(): void {
    log.replaceChildren();
    for (const msg of history.slice(-MAX_DOM_OPEN)) log.appendChild(lineFor(msg));
  }

  function onInputKey(event: KeyboardEvent): void {
    event.stopPropagation(); // never leak into the game's key handlers
    if (event.code === 'Enter') {
      const text = input.value.trim();
      if (text.length > 0) {
        input.value = '';
        send(text); // Enter sends and KEEPS the chat open for the next line
        input.focus();
      } else {
        closeInternal(); // empty Enter just closes
      }
    } else if (event.code === 'Escape') {
      closeInternal();
    } else if (event.code === 'PageUp' || event.code === 'PageDown') {
      event.preventDefault();
      log.scrollBy({ top: event.code === 'PageUp' ? -SCROLL_STEP : SCROLL_STEP });
    }
  }

  input.addEventListener('keydown', onInputKey);

  /** Closed-state input row hiding + pointer re-lock callback. */
  function closeInternal(): void {
    if (!isOpen) return;
    isOpen = false;
    box.classList.toggle('hidden', true);
    log.classList.toggle('open', false);
    trimDom(MAX_DOM_CLOSED); // back to the few-lines fading view
    input.blur();
    onClose();
  }

  return {
    get isOpen() {
      return isOpen;
    },
    open() {
      if (isOpen) return;
      isOpen = true;
      box.classList.toggle('hidden', false);
      log.classList.toggle('open', true);
      render(); // reveal the recent history (fade classes are overridden while open)
      input.value = '';
      input.focus();
      scrollBottom();
    },
    close() {
      closeInternal();
    },
    addMessage(from, text, opts) {
      const msg: ChatMessage = { from, text, ...opts };
      history.push(msg);
      if (history.length > HISTORY_CAP) history.shift();

      const line = lineFor(msg);
      log.appendChild(line);
      trimDom(isOpen ? MAX_DOM_OPEN : MAX_DOM_CLOSED);
      armFade(line);
      if (isOpen) scrollBottom();
    },
    dispose() {
      input.removeEventListener('keydown', onInputKey);
      for (const timer of fadeTimers.values()) clearTimeout(timer);
      fadeTimers.clear();
      log.replaceChildren();
      history.length = 0;
    },
  };
}
