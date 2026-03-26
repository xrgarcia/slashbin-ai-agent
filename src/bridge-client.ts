import WebSocket from "ws";
import type { Logger } from "./logger.js";

export interface BridgeConfig {
  url: string;           // ws://localhost:9800
  agentId: string;       // "foreman"
  discordBotId: string;  // Discord bot user ID
  channels: {
    status: string;      // Channel for status updates
    listen: string[];    // Channels to receive commands from
  };
}

export interface IncomingCommand {
  type: "command";
  channelId: string;
  userId: string;
  username: string;
  text: string;
  messageId: string;
  attachments: { filename: string; url: string; contentType: string }[];
}

type CommandHandler = (command: IncomingCommand) => void;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private config: BridgeConfig;
  private logger: Logger;
  private reconnectMs = 5000;
  private maxReconnectMs = 60000;
  private connected = false;
  private commandHandler: CommandHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(config: BridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: "BridgeClient" });
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  connect(): void {
    if (this.shuttingDown) return;

    try {
      this.ws = new WebSocket(this.config.url);
    } catch (err) {
      this.logger.warn("Failed to create WebSocket connection, will retry", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectMs = 5000; // reset backoff

      // Send handshake
      this.ws!.send(JSON.stringify({
        type: "handshake",
        agentId: this.config.agentId,
        discordBotId: this.config.discordBotId,
        channels: this.config.channels,
      }));

      this.logger.info("Connected to Discord bridge");
    });

    this.ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "ping") {
        this.ws?.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type === "handshake_ack") {
        if (msg.success) {
          this.logger.info("Handshake accepted", { connectedAgents: msg.connectedAgents });
        } else {
          this.logger.error("Handshake rejected", { error: msg.error });
        }
        return;
      }

      if (msg.type === "command" && this.commandHandler) {
        this.commandHandler(msg as unknown as IncomingCommand);
        return;
      }
    });

    this.ws.on("close", () => {
      this.connected = false;
      if (!this.shuttingDown) {
        this.logger.warn("Disconnected from Discord bridge, reconnecting...");
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      this.logger.debug("WebSocket error", { error: err.message });
      // close event will fire after this, triggering reconnect
    });
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);

    this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs);
  }

  sendStatus(text: string, level: "info" | "warn" | "error" = "info"): void {
    if (!this.connected || !this.ws) return;
    try {
      this.ws.send(JSON.stringify({ type: "status", text, level }));
    } catch { /* ignore — will reconnect */ }
  }

  sendResponse(channelId: string, text: string, replyTo?: string): void {
    if (!this.connected || !this.ws) return;
    try {
      this.ws.send(JSON.stringify({
        type: "response",
        channelId,
        replyTo,
        text,
      }));
    } catch { /* ignore */ }
  }

  sendTyping(channelId: string): void {
    if (!this.connected || !this.ws) return;
    try {
      this.ws.send(JSON.stringify({ type: "typing", channelId }));
    } catch { /* ignore */ }
  }

  isConnected(): boolean {
    return this.connected;
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
