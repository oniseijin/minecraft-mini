/**
 * Minimal Minecraft-style chat UI: the last 8 messages stack bottom-left and
 * each fades out a few seconds after arrival; opening the input holds the
 * whole history visible. The caller (main.ts) owns pointer lock — it releases
 * it around open() and restores it in onClose() — this module is DOM-only.
 */

const MAX_MESSAGES = 8;
const MESSAGE_FADE_MS = 6000;
const HISTORY_CAP = 40;

export interface ChatUiOptions {
  /** Scrollback container (#chat-log). */
  log: HTMLElement;
  /** Input row (#chat-box), hidden while the chat is closed. */
  box: HTMLElement;
  input: HTMLInputElement;
  /** Called with the trimmed text when the player sends a message. */
  send(text: string): void;
  /** After send/Escape removed the input from the DOM flow. */
  onClose(): void;
}

export interface ChatMessage {
  from: string;
  text: string;
}

export interface ChatUi {
  readonly isOpen: boolean;
  open(): void;
  /** `send` false = cancel (Esc), true = send the current text (Enter). */
  close(send: boolean): void;
  addMessage(from: string, text: string): void;
  dispose(): void;
}

export function createChatUi(options: ChatUiOptions): ChatUi {
  const { log, box, input, send, onClose } = options;
  let isOpen = false;
  const fadeTimers = new Map<Element, number>();
  /** Recent messages, oldest first (tests / debugging; capped). */
  const history: ChatMessage[] = [];

  function onInputKey(event: KeyboardEvent): void {
    event.stopPropagation(); // never leak into the game's key handlers
    if (event.code === 'Enter') handleClose(true);
    else if (event.code === 'Escape') handleClose(false);
  }

  input.addEventListener('keydown', onInputKey);

  function setOpen(next: boolean): void {
    isOpen = next;
    box.classList.toggle('hidden', !next);
    log.classList.toggle('open', next);
    if (next) {
      input.value = '';
      input.focus();
    } else {
      input.blur();
    }
  }

  function handleClose(shouldSend: boolean): void {
    if (!isOpen) return;
    const text = input.value.trim();
    setOpen(false);
    if (shouldSend && text.length > 0) send(text);
    onClose();
  }

  return {
    get isOpen() {
      return isOpen;
    },
    open() {
      if (isOpen) return;
      setOpen(true);
    },
    close(shouldSend: boolean) {
      handleClose(shouldSend);
    },
    addMessage(from, text) {
      const line = document.createElement('div');
      line.className = 'msg';
      line.textContent = `${from}: ${text}`;
      log.appendChild(line);
      while (log.children.length > MAX_MESSAGES) {
        const oldest = log.firstElementChild;
        if (!oldest) break;
        const timer = fadeTimers.get(oldest);
        if (timer !== undefined) {
          clearTimeout(timer);
          fadeTimers.delete(oldest);
        }
        oldest.remove();
      }
      const timer = window.setTimeout(() => {
        line.classList.add('faded');
        fadeTimers.delete(line);
      }, MESSAGE_FADE_MS);
      fadeTimers.set(line, timer);
      history.push({ from, text });
      if (history.length > HISTORY_CAP) history.shift();
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
