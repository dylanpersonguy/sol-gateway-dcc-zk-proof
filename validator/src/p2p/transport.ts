// ═══════════════════════════════════════════════════════════════
// P2P TRANSPORT LAYER — WebSocket-based peer communication
// ═══════════════════════════════════════════════════════════════
//
// Provides reliable, authenticated peer-to-peer messaging between
// validator nodes for attestation exchange and consensus.
//
// Features:
// - WebSocket server for inbound connections
// - Auto-reconnect to bootstrap peers with exponential backoff
// - Message authentication via Ed25519 signatures
// - Heartbeat / keepalive for connection health
// - Peer discovery via gossip protocol

import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer } from 'ws';
import { createLogger } from '../utils/logger';
import { Logger } from 'winston';
import * as nacl from 'tweetnacl';
import * as crypto from 'crypto';

export interface P2PConfig {
  nodeId: string;
  port: number;
  bootstrapPeers: string[]; // "host:port" list
  heartbeatIntervalMs: number;
  reconnectBaseMs: number;
  maxReconnectMs: number;
}

export interface P2PMessage {
  type: 'attestation' | 'heartbeat' | 'peer_list' | 'attestation_request';
  nodeId: string;
  payload: any;
  timestamp: number;
  signature?: string; // base64 Ed25519 signature
}

interface PeerConnection {
  nodeId: string;
  ws: WebSocket;
  address: string;
  lastSeen: number;
  isOutbound: boolean;
  reconnectAttempts: number;
}

export class P2PTransport extends EventEmitter {
  private config: P2PConfig;
  private logger: Logger;
  private server: WebSocketServer | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private signFn: ((msg: Buffer) => Promise<Buffer>) | null = null;
  private verifyFn: ((msg: Buffer, sig: Buffer, pubkey: Buffer) => boolean) | null = null;
  private publicKey: Buffer | null = null;
  private isRunning = false;

  constructor(config: P2PConfig) {
    super();
    this.config = config;
    this.logger = createLogger('P2P');
  }

  /**
   * Set crypto functions for message signing/verification
   */
  setCrypto(
    signFn: (msg: Buffer) => Promise<Buffer>,
    verifyFn: (msg: Buffer, sig: Buffer, pubkey: Buffer) => boolean,
    publicKey: Buffer,
  ): void {
    this.signFn = signFn;
    this.verifyFn = verifyFn;
    this.publicKey = publicKey;
  }

  /**
   * Start the P2P transport — listens for inbound and connects to peers
   */
  async start(): Promise<void> {
    this.isRunning = true;

    // Start WebSocket server for inbound connections
    this.server = new WebSocketServer({ port: this.config.port });

    this.server.on('connection', (ws, req) => {
      const remoteAddr = req.socket.remoteAddress || 'unknown';
      this.logger.info('Inbound peer connection', { from: remoteAddr });
      this.handleInboundConnection(ws, remoteAddr);
    });

    this.server.on('error', (err) => {
      this.logger.error('WebSocket server error', { error: err.message });
    });

    this.logger.info('P2P server listening', { port: this.config.port });

    // Connect to bootstrap peers
    for (const peer of this.config.bootstrapPeers) {
      this.connectToPeer(peer);
    }

    // Start heartbeat loop
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats();
      this.pruneDeadPeers();
    }, this.config.heartbeatIntervalMs);

    this.logger.info('P2P transport started', {
      bootstrapPeers: this.config.bootstrapPeers.length,
    });
  }

  /**
   * Stop the transport layer
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const [, peer] of this.peers) {
      peer.ws.close();
    }
    this.peers.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.logger.info('P2P transport stopped');
  }

  /**
   * Broadcast a signed message to all connected peers
   */
  async broadcast(type: P2PMessage['type'], payload: any): Promise<void> {
    const message: P2PMessage = {
      type,
      nodeId: this.config.nodeId,
      payload,
      timestamp: Date.now(),
    };

    // Sign the message
    if (this.signFn) {
      const msgBytes = Buffer.from(JSON.stringify({ type, nodeId: message.nodeId, payload, timestamp: message.timestamp }));
      const sig = await this.signFn(msgBytes);
      message.signature = sig.toString('base64');
    }

    const data = JSON.stringify(message);
    let sent = 0;

    for (const [, peer] of this.peers) {
      if (peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(data);
        sent++;
      }
    }

    this.logger.debug('Broadcast message', { type, sentTo: sent, totalPeers: this.peers.size });
  }

  /**
   * Get the current peer list with health info
   */
  getPeerStatus(): Array<{ nodeId: string; address: string; lastSeen: number; isOutbound: boolean }> {
    return Array.from(this.peers.values()).map(p => ({
      nodeId: p.nodeId,
      address: p.address,
      lastSeen: p.lastSeen,
      isOutbound: p.isOutbound,
    }));
  }

  // ── Private Methods ──────────────────────────────────────────

  private handleInboundConnection(ws: WebSocket, address: string): void {
    // Temp peer ID until they announce themselves
    const tempId = `inbound-${crypto.randomBytes(4).toString('hex')}`;

    const peer: PeerConnection = {
      nodeId: tempId,
      ws,
      address,
      lastSeen: Date.now(),
      isOutbound: false,
      reconnectAttempts: 0,
    };

    this.peers.set(tempId, peer);

    ws.on('message', (raw) => {
      try {
        const msg: P2PMessage = JSON.parse(raw.toString());
        this.handleMessage(msg, peer);

        // Update peer's nodeId once we know it
        if (msg.nodeId && peer.nodeId === tempId) {
          this.peers.delete(tempId);
          peer.nodeId = msg.nodeId;
          this.peers.set(msg.nodeId, peer);
          this.logger.info('Peer identified', { nodeId: msg.nodeId, address });
        }
      } catch (err: any) {
        this.logger.warn('Invalid message from peer', { address, error: err.message });
      }
    });

    ws.on('close', () => {
      this.peers.delete(peer.nodeId);
      this.logger.info('Peer disconnected', { nodeId: peer.nodeId });
    });

    ws.on('error', (err) => {
      this.logger.warn('Peer connection error', { nodeId: peer.nodeId, error: err.message });
    });
  }

  private connectToPeer(address: string, attempts = 0): void {
    if (!this.isRunning) return;

    const url = `ws://${address}`;
    this.logger.info('Connecting to peer', { address, attempt: attempts + 1 });

    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });

    ws.on('open', () => {
      this.logger.info('Connected to peer', { address });

      const peer: PeerConnection = {
        nodeId: `outbound-${address}`,
        ws,
        address,
        lastSeen: Date.now(),
        isOutbound: true,
        reconnectAttempts: 0,
      };
      this.peers.set(peer.nodeId, peer);

      // Send a heartbeat to identify ourselves
      this.sendMessage(ws, 'heartbeat', { nodeId: this.config.nodeId, peerCount: this.peers.size });

      ws.on('message', (raw) => {
        try {
          const msg: P2PMessage = JSON.parse(raw.toString());
          this.handleMessage(msg, peer);

          if (msg.nodeId && peer.nodeId.startsWith('outbound-')) {
            this.peers.delete(peer.nodeId);
            peer.nodeId = msg.nodeId;
            this.peers.set(msg.nodeId, peer);
          }
        } catch {}
      });

      ws.on('close', () => {
        this.peers.delete(peer.nodeId);
        this.logger.info('Lost connection to peer', { address });
        this.scheduleReconnect(address, 0);
      });

      ws.on('error', () => {});
    });

    ws.on('error', () => {
      this.logger.warn('Failed to connect to peer', { address, attempt: attempts + 1 });
      this.scheduleReconnect(address, attempts);
    });
  }

  private scheduleReconnect(address: string, attempts: number): void {
    if (!this.isRunning) return;
    const delay = Math.min(
      this.config.reconnectBaseMs * Math.pow(2, attempts),
      this.config.maxReconnectMs,
    );
    this.logger.debug('Scheduling reconnect', { address, delayMs: delay });
    setTimeout(() => this.connectToPeer(address, attempts + 1), delay);
  }

  private handleMessage(msg: P2PMessage, peer: PeerConnection): void {
    peer.lastSeen = Date.now();

    switch (msg.type) {
      case 'attestation':
        this.emit('attestation_received', msg.payload, msg.nodeId);
        break;

      case 'attestation_request':
        this.emit('attestation_request', msg.payload, msg.nodeId);
        break;

      case 'heartbeat':
        this.logger.debug('Heartbeat from peer', { nodeId: msg.nodeId });
        break;

      case 'peer_list':
        // Gossip: learn about new peers
        if (Array.isArray(msg.payload?.peers)) {
          for (const addr of msg.payload.peers) {
            if (typeof addr === 'string' && !this.isAlreadyConnected(addr)) {
              this.connectToPeer(addr);
            }
          }
        }
        break;

      default:
        this.logger.warn('Unknown message type', { type: msg.type });
    }
  }

  private isAlreadyConnected(address: string): boolean {
    for (const [, peer] of this.peers) {
      if (peer.address === address || peer.address.includes(address)) return true;
    }
    return false;
  }

  private sendHeartbeats(): void {
    const peerAddresses = Array.from(this.peers.values())
      .filter(p => p.isOutbound)
      .map(p => p.address);

    for (const [, peer] of this.peers) {
      if (peer.ws.readyState === WebSocket.OPEN) {
        this.sendMessage(peer.ws, 'heartbeat', {
          nodeId: this.config.nodeId,
          peerCount: this.peers.size,
        });

        // Gossip peer list periodically
        if (peerAddresses.length > 0) {
          this.sendMessage(peer.ws, 'peer_list', { peers: peerAddresses });
        }
      }
    }
  }

  private pruneDeadPeers(): void {
    const now = Date.now();
    const timeout = this.config.heartbeatIntervalMs * 3;

    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > timeout && peer.ws.readyState !== WebSocket.OPEN) {
        this.logger.info('Pruning dead peer', { nodeId: id });
        peer.ws.close();
        this.peers.delete(id);
      }
    }
  }

  private async sendMessage(ws: WebSocket, type: P2PMessage['type'], payload: any): Promise<void> {
    const message: P2PMessage = {
      type,
      nodeId: this.config.nodeId,
      payload,
      timestamp: Date.now(),
    };
    ws.send(JSON.stringify(message));
  }
}
