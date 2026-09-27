/**
 * Connection + sync for LAN play (DESIGN.md §3.2). Owns the WebSocket to the
 * game server, the join handshake (hello → welcome), reconnection policy and
 * the offline fallback:
 *
 * - First connect fails (no server reachable) → OFFLINE MODE: the client plays
 *   solo on the local seed while `net` keeps retrying in the background every
 *   15 s. A later successful handshake heals the session online (the caller
 *   can reject a mismatched-world welcome via `acceptWelcome`).
 * - A connection that was online drops → same offline state, but retrying with
 *   a 1 s → 5 s exponential backoff.
 *
 * Incoming frames are parsed/validated with the shared protocol parsers and
 * forwarded via `onMessage`; outgoing move/chat/edit sends are fire-and-forget
 * (the server validates edits authoritatively and echoes corrections).
 */

import {
  parseServerMessage,
  type PlayerSnapshot,
  type ServerMessage,
  type WelcomeMsg,
} from '@mc/shared';

/** 'connecting' is only the very first state; everything else is online/offline. */
export type NetMode = 'connecting' | 'online' | 'offline';

export interface NetOptions {
  /** Absolute ws(s):// URL of the game server's /ws endpoint. */
  url: string;
  /** Name sent with hello (already the client's best guess; server sanitizes). */
  name: string;
  /** Every parsed, accepted server message (welcome/players/blockEdits/chat/left). */
  onMessage(msg: ServerMessage): void;
  /** Mode transitions (connecting → offline on first failure, etc). */
  onMode(mode: NetMode): void;
  /**
   * Gate for welcomes after the first: returning false (e.g. different world
   * seed) closes the socket and stays offline until the next retry.
   */
  acceptWelcome?(msg: WelcomeMsg): boolean;
}

export interface Net {
  readonly mode: NetMode;
  readonly connected: boolean;
  /** Server-assigned id; null until (re)connected. May change across reconnects. */
  readonly playerId: number | null;
  /** Server-sanitized name after welcome, otherwise the locally chosen name. */
  readonly name: string;
  /** Latest roster snapshot as reported by the server (may include self). */
  readonly players: readonly PlayerSnapshot[];
  /** Updates the name; while online this silently re-joins so others see it. */
  setName(name: string): void;
  sendMove(x: number, y: number, z: number, yaw: number, pitch: number): void;
  sendBlockEdit(x: number, y: number, z: number, id: number): void;
  sendChat(text: string): void;
  dispose(): void;
}

/** How long the very first handshake may take before falling back to offline. */
const FIRST_CONNECT_TIMEOUT_MS = 3500;
/** Background retry cadence while in offline mode. */
const OFFLINE_RETRY_MS = 15000;
/** Reconnect backoff after having been online: 1 s doubling to a 5 s cap. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 5000;

export function createNet(options: NetOptions): Net {
  let ws: WebSocket | null = null;
  let mode: NetMode = 'connecting';
  let everWelcomed = false; // once true, world/gen exists — never "first connect" again
  let playerId: number | null = null;
  let name = options.name;
  let players: PlayerSnapshot[] = [];
  let backoffMs = RECONNECT_MIN_MS;
  let retryTimer: number | undefined;
  let firstTimer: number | undefined;
  let disposed = false;

  function setMode(next: NetMode): void {
    if (mode === next) return;
    mode = next;
    options.onMode(next);
  }

  function clearTimers(): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (firstTimer !== undefined) {
      clearTimeout(firstTimer);
      firstTimer = undefined;
    }
  }

  /** Detaches handlers and closes the current socket without triggering retries. */
  function closeSocket(): void {
    const socket = ws;
    ws = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }

  function enterOffline(): void {
    clearTimers();
    closeSocket();
    setMode('offline');
    // Silent for a minute → server down; play locally, keep poking it.
    const delay = everWelcomed ? backoffMs : OFFLINE_RETRY_MS;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      open();
    }, delay);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }

  function sendHello(socket: WebSocket): void {
    socket.send(JSON.stringify({ type: 'hello', name }));
  }

  function open(): void {
    if (disposed) return;
    clearTimers();
    closeSocket();

    const socket = new WebSocket(options.url);
    ws = socket;
    let welcomedHere = false;

    // Covers proxies that accept the TCP connection but never complete the
    // handshake (browsers only fire close/error on hard failures).
    firstTimer = window.setTimeout(() => {
      firstTimer = undefined;
      if (!welcomedHere && socket === ws) enterOffline();
    }, FIRST_CONNECT_TIMEOUT_MS);

    socket.onopen = () => sendHello(socket);

    socket.onmessage = (event: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const msg = parseServerMessage(data);
      if (!msg) return;

      if (msg.type === 'welcome') {
        if (!everWelcomed) {
          everWelcomed = true;
        } else if (options.acceptWelcome && !options.acceptWelcome(msg)) {
          // Wrong world (e.g. server restarted with another seed): stay offline.
          enterOffline();
          return;
        }
        welcomedHere = true;
        if (firstTimer !== undefined) {
          clearTimeout(firstTimer);
          firstTimer = undefined;
        }
        playerId = msg.playerId;
        name = msg.name;
        players = msg.players;
        backoffMs = RECONNECT_MIN_MS;
        setMode('online');
      } else if (msg.type === 'players') {
        players = msg.players;
      }
      options.onMessage(msg);
    };

    socket.onclose = () => {
      if (socket !== ws) return; // superseded by closeSocket()/open()
      ws = null;
      enterOffline();
    };
    socket.onerror = () => undefined; // close always follows
  }

  function send(payload: object): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  open();

  return {
    get mode() {
      return mode;
    },
    get connected() {
      return mode === 'online';
    },
    get playerId() {
      return playerId;
    },
    get name() {
      return name;
    },
    get players() {
      return players;
    },
    setName(next: string) {
      const trimmed = next.trim();
      if (trimmed.length === 0 || trimmed === name) return;
      name = trimmed;
      if (mode === 'online') {
        // Re-join under the new name (server hands out a fresh id).
        closeSocket();
        open();
      }
    },
    sendMove(x, y, z, yaw, pitch) {
      send({ type: 'move', x, y, z, yaw, pitch });
    },
    sendBlockEdit(x, y, z, id) {
      send({ type: 'blockEdit', x, y, z, id });
    },
    sendChat(text) {
      send({ type: 'chat', text });
    },
    dispose() {
      disposed = true;
      clearTimers();
      closeSocket();
    },
  };
}

/** ws endpoint for the current page: same host, wss on https origins. */
export function wsUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}
