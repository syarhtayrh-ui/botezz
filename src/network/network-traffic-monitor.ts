import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { redactSensitiveData, redactText, sanitizeUrl } from '../security/redaction';

export type NetworkTrafficChannel =
  | 'HTTP'
  | 'WA_STANZA'
  | 'LOCAL_API'
  | 'VOIP_RTP';

export type NetworkTrafficFilter =
  | 'ALL'
  | 'HTTP'
  | 'WA_STANZA'
  | 'LOCAL_API'
  | 'VOIP_RTP'
  | 'ERRORS';

export type NetworkDirection = 'OUTBOUND' | 'INBOUND';

export type NetworkOutcomeStatus = 'SUCCESS' | 'ERROR' | 'SLOW_LATENCY';

export interface VoipTelemetryPayload {
  callId: string;
  txPackets: number;
  rxPackets: number;
  txBytes: number;
  rxBytes: number;
  bitrateKbps: number;
  srtpHmacFailures: number;
  packetLossCount: number;
}

export interface NetworkTrafficEntry {
  requestId: string;
  shortId: string;
  channel: NetworkTrafficChannel;
  direction: NetworkDirection;
  sessionId?: string;
  sessionLabel?: string;
  methodOrTag: string;
  targetOrUrl: string;
  summary: string;
  statusCode: number | string;
  outcome: NetworkOutcomeStatus;
  startedAtIso: string;
  timestampMs: number;
  durationMs: number;
  txBytes: number;
  rxBytes: number;
  requestHeaders?: Record<string, unknown>;
  responseHeaders?: Record<string, unknown>;
  stanzaAttrs?: Record<string, string | undefined>;
  requestBodyPreview?: string;
  responseBodyPreview?: string;
  errorDetail?: string;
  voipMetrics?: VoipTelemetryPayload;
}

export interface LocalSocketPortEntry {
  protocol: 'TCP' | 'UDP';
  localAddress: string;
  localPort: number;
  state: string;
}

export interface HostSocketAndBandwidthMetrics {
  captureEnabled: boolean;
  totalEntries: number;
  maxEntries: number;
  totalTxBytes: number;
  totalRxBytes: number;
  currentTxKbps: number;
  currentRxKbps: number;
  countsByChannel: {
    HTTP: number;
    WA_STANZA: number;
    LOCAL_API: number;
    VOIP_RTP: number;
  };
  errorCount: number;
  slowCount: number;
  avgRttMs: number;
  maxRttMs: number;
  activeListeningPorts: LocalSocketPortEntry[];
  establishedTcpCount: number;
  openUdpSocketsCount: number;
  hostInterfaces: Array<{ name: string; address: string; family: string }>;
}

export interface LivePingResult {
  target: string;
  labelArabic: string;
  reachable: boolean;
  rttMs: number;
  statusDetail: string;
}

export interface InspectableBinaryNode {
  tag: string;
  attrs?: Record<string, string | undefined>;
  content?: unknown;
}

export const MAX_TRAFFIC_ENTRIES = 1000;
export const MAX_PREVIEW_CHARS = 4096;
export const SLOW_LATENCY_THRESHOLD_MS = 2000;

const ENCRYPTED_OR_BINARY_TAGS = new Set([
  'enc',
  'key',
  'skey',
  'identity',
  'ciphertext',
  'auth',
  'crypto',
  'registration',
  ' adv',
  'device-identity',
]);

/**
 * Formats a BinaryNode (WhatsApp WebSocket XML/Binary stanza) into a safe, human-readable
 * XML preview while masking raw encrypted payloads (`<enc>`, `<key>`, `Uint8Array`) so
 * Signal/VoIP keys and raw ciphertexts never leak.
 */
export function formatBinaryNodePreview(
  node: InspectableBinaryNode | undefined | null,
  indent = 0
): string {
  if (!node || typeof node !== 'object' || !node.tag) {
    return '';
  }
  const pad = '  '.repeat(Math.min(indent, 6));
  const rawAttrs = node.attrs || {};
  const redactedAttrs = redactSensitiveData(rawAttrs) as Record<
    string,
    string | undefined
  >;
  const attrPairs = Object.entries(redactedAttrs)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${k}="${redactText(String(v))}"`)
    .join(' ');
  const openTag = attrPairs ? `<${node.tag} ${attrPairs}>` : `<${node.tag}>`;

  const lowerTag = node.tag.toLowerCase();
  if (ENCRYPTED_OR_BINARY_TAGS.has(lowerTag)) {
    const byteLen = getNodeContentByteLength(node.content);
    return `${pad}${openTag}[Encrypted ${byteLen}B]</${node.tag}>`;
  }

  if (node.content === undefined || node.content === null) {
    return `${pad}${ attrPairs ? `<${node.tag} ${attrPairs}/>` : `<${node.tag}/>` }`;
  }

  if (Buffer.isBuffer(node.content) || node.content instanceof Uint8Array) {
    return `${pad}${openTag}[Binary ${node.content.byteLength}B]</${node.tag}>`;
  }

  if (typeof node.content === 'string') {
    const safeText = redactText(node.content).slice(0, 512);
    return `${pad}${openTag}${safeText}</${node.tag}>`;
  }

  if (Array.isArray(node.content)) {
    if (node.content.length === 0) {
      return `${pad}${attrPairs ? `<${node.tag} ${attrPairs}/>` : `<${node.tag}/>`}`;
    }
    const childLines: string[] = [];
    for (const child of node.content.slice(0, 24)) {
      if (child && typeof child === 'object' && 'tag' in child) {
        childLines.push(
          formatBinaryNodePreview(child as InspectableBinaryNode, indent + 1)
        );
      } else if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
        childLines.push(`${pad}  [Binary ${child.byteLength}B]`);
      } else if (child !== undefined && child !== null) {
        childLines.push(`${pad}  ${redactText(String(child)).slice(0, 200)}`);
      }
    }
    if (node.content.length > 24) {
      childLines.push(`${pad}  <!-- +${node.content.length - 24} more nodes -->`);
    }
    return `${pad}${openTag}\n${childLines.join('\n')}\n${pad}</${node.tag}>`;
  }

  try {
    const serialized = JSON.stringify(redactSensitiveData(node.content));
    return `${pad}${openTag}${serialized.slice(0, 512)}</${node.tag}>`;
  } catch {
    return `${pad}${openTag}[Object]</${node.tag}>`;
  }
}

export function getNodeContentByteLength(content: unknown): number {
  if (!content) return 0;
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    return content.byteLength;
  }
  if (typeof content === 'string') {
    return Buffer.byteLength(content, 'utf8');
  }
  if (Array.isArray(content)) {
    let sum = 0;
    for (const item of content) {
      if (item && typeof item === 'object' && 'tag' in item) {
        sum += estimateBinaryNodeBytes(item as InspectableBinaryNode);
      } else {
        sum += getNodeContentByteLength(item);
      }
    }
    return sum;
  }
  if (typeof content === 'object') {
    try {
      return Buffer.byteLength(JSON.stringify(content), 'utf8');
    } catch {
      return 64;
    }
  }
  return 0;
}

export function estimateBinaryNodeBytes(
  node: InspectableBinaryNode | undefined | null
): number {
  if (!node || typeof node !== 'object') return 0;
  let size = (node.tag?.length || 2) + 4;
  if (node.attrs) {
    for (const [k, v] of Object.entries(node.attrs)) {
      if (v !== undefined) {
        size += k.length + String(v).length + 2;
      }
    }
  }
  size += getNodeContentByteLength(node.content);
  return size;
}

/**
 * Formats an arbitrary HTTP/API body or payload into a safe, redacted preview string
 * bounded by `MAX_PREVIEW_CHARS` (4096 chars). Binary payloads are summarized cleanly.
 */
export function formatBodyPreview(
  body: unknown,
  contentType?: string,
  maxChars = MAX_PREVIEW_CHARS
): { preview: string; byteLength: number } {
  if (body === undefined || body === null || body === '') {
    return { preview: '', byteLength: 0 };
  }

  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const kb = (body.byteLength / 1024).toFixed(1);
    const mime = contentType || 'application/octet-stream';
    if (
      mime.includes('json') ||
      mime.includes('text') ||
      mime.includes('xml') ||
      mime.includes('urlencoded')
    ) {
      const str = Buffer.from(body).toString('utf8');
      const redacted = redactText(str);
      return {
        preview:
          redacted.length > maxChars
            ? `${redacted.slice(0, maxChars)}... [Truncated]`
            : redacted,
        byteLength: body.byteLength,
      };
    }
    return {
      preview: `[Binary Buffer: ${mime}, ${kb} KB]`,
      byteLength: body.byteLength,
    };
  }

  if (typeof body === 'string') {
    const byteLength = Buffer.byteLength(body, 'utf8');
    try {
      const parsed = JSON.parse(body);
      const redactedObj = redactSensitiveData(parsed);
      const formatted = JSON.stringify(redactedObj, null, 2);
      return {
        preview:
          formatted.length > maxChars
            ? `${formatted.slice(0, maxChars)}... [Truncated]`
            : formatted,
        byteLength,
      };
    } catch {
      const redacted = redactText(body);
      return {
        preview:
          redacted.length > maxChars
            ? `${redacted.slice(0, maxChars)}... [Truncated]`
            : redacted,
        byteLength,
      };
    }
  }

  if (typeof body === 'object') {
    try {
      const redactedObj = redactSensitiveData(body);
      const formatted = JSON.stringify(redactedObj, null, 2);
      const byteLength = Buffer.byteLength(formatted, 'utf8');
      return {
        preview:
          formatted.length > maxChars
            ? `${formatted.slice(0, maxChars)}... [Truncated]`
            : formatted,
        byteLength,
      };
    } catch {
      return { preview: '[Unserializable Payload]', byteLength: 0 };
    }
  }

  const fallback = redactText(String(body));
  return {
    preview: fallback.slice(0, maxChars),
    byteLength: Buffer.byteLength(fallback, 'utf8'),
  };
}

/**
 * Parses `/proc/net/tcp` or `/proc/net/udp` hex lines on Linux without invoking any shell command.
 */
function parseLinuxProcNetFile(
  filePath: string,
  protocol: 'TCP' | 'UDP'
): {
  listening: LocalSocketPortEntry[];
  establishedCount: number;
  totalCount: number;
} {
  const listening: LocalSocketPortEntry[] = [];
  let establishedCount = 0;
  let totalCount = 0;

  try {
    if (!fs.existsSync(filePath)) {
      return { listening, establishedCount, totalCount };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').slice(1);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 4) continue;
      totalCount += 1;
      const localHex = parts[1] || '';
      const stateHex = (parts[3] || '').toUpperCase();
      const [ipHex, portHex] = localHex.split(':');
      const port = parseInt(portHex || '0', 16);
      if (!Number.isFinite(port) || port <= 0) continue;

      let ipStr = '0.0.0.0';
      if (ipHex && ipHex.length === 8) {
        const b1 = parseInt(ipHex.slice(6, 8), 16);
        const b2 = parseInt(ipHex.slice(4, 6), 16);
        const b3 = parseInt(ipHex.slice(2, 4), 16);
        const b4 = parseInt(ipHex.slice(0, 2), 16);
        ipStr = `${b1}.${b2}.${b3}.${b4}`;
      } else if (ipHex && ipHex.length > 8) {
        ipStr = '::';
      }

      if (stateHex === '01') {
        establishedCount += 1;
      }
      // 0A = TCP_LISTEN; for UDP, 07 = CLOSE (bound socket)
      if (
        (protocol === 'TCP' && stateHex === '0A') ||
        (protocol === 'UDP' && (stateHex === '07' || stateHex === '01'))
      ) {
        if (!listening.some((p) => p.protocol === protocol && p.localPort === port)) {
          listening.push({
            protocol,
            localAddress: ipStr,
            localPort: port,
            state: protocol === 'TCP' ? 'LISTEN' : 'BOUND',
          });
        }
      }
    }
  } catch {
    // Best-effort reading of /proc/net/*
  }

  return { listening, establishedCount, totalCount };
}

/**
 * Central Non-Blocking Ring-Buffer & Network Telemetry Collector for Botezz.
 * Captures 5 channels:
 * 1. Outbound HTTP/HTTPS (`fetch`, `http.request`, `https.request`)
 * 2. WhatsApp WebSocket BinaryNode (`iq`, `message`, `presence`, `call`, `receipt`, `ack`)
 * 3. Local Next.js API & Runtime Harness (`GET/POST /api/harness`)
 * 4. VoIP RTP/SRTP Media Stream Telemetry (`video-call-bridge`, `voip-call-recorder`)
 * 5. Local Host Socket & Bandwidth Metrics (`/proc/net/tcp`, `/proc/net/udp`, active interfaces)
 */
export class NetworkTrafficMonitor {
  private readonly entries: NetworkTrafficEntry[] = [];
  private readonly byRequestId = new Map<string, NetworkTrafficEntry>();
  private readonly byShortId = new Map<string, NetworkTrafficEntry>();
  private readonly pendingIqBySessionAndId = new Map<
    string,
    { timestampMs: number; tag: string; xmlns?: string; to?: string }
  >();
  private readonly rollingSamples: Array<{
    timestampMs: number;
    txBytes: number;
    rxBytes: number;
  }> = [];

  private captureEnabled = true;
  private totalTxBytes = 0;
  private totalRxBytes = 0;
  private sequenceCounter = 0;
  private interceptorsInstalled = false;
  private originalFetch?: typeof globalThis.fetch;
  private originalHttpRequest?: typeof http.request;
  private originalHttpsRequest?: typeof https.request;

  constructor(private readonly maxEntries: number = MAX_TRAFFIC_ENTRIES) {}

  public isCaptureEnabled(): boolean {
    return this.captureEnabled;
  }

  public setCaptureEnabled(enabled: boolean): boolean {
    this.captureEnabled = enabled;
    return this.captureEnabled;
  }

  public toggleCapture(): boolean {
    this.captureEnabled = !this.captureEnabled;
    return this.captureEnabled;
  }

  public clearBuffer(): void {
    this.entries.length = 0;
    this.byRequestId.clear();
    this.byShortId.clear();
    this.pendingIqBySessionAndId.clear();
    this.rollingSamples.length = 0;
  }

  private allocateIds(nowMs: number): { requestId: string; shortId: string } {
    this.sequenceCounter = (this.sequenceCounter + 1) % 1_000_000;
    const rand = Math.random().toString(36).slice(2, 6);
    const shortId = `${this.sequenceCounter.toString(36)}${rand}`.slice(0, 8);
    const requestId = `net_${nowMs}_${shortId}`;
    return { requestId, shortId };
  }

  private recordBandwidthSample(
    timestampMs: number,
    txBytes: number,
    rxBytes: number
  ): void {
    const safeTx = Math.max(0, Math.floor(txBytes || 0));
    const safeRx = Math.max(0, Math.floor(rxBytes || 0));
    this.totalTxBytes += safeTx;
    this.totalRxBytes += safeRx;
    this.rollingSamples.push({
      timestampMs,
      txBytes: safeTx,
      rxBytes: safeRx,
    });
    const cutoff = timestampMs - 10_000;
    while (
      this.rollingSamples.length > 0 &&
      this.rollingSamples[0].timestampMs < cutoff
    ) {
      this.rollingSamples.shift();
    }
  }

  public pushEntry(
    input: Omit<
      NetworkTrafficEntry,
      'requestId' | 'shortId' | 'startedAtIso' | 'timestampMs' | 'outcome'
    > & {
      requestId?: string;
      shortId?: string;
      timestampMs?: number;
      startedAtIso?: string;
      outcome?: NetworkOutcomeStatus;
    }
  ): NetworkTrafficEntry {
    const nowMs = input.timestampMs ?? Date.now();
    const { requestId, shortId } =
      input.requestId && input.shortId
        ? { requestId: input.requestId, shortId: input.shortId }
        : this.allocateIds(nowMs);

    const safeTx = Math.max(0, Math.floor(input.txBytes || 0));
    const safeRx = Math.max(0, Math.floor(input.rxBytes || 0));
    this.recordBandwidthSample(nowMs, safeTx, safeRx);

    const isErrorStatus =
      (typeof input.statusCode === 'number' && input.statusCode >= 400) ||
      (typeof input.statusCode === 'string' &&
        /^(?:err|error|fail|denied|timeout|reject)/i.test(input.statusCode)) ||
      Boolean(input.errorDetail);

    const outcome: NetworkOutcomeStatus =
      input.outcome ??
      (isErrorStatus
        ? 'ERROR'
        : input.durationMs >= SLOW_LATENCY_THRESHOLD_MS
          ? 'SLOW_LATENCY'
          : 'SUCCESS');

    const entry: NetworkTrafficEntry = {
      requestId,
      shortId,
      channel: input.channel,
      direction: input.direction,
      sessionId: input.sessionId,
      sessionLabel: input.sessionLabel,
      methodOrTag: input.methodOrTag,
      targetOrUrl: sanitizeUrl(input.targetOrUrl),
      summary: redactText(input.summary).slice(0, 220),
      statusCode: input.statusCode,
      outcome,
      startedAtIso: input.startedAtIso ?? new Date(nowMs).toISOString(),
      timestampMs: nowMs,
      durationMs: Math.max(0, Math.round(input.durationMs || 0)),
      txBytes: safeTx,
      rxBytes: safeRx,
      requestHeaders: input.requestHeaders
        ? (redactSensitiveData(input.requestHeaders) as Record<string, unknown>)
        : undefined,
      responseHeaders: input.responseHeaders
        ? (redactSensitiveData(input.responseHeaders) as Record<string, unknown>)
        : undefined,
      stanzaAttrs: input.stanzaAttrs
        ? (redactSensitiveData(input.stanzaAttrs) as Record<
            string,
            string | undefined
          >)
        : undefined,
      requestBodyPreview: input.requestBodyPreview
        ? redactText(input.requestBodyPreview).slice(0, MAX_PREVIEW_CHARS)
        : undefined,
      responseBodyPreview: input.responseBodyPreview
        ? redactText(input.responseBodyPreview).slice(0, MAX_PREVIEW_CHARS)
        : undefined,
      errorDetail: input.errorDetail
        ? redactText(input.errorDetail).slice(0, 1024)
        : undefined,
      voipMetrics: input.voipMetrics,
    };

    if (!this.captureEnabled) {
      return entry;
    }

    this.entries.push(entry);
    this.byRequestId.set(entry.requestId, entry);
    this.byShortId.set(entry.shortId, entry);

    while (this.entries.length > this.maxEntries) {
      const evicted = this.entries.shift();
      if (evicted) {
        this.byRequestId.delete(evicted.requestId);
        this.byShortId.delete(evicted.shortId);
      }
    }

    return entry;
  }

  // ============================================================================
  // Channel 1: Outbound HTTP / HTTPS Interceptor (fetch + http/https.request)
  // ============================================================================

  public recordHttpTransaction(params: {
    method: string;
    url: string;
    statusCode: number | string;
    durationMs: number;
    requestHeaders?: Record<string, unknown>;
    responseHeaders?: Record<string, unknown>;
    requestBody?: unknown;
    responseBody?: unknown;
    txBytes?: number;
    rxBytes?: number;
    errorDetail?: string;
  }): NetworkTrafficEntry {
    const cleanUrl = sanitizeUrl(params.url);
    const reqContentType = String(
      params.requestHeaders?.['content-type'] ||
        params.requestHeaders?.['Content-Type'] ||
        ''
    );
    const resContentType = String(
      params.responseHeaders?.['content-type'] ||
        params.responseHeaders?.['Content-Type'] ||
        ''
    );
    const reqPreview = formatBodyPreview(params.requestBody, reqContentType);
    const resPreview = formatBodyPreview(params.responseBody, resContentType);

    let shortTarget = cleanUrl;
    try {
      const u = new URL(cleanUrl);
      shortTarget = `${u.host}${u.pathname}`;
    } catch {
      shortTarget = cleanUrl.slice(0, 80);
    }

    return this.pushEntry({
      channel: 'HTTP',
      direction: 'OUTBOUND',
      methodOrTag: (params.method || 'GET').toUpperCase(),
      targetOrUrl: cleanUrl,
      summary: `${(params.method || 'GET').toUpperCase()} ${shortTarget}`,
      statusCode: params.statusCode,
      durationMs: params.durationMs,
      txBytes: params.txBytes ?? reqPreview.byteLength,
      rxBytes: params.rxBytes ?? resPreview.byteLength,
      requestHeaders: params.requestHeaders,
      responseHeaders: params.responseHeaders,
      requestBodyPreview: reqPreview.preview || undefined,
      responseBodyPreview: resPreview.preview || undefined,
      errorDetail: params.errorDetail,
    });
  }

  public installHttpInterceptors(): void {
    if (this.interceptorsInstalled) return;
    this.interceptorsInstalled = true;

    // 1. Intercept globalThis.fetch
    if (typeof globalThis.fetch === 'function') {
      const origFetch = globalThis.fetch;
      this.originalFetch = origFetch;

      const wrappedFetch: typeof globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> => {
        const startedAt = Date.now();
        const rawUrl =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request)?.url || String(input);
        const method = (
          init?.method ||
          (typeof input === 'object' && input && 'method' in input
            ? (input as Request).method
            : 'GET') ||
          'GET'
        ).toUpperCase();

        const reqHeaders: Record<string, string> = {};
        try {
          if (init?.headers) {
            const h = new Headers(init.headers as HeadersInit);
            h.forEach((v, k) => {
              reqHeaders[k] = v;
            });
          }
        } catch {
          // Ignore header extraction errors
        }

        const reqBodyInfo = formatBodyPreview(
          init?.body,
          reqHeaders['content-type']
        );

        try {
          const response = await origFetch(input, init);
          const durationMs = Date.now() - startedAt;

          const resHeaders: Record<string, string> = {};
          try {
            response.headers?.forEach((v, k) => {
              resHeaders[k] = v;
            });
          } catch {
            // Ignore
          }

          let resPreview = '';
          let rxBytes = Number(resHeaders['content-length'] || 0) || 0;
          try {
            if (typeof response.clone === 'function') {
              const cloned = response.clone();
              const cType = resHeaders['content-type'] || '';
              if (
                cType.includes('json') ||
                cType.includes('text') ||
                cType.includes('xml')
              ) {
                const txt = await cloned.text();
                const formatted = formatBodyPreview(txt, cType);
                resPreview = formatted.preview;
                rxBytes = formatted.byteLength;
              } else {
                const buf = await cloned.arrayBuffer();
                rxBytes = buf.byteLength;
                resPreview = `[Binary Buffer: ${cType || 'application/octet-stream'}, ${(rxBytes / 1024).toFixed(1)} KB]`;
              }
            }
          } catch {
            // Best-effort clone inspection
          }

          this.recordHttpTransaction({
            method,
            url: rawUrl,
            statusCode: response.status,
            durationMs,
            requestHeaders: reqHeaders,
            responseHeaders: resHeaders,
            requestBody: reqBodyInfo.preview,
            responseBody: resPreview,
            txBytes: reqBodyInfo.byteLength,
            rxBytes,
          });

          return response;
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          this.recordHttpTransaction({
            method,
            url: rawUrl,
            statusCode: 'ERR',
            durationMs,
            requestHeaders: reqHeaders,
            requestBody: reqBodyInfo.preview,
            txBytes: reqBodyInfo.byteLength,
            rxBytes: 0,
            errorDetail: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      };

      globalThis.fetch = wrappedFetch;
    }

    // 2. Intercept http.request and https.request
    const wrapNodeRequest = (
      origReq: typeof http.request,
      defaultProto: 'http:' | 'https:'
    ): typeof http.request => {
      return ((...args: unknown[]) => {
        const startedAt = Date.now();
        let rawUrl = '';
        let method = 'GET';
        let reqHeaders: Record<string, unknown> = {};

        try {
          const first = args[0];
          const second = args[1];
          if (typeof first === 'string' || first instanceof URL) {
            rawUrl = first.toString();
            if (second && typeof second === 'object' && !(' write' in second)) {
              const opts = second as http.RequestOptions;
              method = (opts.method || 'GET').toUpperCase();
              reqHeaders = (opts.headers as Record<string, unknown>) || {};
            }
          } else if (first && typeof first === 'object') {
            const opts = first as http.RequestOptions & { href?: string };
            method = (opts.method || 'GET').toUpperCase();
            reqHeaders = (opts.headers as Record<string, unknown>) || {};
            const proto = opts.protocol || defaultProto;
            const host = opts.hostname || opts.host || 'localhost';
            const port = opts.port ? `:${opts.port}` : '';
            const pathPart = opts.path || '/';
            rawUrl = opts.href || `${proto}//${host}${port}${pathPart}`;
          }
        } catch {
          rawUrl = `${defaultProto}//unknown`;
        }

        const clientReq = (origReq as (...a: unknown[]) => http.ClientRequest)(
          ...args
        );

        let txBytes = 0;
        const origWrite = clientReq.write.bind(clientReq);
        clientReq.write = ((chunk: unknown, ...rest: unknown[]) => {
          if (typeof chunk === 'string') {
            txBytes += Buffer.byteLength(chunk);
          } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
            txBytes += chunk.byteLength;
          }
          return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof clientReq.write;

        clientReq.once('response', (res: http.IncomingMessage) => {
          let rxBytes = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            rxBytes += buf.byteLength;
            if (chunks.length < 8 && rxBytes <= 16_384) {
              chunks.push(buf);
            }
          });
          res.once('end', () => {
            const durationMs = Date.now() - startedAt;
            const cType = String(res.headers?.['content-type'] || '');
            const combined = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
            this.recordHttpTransaction({
              method,
              url: rawUrl,
              statusCode: res.statusCode || 200,
              durationMs,
              requestHeaders: reqHeaders,
              responseHeaders: (res.headers as Record<string, unknown>) || {},
              responseBody: combined,
              txBytes,
              rxBytes,
            });
            void cType;
          });
        });

        clientReq.once('error', (err: Error) => {
          const durationMs = Date.now() - startedAt;
          this.recordHttpTransaction({
            method,
            url: rawUrl,
            statusCode: 'ERR',
            durationMs,
            requestHeaders: reqHeaders,
            txBytes,
            rxBytes: 0,
            errorDetail: err.message,
          });
        });

        return clientReq;
      }) as typeof http.request;
    };

    try {
      this.originalHttpRequest = http.request;
      http.request = wrapNodeRequest(this.originalHttpRequest, 'http:');
    } catch {
      // Read-only module export in some environments
    }

    try {
      this.originalHttpsRequest = https.request;
      https.request = wrapNodeRequest(this.originalHttpsRequest, 'https:');
    } catch {
      // Read-only module export in some environments
    }
  }

  public uninstallHttpInterceptors(): void {
    if (!this.interceptorsInstalled) return;
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
    try {
      if (this.originalHttpRequest) {
        http.request = this.originalHttpRequest;
        this.originalHttpRequest = undefined;
      }
      if (this.originalHttpsRequest) {
        https.request = this.originalHttpsRequest;
        this.originalHttpsRequest = undefined;
      }
    } catch {
      // Ignore
    }
    this.interceptorsInstalled = false;
  }

  // ============================================================================
  // Channel 2: WhatsApp WebSocket BinaryNode & IQ/Stanza Inspector
  // ============================================================================

  public recordWhatsAppStanza(params: {
    sessionId: string;
    sessionLabel?: string;
    direction: NetworkDirection;
    node: InspectableBinaryNode;
    responseNode?: InspectableBinaryNode;
    durationMs?: number;
    statusCode?: string | number;
    errorDetail?: string;
  }): NetworkTrafficEntry {
    const { sessionId, sessionLabel, direction, node, responseNode } = params;
    const tag = node?.tag || 'stanza';
    const attrs = node?.attrs || {};
    const stanzaId = attrs.id;
    const xmlns = attrs.xmlns;
    const typeAttr = attrs.type;
    const peerJid =
      direction === 'OUTBOUND'
        ? attrs.to || attrs.participant || 's.whatsapp.net'
        : attrs.from || attrs.participant || 's.whatsapp.net';

    let computedRttMs = params.durationMs ?? 0;
    if (tag === 'iq' && stanzaId) {
      const mapKey = `${sessionId}:${stanzaId}`;
      if (direction === 'OUTBOUND' && !responseNode) {
        this.pendingIqBySessionAndId.set(mapKey, {
          timestampMs: Date.now(),
          tag,
          xmlns,
          to: peerJid,
        });
        if (this.pendingIqBySessionAndId.size > 500) {
          const firstKey = this.pendingIqBySessionAndId.keys().next().value;
          if (firstKey) this.pendingIqBySessionAndId.delete(firstKey);
        }
      } else if (direction === 'INBOUND' && computedRttMs === 0) {
        const pending = this.pendingIqBySessionAndId.get(mapKey);
        if (pending) {
          computedRttMs = Math.max(0, Date.now() - pending.timestampMs);
          this.pendingIqBySessionAndId.delete(mapKey);
        }
      }
    }

    const nodeBytes = estimateBinaryNodeBytes(node);
    const resBytes = responseNode ? estimateBinaryNodeBytes(responseNode) : 0;
    const txBytes = direction === 'OUTBOUND' ? nodeBytes : 0;
    const rxBytes = direction === 'INBOUND' ? nodeBytes : resBytes;

    const childTags: string[] = [];
    if (Array.isArray(node.content)) {
      for (const c of node.content) {
        if (c && typeof c === 'object' && 'tag' in c && typeof c.tag === 'string') {
          childTags.push(`<${c.tag}>`);
        }
      }
    }

    const descriptorParts = [
      tag,
      typeAttr ? `type="${typeAttr}"` : '',
      xmlns ? `xmlns="${xmlns}"` : '',
      childTags.length > 0 ? childTags.slice(0, 3).join('') : '',
    ].filter(Boolean);

    const summary = `${descriptorParts.join(' ')} → ${peerJid}`;
    const nodePreview = formatBinaryNodePreview(node);
    const resPreview = responseNode ? formatBinaryNodePreview(responseNode) : undefined;

    const resolvedStatus =
      params.statusCode ??
      (params.errorDetail
        ? 'ERR'
        : responseNode?.attrs?.type?.toUpperCase() ||
          typeAttr?.toUpperCase() ||
          'OK');

    return this.pushEntry({
      channel: 'WA_STANZA',
      direction,
      sessionId,
      sessionLabel,
      methodOrTag: tag.toUpperCase(),
      targetOrUrl: `${tag}${xmlns ? ` [${xmlns}]` : ''} (${peerJid})`,
      summary,
      statusCode: resolvedStatus,
      durationMs: computedRttMs,
      txBytes,
      rxBytes,
      stanzaAttrs: attrs,
      requestBodyPreview: direction === 'OUTBOUND' ? nodePreview : undefined,
      responseBodyPreview:
        direction === 'INBOUND' ? nodePreview : resPreview,
      errorDetail: params.errorDetail,
    });
  }

  // ============================================================================
  // Channel 3: Local Next.js API & Runtime Harness Traffic
  // ============================================================================

  public recordLocalApiRequest(params: {
    method: string;
    route: string;
    actionSummary: string;
    clientIp?: string;
    statusCode: number;
    durationMs: number;
    requestPayload?: unknown;
    responsePayload?: unknown;
    errorDetail?: string;
  }): NetworkTrafficEntry {
    const reqInfo = formatBodyPreview(
      params.requestPayload,
      'application/json'
    );
    const resInfo = formatBodyPreview(
      params.responsePayload,
      'application/json'
    );

    return this.pushEntry({
      channel: 'LOCAL_API',
      direction: 'INBOUND',
      methodOrTag: params.method.toUpperCase(),
      targetOrUrl: `${params.route} (${params.clientIp || '127.0.0.1'})`,
      summary: `${params.method.toUpperCase()} ${params.route} — ${params.actionSummary}`,
      statusCode: params.statusCode,
      durationMs: params.durationMs,
      txBytes: resInfo.byteLength,
      rxBytes: reqInfo.byteLength,
      requestHeaders: {
        'x-client-ip': params.clientIp || '127.0.0.1',
        route: params.route,
      },
      requestBodyPreview: reqInfo.preview || undefined,
      responseBodyPreview: resInfo.preview || undefined,
      errorDetail: params.errorDetail,
    });
  }

  // ============================================================================
  // Channel 4: VoIP RTP / SRTP & Media Stream Telemetry
  // ============================================================================

  public recordVoipStreamTelemetry(params: {
    sessionId: string;
    callId: string;
    recipientJid: string;
    durationMs: number;
    txPackets: number;
    rxPackets: number;
    txBytes: number;
    rxBytes: number;
    srtpHmacFailures?: number;
    packetLossCount?: number;
    isFinal?: boolean;
  }): NetworkTrafficEntry {
    const seconds = Math.max(1, params.durationMs / 1000);
    const totalBits = (params.txBytes + params.rxBytes) * 8;
    const bitrateKbps = Number((totalBits / 1000 / seconds).toFixed(1));
    const hmacFails = params.srtpHmacFailures ?? 0;
    const loss = params.packetLossCount ?? 0;

    const voipMetrics: VoipTelemetryPayload = {
      callId: params.callId,
      txPackets: params.txPackets,
      rxPackets: params.rxPackets,
      txBytes: params.txBytes,
      rxBytes: params.rxBytes,
      bitrateKbps,
      srtpHmacFailures: hmacFails,
      packetLossCount: loss,
    };

    const summary = `${params.isFinal ? 'FINAL' : 'LIVE'} VoIP [${params.callId}] ⬆️${params.txPackets}pkts ⬇️${params.rxPackets}pkts (${bitrateKbps} kbps)`;

    return this.pushEntry({
      channel: 'VOIP_RTP',
      direction: 'OUTBOUND',
      sessionId: params.sessionId,
      methodOrTag: params.isFinal ? 'VOIP_FINAL' : 'VOIP_RTP',
      targetOrUrl: `srtp://${params.recipientJid} (${params.callId})`,
      summary,
      statusCode: hmacFails > 0 ? 'HMAC_WARN' : 'SRTP_OK',
      durationMs: params.durationMs,
      txBytes: params.txBytes,
      rxBytes: params.rxBytes,
      requestBodyPreview: JSON.stringify(voipMetrics, null, 2),
      responseBodyPreview:
        `Call ID: ${params.callId}\n` +
        `Peer JID: ${params.recipientJid}\n` +
        `TX Packets: ${params.txPackets} (${(params.txBytes / 1024).toFixed(1)} KB)\n` +
        `RX Packets: ${params.rxPackets} (${(params.rxBytes / 1024).toFixed(1)} KB)\n` +
        `Bitrate: ${bitrateKbps} kbps\n` +
        `SRTP HMAC Failures: ${hmacFails}\n` +
        `Packet Loss: ${loss}`,
      voipMetrics,
    });
  }

  // ============================================================================
  // Channel 5: Local Host Socket & Bandwidth Metrics + Queries
  // ============================================================================

  public queryEntries(options?: {
    filter?: NetworkTrafficFilter;
    sessionId?: string;
    direction?: NetworkDirection;
    page?: number;
    pageSize?: number;
  }): {
    items: NetworkTrafficEntry[];
    totalMatching: number;
    page: number;
    totalPages: number;
  } {
    const filter = options?.filter || 'ALL';
    const sessionId = options?.sessionId;
    const direction = options?.direction;
    const pageSize = Math.max(1, Math.min(50, options?.pageSize ?? 8));

    const filtered: NetworkTrafficEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const item = this.entries[i];
      if (sessionId && item.sessionId !== sessionId) continue;
      if (direction && item.direction !== direction) continue;

      if (filter === 'ERRORS') {
        if (
          item.outcome !== 'ERROR' &&
          item.outcome !== 'SLOW_LATENCY'
        ) {
          continue;
        }
      } else if (filter !== 'ALL' && item.channel !== filter) {
        continue;
      }

      filtered.push(item);
    }

    const totalMatching = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalMatching / pageSize));
    const page = Math.max(1, Math.min(totalPages, options?.page ?? 1));
    const startIdx = (page - 1) * pageSize;
    const items = filtered.slice(startIdx, startIdx + pageSize);

    return {
      items,
      totalMatching,
      page,
      totalPages,
    };
  }

  public findEntryById(idOrShortId: string): NetworkTrafficEntry | undefined {
    const trimmed = (idOrShortId || '').trim();
    if (!trimmed) return undefined;
    return (
      this.byShortId.get(trimmed) ||
      this.byRequestId.get(trimmed) ||
      this.entries.find(
        (e) =>
          e.shortId === trimmed ||
          e.requestId === trimmed ||
          e.requestId.endsWith(trimmed)
      )
    );
  }

  public getMetrics(): HostSocketAndBandwidthMetrics {
    const now = Date.now();
    const cutoff = now - 10_000;
    let windowTx = 0;
    let windowRx = 0;
    for (const s of this.rollingSamples) {
      if (s.timestampMs >= cutoff) {
        windowTx += s.txBytes;
        windowRx += s.rxBytes;
      }
    }

    const currentTxKbps = Number((windowTx / 1024 / 10).toFixed(2));
    const currentRxKbps = Number((windowRx / 1024 / 10).toFixed(2));

    const countsByChannel = {
      HTTP: 0,
      WA_STANZA: 0,
      LOCAL_API: 0,
      VOIP_RTP: 0,
    };
    let errorCount = 0;
    let slowCount = 0;
    let rttSum = 0;
    let rttCount = 0;
    let maxRttMs = 0;

    for (const e of this.entries) {
      countsByChannel[e.channel] = (countsByChannel[e.channel] || 0) + 1;
      if (e.outcome === 'ERROR') errorCount += 1;
      if (e.outcome === 'SLOW_LATENCY') slowCount += 1;
      if (e.durationMs > 0) {
        rttSum += e.durationMs;
        rttCount += 1;
        if (e.durationMs > maxRttMs) {
          maxRttMs = e.durationMs;
        }
      }
    }

    const avgRttMs = rttCount > 0 ? Math.round(rttSum / rttCount) : 0;

    // Inspect /proc/net/tcp and /proc/net/udp on Linux safely
    const tcp4 = parseLinuxProcNetFile('/proc/net/tcp', 'TCP');
    const tcp6 = parseLinuxProcNetFile('/proc/net/tcp6', 'TCP');
    const udp4 = parseLinuxProcNetFile('/proc/net/udp', 'UDP');
    const udp6 = parseLinuxProcNetFile('/proc/net/udp6', 'UDP');

    const activeListeningPorts: LocalSocketPortEntry[] = [];
    for (const entry of [
      ...tcp4.listening,
      ...tcp6.listening,
      ...udp4.listening,
      ...udp6.listening,
    ]) {
      if (
        !activeListeningPorts.some(
          (p) => p.protocol === entry.protocol && p.localPort === entry.localPort
        )
      ) {
        activeListeningPorts.push(entry);
      }
    }
    if (activeListeningPorts.length === 0) {
      // Cross-platform fallback when /proc/net/* is unavailable
      activeListeningPorts.push({
        protocol: 'TCP',
        localAddress: '0.0.0.0',
        localPort: Number(process.env.PORT) || 3000,
        state: 'LISTEN',
      });
    }

    const hostInterfaces: Array<{
      name: string;
      address: string;
      family: string;
    }> = [];
    try {
      const nets = os.networkInterfaces();
      for (const [name, list] of Object.entries(nets)) {
        for (const iface of list || []) {
          if (!iface.internal) {
            hostInterfaces.push({
              name,
              address: iface.address,
              family: String(iface.family),
            });
          }
        }
      }
    } catch {
      // Ignore
    }

    return {
      captureEnabled: this.captureEnabled,
      totalEntries: this.entries.length,
      maxEntries: this.maxEntries,
      totalTxBytes: this.totalTxBytes,
      totalRxBytes: this.totalRxBytes,
      currentTxKbps,
      currentRxKbps,
      countsByChannel,
      errorCount,
      slowCount,
      avgRttMs,
      maxRttMs,
      activeListeningPorts: activeListeningPorts.slice(0, 12),
      establishedTcpCount: tcp4.establishedCount + tcp6.establishedCount,
      openUdpSocketsCount: udp4.totalCount + udp6.totalCount,
      hostInterfaces: hostInterfaces.slice(0, 6),
    };
  }

  /**
   * Executes a live connectivity & RTT benchmark against WhatsApp Web, Telegram Bot API,
   * and the local SQLite database.
   */
  public async runLiveServerPing(options?: {
    sqlitePingFn?: () => void;
    timeoutMs?: number;
  }): Promise<LivePingResult[]> {
    const timeoutMs = options?.timeoutMs ?? 4000;
    const results: LivePingResult[] = [];

    const pingHttpEndpoint = async (
      targetUrl: string,
      labelArabic: string
    ): Promise<LivePingResult> => {
      const start = Date.now();
      const fetchFn = this.originalFetch || globalThis.fetch;
      if (typeof fetchFn !== 'function') {
        return {
          target: targetUrl,
          labelArabic,
          reachable: false,
          rttMs: 0,
          statusDetail: 'Fetch API unavailable',
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchFn(targetUrl, {
          method: 'HEAD',
          signal: controller.signal,
        });
        const rttMs = Math.max(1, Date.now() - start);
        return {
          target: targetUrl,
          labelArabic,
          reachable: res.status > 0 && res.status < 500,
          rttMs,
          statusDetail: `HTTP ${res.status}`,
        };
      } catch (err) {
        const rttMs = Math.max(1, Date.now() - start);
        return {
          target: targetUrl,
          labelArabic,
          reachable: false,
          rttMs,
          statusDetail:
            err instanceof Error ? err.message.slice(0, 60) : 'Timeout / Unreachable',
        };
      } finally {
        clearTimeout(timer);
      }
    };

    const [waPing, tgPing] = await Promise.all([
      pingHttpEndpoint('https://web.whatsapp.com', 'خادم واتساب (web.whatsapp.com)'),
      pingHttpEndpoint('https://api.telegram.org', 'خادم تليجرام (api.telegram.org)'),
    ]);
    results.push(waPing, tgPing);

    const dbStart = performance.now();
    try {
      options?.sqlitePingFn?.();
      const dbRtt = Math.max(0.1, Number((performance.now() - dbStart).toFixed(2)));
      results.push({
        target: 'sqlite://local-database',
        labelArabic: 'قاعدة البيانات المحلية (SQLite)',
        reachable: true,
        rttMs: dbRtt,
        statusDetail: 'OK (WAL Active)',
      });
    } catch (err) {
      results.push({
        target: 'sqlite://local-database',
        labelArabic: 'قاعدة البيانات المحلية (SQLite)',
        reachable: false,
        rttMs: 0,
        statusDetail: err instanceof Error ? err.message : 'DB Error',
      });
    }

    return results;
  }

  /**
   * Generates a complete, sanitized HAR/JSON telemetry report buffer suitable for
   * sending to the administrator via Telegram `sendDocument` (`InputFile`).
   */
  public exportSanitizedReportJson(): {
    buffer: Buffer;
    fileName: string;
    entryCount: number;
  } {
    const metrics = this.getMetrics();
    const recentEntries = this.queryEntries({
      filter: 'ALL',
      page: 1,
      pageSize: this.maxEntries,
    }).items;

    const payload = {
      exportedAtIso: new Date().toISOString(),
      system: 'Botezz Network Traffic & Protocol Telemetry Inspector',
      redactionPolicy: 'STRICT_TOKEN_AND_KEY_REDACTION_ENABLED',
      metrics,
      entriesCount: recentEntries.length,
      entries: redactSensitiveData(recentEntries),
    };

    const jsonString = JSON.stringify(payload, null, 2);
    const buffer = Buffer.from(jsonString, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `botezz_network_telemetry_${stamp}.json`;

    return {
      buffer,
      fileName,
      entryCount: recentEntries.length,
    };
  }
}

const globalForNetworkMonitor = globalThis as unknown as {
  __botezzNetworkTrafficMonitor?: NetworkTrafficMonitor;
};

export function getNetworkTrafficMonitor(): NetworkTrafficMonitor {
  if (!globalForNetworkMonitor.__botezzNetworkTrafficMonitor) {
    const monitor = new NetworkTrafficMonitor(MAX_TRAFFIC_ENTRIES);
    monitor.installHttpInterceptors();
    globalForNetworkMonitor.__botezzNetworkTrafficMonitor = monitor;
  }
  return globalForNetworkMonitor.__botezzNetworkTrafficMonitor;
}
