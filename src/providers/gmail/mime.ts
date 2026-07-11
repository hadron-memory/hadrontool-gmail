/**
 * MIME construction + extraction for the Gmail API.
 *
 * Gmail traffics in raw RFC 2822: reads return a parsed part tree with
 * base64url-encoded bodies; sends and drafts accept a base64url-encoded raw
 * message. There is no Graph-style one-call `createReply`, so reply
 * semantics (Subject `Re:`, `In-Reply-To`/`References`, recipient
 * computation) live HERE, as pure functions — the provider client
 * orchestrates, tests exercise this module directly.
 */
import type { GmailMessage, MailAddress } from './types.js';

// ── Gmail API payload shapes (read side) ────────────────────────────────

export interface GmailApiHeader {
  name: string;
  value: string;
}

export interface GmailApiPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailApiHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailApiPart[];
}

export interface GmailApiMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailApiPart;
}

/** Case-insensitive header lookup. */
export function headerValue(headers: GmailApiHeader[] | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

/** Decode a base64url-encoded MIME part body to UTF-8 text. */
function decodePartData(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * Decode RFC 2047 encoded-words (`=?charset?B|Q?...?=`) in a header text.
 * Display names round-tripped from original headers arrive encoded; leaving
 * them encoded would re-emit `=?UTF-8?B?...?=` gibberish inside a
 * quoted-string on the build side (RFC 2047 §5 forbids that).
 */
export function decodeEncodedWords(text: string): string {
  return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _charset: string, enc: string, data: string) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
      // Q-encoding: underscore is space; =XX is a hex byte.
      const bytes: number[] = [];
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (ch === '_') bytes.push(0x20);
        else if (ch === '=' && i + 2 < data.length + 1) {
          bytes.push(parseInt(data.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(ch.charCodeAt(0));
      }
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return _m;
    }
  });
}

/**
 * Parse one mailbox in an address header: `"Name" <a@b>`, `Name <a@b>`, or
 * a bare `a@b`. Encoded-word display names are decoded. Returns null when no
 * address is present.
 */
export function parseAddress(raw: string): MailAddress | null {
  const angled = raw.match(/^\s*(?:"([^"]*)"|([^<]*?))\s*<([^>\s]+)>\s*$/);
  if (angled) {
    const name = (angled[1] ?? angled[2])?.trim();
    return { name: name ? decodeEncodedWords(name) : null, address: angled[3] };
  }
  const bare = raw.trim();
  if (bare.includes('@')) return { name: null, address: bare };
  return null;
}

/**
 * Parse a To/Cc header into addresses. Splits on commas that are outside
 * double quotes (display names may contain commas: `"Doe, Jane" <j@d.e>`).
 */
export function parseAddressList(raw: string | null): MailAddress[] {
  if (!raw) return [];
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of raw) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  tokens.push(current);
  return tokens
    .map((t) => parseAddress(t))
    .filter((a): a is MailAddress => a !== null);
}

/**
 * Extract the preferred body part from a payload tree: text/html over
 * text/plain, skipping attachment parts (non-empty filename). Depth-first
 * through nested multiparts.
 */
export function extractBody(payload: GmailApiPart | undefined): { contentType: string; content: string } | null {
  if (!payload) return null;
  let html: string | null = null;
  let plain: string | null = null;

  function walk(part: GmailApiPart): void {
    if (part.filename) return; // an attachment, not a body candidate
    const mimeType = part.mimeType ?? '';
    if (part.body?.data) {
      if (mimeType === 'text/html' && html == null) html = decodePartData(part.body.data);
      else if (mimeType === 'text/plain' && plain == null) plain = decodePartData(part.body.data);
    }
    for (const child of part.parts ?? []) walk(child);
  }
  walk(payload);

  if (html != null) return { contentType: 'html', content: html };
  if (plain != null) return { contentType: 'text', content: plain };
  return null;
}

/** True when any part of the tree is an attachment. */
export function hasAttachmentParts(payload: GmailApiPart | undefined): boolean {
  if (!payload) return false;
  function walk(part: GmailApiPart): boolean {
    if (part.filename && (part.body?.attachmentId || part.body?.data)) return true;
    return (part.parts ?? []).some(walk);
  }
  return (payload.parts ?? []).some(walk);
}

/** Parse a Gmail API message (format=full or format=metadata) into the
 *  provider-layer GmailMessage shape. */
export function parseGmailMessage(m: GmailApiMessage): GmailMessage {
  const headers = m.payload?.headers;
  const fromRaw = headerValue(headers, 'From');
  return {
    id: m.id,
    threadId: m.threadId ?? null,
    labelIds: m.labelIds ?? [],
    subject: headerValue(headers, 'Subject'),
    from: fromRaw ? parseAddress(fromRaw) : null,
    to: parseAddressList(headerValue(headers, 'To')),
    receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date(0).toISOString(),
    snippet: m.snippet ?? '',
    body: extractBody(m.payload),
    hasAttachments: hasAttachmentParts(m.payload),
  };
}

// ── Build side (compose / reply / drafts) ────────────────────────────────

/** Fold any CR/LF out of a header value — the header-injection guard every
 *  built header goes through. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** RFC 2047 encoded-word(s) for non-ASCII header text; ASCII passes through.
 *  Long text is chunked so each encoded-word stays ≤75 chars (RFC 2047 §2),
 *  chunks joined with folding whitespace. */
export function encodeHeaderText(text: string): string {
  const clean = sanitizeHeaderValue(text);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  // "=?UTF-8?B?" + base64 + "?=" ≤ 75 → ≤ 63 base64 chars → 45 input bytes;
  // chunk on UTF-8 byte boundaries by slicing characters greedily.
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = ch;
    } else {
      chunk += ch;
    }
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  return words.join('\r\n ');
}

/** Format one address for a To/Cc header. */
export function formatAddress(addr: MailAddress): string {
  const address = sanitizeHeaderValue(addr.address);
  if (!addr.name) return address;
  const name = sanitizeHeaderValue(addr.name);
  // eslint-disable-next-line no-control-regex
  const encoded = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/"/g, "'")}"` : encodeHeaderText(name);
  return `${encoded} <${address}>`;
}

export interface MimeInput {
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  bodyHtml: string;
  inReplyTo?: string | null;
  references?: string | null;
}

/** Wrap a base64 string at 76 chars (RFC 2045 line-length limit). */
function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

/**
 * Fold a header onto continuation lines at whitespace so no physical line
 * exceeds ~78 chars (RFC 5322 §2.2.3; hard cap 998). Long References chains
 * from deep threads are the usual offender. Pre-folded values (encoded-word
 * chunks already joined with CRLF+space) pass through per segment.
 */
function foldHeader(name: string, value: string): string {
  const out: string[] = [];
  let line = `${name}: `;
  const tokens = value.split(/(?<!\r\n) /); // spaces that aren't already folds
  for (const [i, token] of tokens.entries()) {
    const candidate = i === 0 ? line + token : `${line} ${token}`;
    if (i > 0 && candidate.length > 78) {
      out.push(line);
      line = ` ${token}`; // continuation line starts with folding whitespace
    } else {
      line = candidate;
    }
  }
  out.push(line);
  return out.join('\r\n');
}

/**
 * Build an RFC 2822 message: HTML body, base64 content-transfer-encoding
 * (avoids all line-length and bare-CRLF pitfalls), CRLF line endings,
 * long headers folded.
 */
export function buildMimeMessage(input: MimeInput): string {
  const lines: string[] = [];
  lines.push(foldHeader('To', input.to.map(formatAddress).join(', ')));
  if (input.cc && input.cc.length > 0) {
    lines.push(foldHeader('Cc', input.cc.map(formatAddress).join(', ')));
  }
  if (input.bcc && input.bcc.length > 0) {
    lines.push(foldHeader('Bcc', input.bcc.map(formatAddress).join(', ')));
  }
  lines.push(foldHeader('Subject', encodeHeaderText(input.subject)));
  if (input.inReplyTo) {
    lines.push(foldHeader('In-Reply-To', sanitizeHeaderValue(input.inReplyTo)));
  }
  if (input.references) {
    lines.push(foldHeader('References', sanitizeHeaderValue(input.references)));
  }
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(wrap76(Buffer.from(input.bodyHtml, 'utf8').toString('base64')));
  return lines.join('\r\n');
}

/** Encode a built MIME message for the Gmail API's `raw` field. */
export function toRawBase64Url(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/** `Re: <subject>` unless the subject already carries a reply prefix. */
export function replySubject(subject: string | null): string {
  const s = subject ?? '';
  return /^\s*re:/i.test(s) ? s : `Re: ${s}`;
}

export interface ReplySource {
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  /** The original's Reply-To addresses, when present — they take precedence
   *  over From as the reply target (RFC 5322 §3.6.2). */
  replyTo: MailAddress[];
}

/**
 * Compute reply recipients. Reply: the original sender (Reply-To first).
 * Reply-all: sender + everyone on To/Cc except the replying mailbox itself
 * (and minus duplicates).
 */
export function replyRecipients(
  original: ReplySource,
  selfEmail: string | null,
  replyAll: boolean,
): { to: MailAddress[]; cc: MailAddress[] } {
  const sender = original.replyTo.length > 0 ? original.replyTo : original.from ? [original.from] : [];
  if (!replyAll) return { to: sender, cc: [] };

  const seen = new Set<string>();
  const self = selfEmail?.toLowerCase() ?? null;
  const keep = (addr: MailAddress): boolean => {
    const key = addr.address.toLowerCase();
    if (key === self || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const to = [...sender, ...original.to].filter(keep);
  const cc = original.cc.filter(keep);
  return { to, cc };
}
