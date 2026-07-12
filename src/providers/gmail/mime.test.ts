import { describe, expect, it } from 'vitest';
import {
  buildMimeMessage,
  decodeEncodedWords,
  encodeHeaderText,
  extractBody,
  formatAddress,
  hasAttachmentParts,
  parseAddress,
  parseAddressList,
  parseGmailMessage,
  replyRecipients,
  replySubject,
  toRawBase64Url,
  type GmailApiPart,
} from './mime.js';

/** base64url-encode a UTF-8 string the way the Gmail API does. */
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

describe('parseAddress / parseAddressList', () => {
  it('parses bare, angled, and quoted forms', () => {
    expect(parseAddress('a@b.c')).toEqual({ name: null, address: 'a@b.c' });
    expect(parseAddress('Jane Doe <jane@d.e>')).toEqual({ name: 'Jane Doe', address: 'jane@d.e' });
    expect(parseAddress('"Doe, Jane" <jane@d.e>')).toEqual({ name: 'Doe, Jane', address: 'jane@d.e' });
    expect(parseAddress('<bare@angle.com>')).toEqual({ name: null, address: 'bare@angle.com' });
    expect(parseAddress('no address here')).toBeNull();
  });

  it('splits lists on commas outside quotes only', () => {
    const list = parseAddressList('"Doe, Jane" <jane@d.e>, Bob <bob@x.y>, solo@x.y');
    expect(list).toEqual([
      { name: 'Doe, Jane', address: 'jane@d.e' },
      { name: 'Bob', address: 'bob@x.y' },
      { name: null, address: 'solo@x.y' },
    ]);
  });

  it('returns [] for a missing header', () => {
    expect(parseAddressList(null)).toEqual([]);
  });

  it('decodes RFC 2047 encoded-word display names (B and Q)', () => {
    const b64 = Buffer.from('Ümit Öz', 'utf8').toString('base64');
    expect(parseAddress(`=?UTF-8?B?${b64}?= <u@x.y>`)).toEqual({ name: 'Ümit Öz', address: 'u@x.y' });
    expect(parseAddress('=?UTF-8?Q?J=C3=BCrgen_M?= <j@x.y>')).toEqual({ name: 'Jürgen M', address: 'j@x.y' });
    expect(decodeEncodedWords('plain text')).toBe('plain text');
  });

  it('round-trips a non-ASCII display name: parse → build re-encodes, never nests encoded-words in quotes', () => {
    const b64 = Buffer.from('Grüße GmbH', 'utf8').toString('base64');
    const parsed = parseAddress(`=?UTF-8?B?${b64}?= <g@x.y>`)!;
    const rebuilt = formatAddress(parsed);
    // Encoded-word emitted bare (RFC 2047 §5 forbids it inside quotes)…
    expect(rebuilt).toMatch(/^=\?UTF-8\?B\?.+\?= <g@x\.y>$/);
    // …and it decodes back to the original name, not double-encoded gibberish.
    expect(decodeEncodedWords(rebuilt.split(' <')[0])).toBe('Grüße GmbH');
  });
});

describe('extractBody / hasAttachmentParts', () => {
  const htmlPart: GmailApiPart = { mimeType: 'text/html', body: { data: b64url('<p>Hi ☕</p>') } };
  const plainPart: GmailApiPart = { mimeType: 'text/plain', body: { data: b64url('Hi') } };

  it('reads a single-part body', () => {
    expect(extractBody(htmlPart)).toEqual({ contentType: 'html', content: '<p>Hi ☕</p>' });
    expect(extractBody(plainPart)).toEqual({ contentType: 'text', content: 'Hi' });
  });

  it('prefers html over plain in multipart/alternative', () => {
    const payload: GmailApiPart = { mimeType: 'multipart/alternative', parts: [plainPart, htmlPart] };
    expect(extractBody(payload)?.contentType).toBe('html');
    expect(extractBody(payload)?.content).toBe('<p>Hi ☕</p>');
  });

  it('descends nested multiparts and skips attachment parts', () => {
    const payload: GmailApiPart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [plainPart, htmlPart] },
        { mimeType: 'text/html', filename: 'page.html', body: { attachmentId: 'att-1' } },
        { mimeType: 'application/pdf', filename: 'doc.pdf', body: { attachmentId: 'att-2' } },
      ],
    };
    expect(extractBody(payload)).toEqual({ contentType: 'html', content: '<p>Hi ☕</p>' });
    expect(hasAttachmentParts(payload)).toBe(true);
  });

  it('reports no attachments for a body-only message', () => {
    const payload: GmailApiPart = { mimeType: 'multipart/alternative', parts: [plainPart, htmlPart] };
    expect(hasAttachmentParts(payload)).toBe(false);
    expect(hasAttachmentParts(htmlPart)).toBe(false);
  });

  it('returns null body for headers-only (metadata format) payloads', () => {
    expect(extractBody({ mimeType: 'text/html' })).toBeNull();
    expect(extractBody(undefined)).toBeNull();
  });
});

describe('parseGmailMessage', () => {
  it('parses headers, labels, timestamps, and the body', () => {
    const parsed = parseGmailMessage({
      id: 'm-1',
      threadId: 't-1',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'When are your…',
      internalDate: '1783502400000',
      payload: {
        mimeType: 'text/html',
        headers: [
          { name: 'Subject', value: 'Office hours' },
          { name: 'From', value: 'A Student <student@example.edu>' },
          { name: 'To', value: 'The Professor <prof@example.edu>' },
        ],
        body: { data: b64url('<p>When?</p>') },
      },
    });
    expect(parsed).toMatchObject({
      id: 'm-1',
      threadId: 't-1',
      labelIds: ['INBOX', 'UNREAD'],
      subject: 'Office hours',
      from: { name: 'A Student', address: 'student@example.edu' },
      to: [{ name: 'The Professor', address: 'prof@example.edu' }],
      snippet: 'When are your…',
      body: { contentType: 'html', content: '<p>When?</p>' },
      hasAttachments: false,
    });
    expect(parsed.receivedAt).toBe(new Date(1783502400000).toISOString());
  });
});

describe('buildMimeMessage', () => {
  const to = [{ name: null, address: 'a@b.c' }];

  it('builds headers + base64 body, CRLF-separated', () => {
    const mime = buildMimeMessage({ to, subject: 'Hello', bodyHtml: '<p>Hi</p>' });
    const [head, body] = mime.split('\r\n\r\n');
    expect(head).toContain('To: a@b.c');
    expect(head).toContain('Subject: Hello');
    expect(head).toContain('MIME-Version: 1.0');
    expect(head).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(head).toContain('Content-Transfer-Encoding: base64');
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('<p>Hi</p>');
  });

  it('round-trips a non-ASCII body through base64', () => {
    const bodyHtml = '<p>Grüße — 你好 ☕</p>';
    const mime = buildMimeMessage({ to, subject: 's', bodyHtml });
    const body = mime.split('\r\n\r\n')[1];
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(bodyHtml);
  });

  it('wraps the base64 body at 76 chars (RFC 2045)', () => {
    const mime = buildMimeMessage({ to, subject: 's', bodyHtml: 'x'.repeat(500) });
    const body = mime.split('\r\n\r\n')[1];
    for (const line of body.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('encodes a non-ASCII subject as an RFC 2047 encoded word', () => {
    const mime = buildMimeMessage({ to, subject: 'Grüße aus Köln', bodyHtml: 'x' });
    const subjectLine = mime.split('\r\n').find((l) => l.startsWith('Subject:'))!;
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const encoded = subjectLine.match(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/)![1];
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('Grüße aus Köln');
  });

  it('adds Cc / Bcc / In-Reply-To / References only when present', () => {
    const bare = buildMimeMessage({ to, subject: 's', bodyHtml: 'x' });
    expect(bare).not.toContain('Cc:');
    expect(bare).not.toContain('Bcc:');
    expect(bare).not.toContain('In-Reply-To:');
    expect(bare).not.toContain('References:');

    const full = buildMimeMessage({
      to,
      cc: [{ name: null, address: 'cc@b.c' }],
      bcc: [{ name: null, address: 'bcc@b.c' }],
      subject: 's',
      bodyHtml: 'x',
      inReplyTo: '<orig@id>',
      references: '<root@id> <orig@id>',
    });
    expect(full).toContain('Cc: cc@b.c');
    expect(full).toContain('Bcc: bcc@b.c');
    expect(full).toContain('In-Reply-To: <orig@id>');
    expect(full).toContain('References: <root@id> <orig@id>');
  });

  it('folds long headers so no physical line exceeds 998 chars (RFC 5322)', () => {
    const references = Array.from({ length: 60 }, (_, i) => `<message-id-${i}@some.long.example.host>`).join(' ');
    const mime = buildMimeMessage({ to, subject: 's', bodyHtml: 'x', references });
    const head = mime.split('\r\n\r\n')[0];
    for (const line of head.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
    // Folded continuation lines start with whitespace and the value survives.
    expect(head.replace(/\r\n /g, ' ')).toContain(references);
  });

  it('chunks long non-ASCII subjects into ≤75-char encoded-words', () => {
    const subject = 'Grüße '.repeat(30);
    const mime = buildMimeMessage({ to, subject, bodyHtml: 'x' });
    const encodedWords = mime.match(/=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/g)!;
    expect(encodedWords.length).toBeGreaterThan(1);
    for (const word of encodedWords) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    const decoded = encodedWords
      .map((w) => Buffer.from(w.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(subject.trim());
  });

  it('folds header-injection attempts out of every header', () => {
    const mime = buildMimeMessage({
      to: [{ name: 'Evil\r\nBcc: victim@x.y', address: 'a@b.c\r\nX-Injected: 1' }],
      subject: 'hi\r\nX-Also-Injected: 1',
      bodyHtml: 'x',
      inReplyTo: '<a>\r\nX-More: 1',
    });
    // CR/LF fold to a space, so injected text stays INSIDE a header value —
    // the property that matters is that no injected name starts a header LINE.
    const headerNames = mime
      .split('\r\n\r\n')[0]
      .split('\r\n')
      .map((l) => l.split(':')[0]);
    expect(headerNames).toEqual(['To', 'Subject', 'In-Reply-To', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding']);
  });

  it('toRawBase64Url produces a decodable Gmail raw field', () => {
    const mime = buildMimeMessage({ to, subject: 's', bodyHtml: 'x' });
    expect(Buffer.from(toRawBase64Url(mime), 'base64url').toString('utf8')).toBe(mime);
  });
});

describe('encodeHeaderText / formatAddress', () => {
  it('passes ASCII through and encodes non-ASCII', () => {
    expect(encodeHeaderText('plain ascii')).toBe('plain ascii');
    expect(encodeHeaderText('Grüße')).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });

  it('quotes ASCII display names and encodes non-ASCII ones', () => {
    expect(formatAddress({ name: null, address: 'a@b.c' })).toBe('a@b.c');
    expect(formatAddress({ name: 'Jane Doe', address: 'a@b.c' })).toBe('"Jane Doe" <a@b.c>');
    expect(formatAddress({ name: 'Müller', address: 'a@b.c' })).toMatch(/^=\?UTF-8\?B\?.+\?= <a@b\.c>$/);
  });
});

describe('replySubject', () => {
  it('prefixes Re: once', () => {
    expect(replySubject('Office hours')).toBe('Re: Office hours');
    expect(replySubject('Re: Office hours')).toBe('Re: Office hours');
    expect(replySubject('RE: Office hours')).toBe('RE: Office hours');
    expect(replySubject(null)).toBe('Re: ');
  });
});

describe('replyRecipients', () => {
  const original = {
    from: { name: 'Sender', address: 'sender@x.y' },
    to: [
      { name: null, address: 'me@self.io' },
      { name: null, address: 'other@x.y' },
    ],
    cc: [
      { name: null, address: 'cc1@x.y' },
      { name: null, address: 'ME@SELF.IO' },
    ],
    replyTo: [],
  };

  it('replies to the sender only (no reply-all)', () => {
    expect(replyRecipients(original, 'me@self.io', false)).toEqual({
      to: [{ name: 'Sender', address: 'sender@x.y' }],
      cc: [],
    });
  });

  it('reply-all keeps everyone except self (case-insensitive) and dedupes', () => {
    const { to, cc } = replyRecipients(original, 'me@self.io', true);
    expect(to.map((a) => a.address)).toEqual(['sender@x.y', 'other@x.y']);
    expect(cc.map((a) => a.address)).toEqual(['cc1@x.y']);
  });

  it('prefers Reply-To over From', () => {
    const withReplyTo = { ...original, replyTo: [{ name: null, address: 'list@x.y' }] };
    expect(replyRecipients(withReplyTo, 'me@self.io', false).to).toEqual([{ name: null, address: 'list@x.y' }]);
  });

  it('handles a missing From gracefully', () => {
    const noFrom = { ...original, from: null };
    expect(replyRecipients(noFrom, 'me@self.io', false).to).toEqual([]);
  });
});
