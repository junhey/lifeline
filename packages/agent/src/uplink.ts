import type { Socket } from 'socket.io-client';
import type { IdeKind } from '../../protocol/src/index.js';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { io } from 'socket.io-client';
import { BUILD_VERSION } from '../../cli/src/build-version.js';
import { SOCKET_MAX_HTTP_BUFFER_SIZE, toAgentPlatform } from '../../protocol/src/index.js';
import { timingLastBubble, timingLog, timingPreview } from './timing-log.js';
import { UplinkWatchdog } from './uplink-watchdog.js';

/**
 * Outbound connection from the local agent to the remote server's /agent
 * namespace. Mirrors AgentHub on the server side:
 *
 *   upstream (agent -> server): agent:register, state:full, state:patch,
 *                               connection:status, command:result
 *   downstream (server -> agent): command:* (see COMMAND_EVENTS)
 *
 * Reconnection is handled by socket.io-client itself (1s -> 30s backoff).
 * When that is not enough — a reconnect-error loop that never recovers, or an
 * inert socket after a server-initiated disconnect where socket.io-client
 * stops reconnecting entirely — the UplinkWatchdog tears the whole stack down
 * and rebuilds it, which is what a process restart provides (issue #1).
 */
export interface UplinkOptions {
  /** Test seam: socket factory (default: socket.io-client `io`). */
  socketFactory?: (url: string, opts: Parameters<typeof io>[1]) => Socket;
  /** Test seams; production defaults live in uplink-watchdog.ts. */
  watchdogThresholdMs?: number;
  watchdogMaxThresholdMs?: number;
}

const ts = () => new Date().toISOString();

export class Uplink extends EventEmitter {
  private socket: Socket;
  private socketFactory: (url: string, opts: Parameters<typeof io>[1]) => Socket;
  private agentId: string;
  private agentToken: string;
  private remoteUrl: string;
  private liveIdes: IdeKind[] | undefined;
  /** Whether this machine is content-source only (Linux). Older servers ignore it. */
  private contentSource: boolean | undefined;
  private watchdog: UplinkWatchdog;

  constructor(
    remoteUrl: string,
    agentToken: string,
    agentId: string,
    liveIdes?: IdeKind[],
    contentSource?: boolean,
    options?: UplinkOptions,
  ) {
    super();
    this.agentId = agentId;
    this.agentToken = agentToken;
    this.liveIdes = liveIdes;
    this.contentSource = contentSource;
    this.remoteUrl = remoteUrl.replace(/\/+$/, '');
    this.socketFactory = options?.socketFactory ?? io;
    this.socket = this.createSocket();

    this.watchdog = new UplinkWatchdog({
      thresholdMs: options?.watchdogThresholdMs,
      maxThresholdMs: options?.watchdogMaxThresholdMs,
      onStuck: () => this.rebuild(),
      log: msg => console.warn(`[uplink] ${ts()} watchdog: ${msg}`),
    });

    this.attachSocketHandlers(this.socket);
  }

  private createSocket(): Socket {
    return this.socketFactory(`${this.remoteUrl}/agent`, {
      path: '/agent-io',
      auth: { agentToken: this.agentToken },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 60_000,
      // engine.io option; socket.io-client's ManagerOptions omits it.
      maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
      // `io()` caches managers by URL; a rebuild must never reuse a wedged
      // one. forceNew = a fresh Manager, which is what a process restart gets.
      forceNew: true,
    } as Parameters<typeof io>[1]);
  }

  private attachSocketHandlers(socket: Socket): void {
    socket.on('connect', () => {
      console.log(`[uplink] ${ts()} Connected to ${this.remoteUrl} (${socket.id})`);
      // The console uses this to send uninstall/upgrade commands for **this
      // machine** — the person on the web may be on a different OS, so the
      // platform must be self-reported by the machine, not guessed from the
      // browser UA. Omit if unrecognized; the web falls back to OS toggles.
      const platform = toAgentPlatform(process.platform);
      socket.emit('agent:register', {
        agentId: this.agentId,
        hostname: hostname(),
        // Server stores this so the web can show "which version this box is"; older servers ignore it.
        version: BUILD_VERSION,
        ...(this.liveIdes !== undefined ? { liveIdes: this.liveIdes } : {}),
        ...(platform !== undefined ? { platform } : {}),
        // This machine is content-source only (Linux). The server uses this to
        // file it under "content sources".
        // The criterion is the **platform**, not "app not found in the
        // inventory" — that would misclassify a normal install as a content
        // source (review R1).
        ...(this.contentSource !== undefined ? { contentSource: this.contentSource } : {}),
      });
      this.emit('connected');
      this.watchdog.notifyConnected();
    });

    socket.on('disconnect', (reason) => {
      console.warn(`[uplink] ${ts()} Disconnected (${reason})`);
      // Any reason arms the watchdog — including "io server disconnect",
      // where socket.io-client stops reconnecting on its own and only a
      // rebuild recovers (see docs/plans/2026-10-04-uplink-watchdog-design.md).
      this.watchdog.notifyDisconnected();
      this.emit('disconnected');
    });

    socket.on('connect_error', (err) => {
      console.warn(`[uplink] ${ts()} Connection error: ${err.message}`);
      this.watchdog.notifyConnectError();
    });

    // Forward inbound command:* and session:get so attachCommandHandlers / runtime
    // can subscribe to this object like they do to a browser socket.
    socket.onAny((event, ...args) => {
      if (typeof event === 'string' && (event.startsWith('command:') || event === 'session:get')) {
        const payload = args[0] as { commandId?: string; ide?: string; text?: string; sessionId?: string } | undefined;
        timingLog('uplink:in', {
          event,
          commandId: payload?.commandId,
          ide: payload?.ide,
          sessionId: payload?.sessionId,
          chars: payload?.text?.length,
          preview: payload?.text ? timingPreview(payload.text) : undefined,
        });
        this.emit(event, ...args);
      }
    });

    // Server asks for a fresh snapshot after this agent is promoted to active.
    socket.on('agent:sync', (payload?: { reason?: string }) => {
      console.log(`[uplink] ${ts()} Server requested state sync${payload?.reason ? ` (${payload.reason})` : ''}`);
      this.emit('sync', payload);
    });

    socket.on('agent:rejected', () => {
      this.emit('rejected');
    });
  }

  /**
   * Watchdog fire: the socket has been continuously disconnected longer than
   * the current threshold. Tear the whole stack down and start over — equal to
   * what a process restart provides. Never throws: a failure here leaves
   * recovery to the next watchdog cycle.
   */
  private rebuild(): void {
    const old = this.socket;
    try {
      old.removeAllListeners();
      // Socket.disconnect() → Manager._destroy → (last active socket) _close():
      // sets skipReconnect, clears the reconnect timer, closes the engine. No
      // zombie reconnection loop is left behind.
      old.disconnect();
    }
    catch (err) {
      console.warn(`[uplink] ${ts()} watchdog: old socket teardown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.socket = this.createSocket();
    this.attachSocketHandlers(this.socket);
    console.warn(`[uplink] ${ts()} watchdog: rebuilt connection (fresh manager)`);
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  send(event: string, payload: unknown): void {
    if (
      event === 'command:result'
      || event === 'session:full'
      || event === 'session:append'
      || event === 'session:patch'
      || event === 'session:missing'
    ) {
      const body = payload as {
        commandId?: string;
        ok?: boolean;
        error?: string;
        sessionId?: string;
        ide?: string;
        seq?: number;
        messages?: unknown[];
      };
      timingLog('uplink:out', {
        event,
        commandId: body.commandId,
        ok: body.ok,
        error: body.error,
        sessionId: body.sessionId,
        ide: body.ide,
        n: body.messages?.length,
        seq: body.seq,
        last: body.messages ? timingLastBubble(body.messages as Array<{ type?: string; text?: string }>) || undefined : undefined,
      });
    }
    this.socket.emit(event, payload);
  }

  disconnect(): void {
    this.watchdog.stop();
    this.socket.disconnect();
  }
}
