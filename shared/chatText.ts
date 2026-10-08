import { findMention, type ChatMention } from './chat';

// Chat messages' light formatting, parsed into a tree the client renders as React elements (never
// as HTML): **bold**, _italic_, `code`, ```code blocks```, http(s) links, line breaks and mentions.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string }
  | { t: 'mention'; kind: 'user' | 'player' | 'here'; id?: string };

export type Block = { t: 'p'; c: Inline[] } | { t: 'pre'; v: string };

const CODE_BLOCK = /```([\s\S]*?)```/g;
/** Code, a mention token, a link, **bold** or _italic_; the first that starts earliest wins. */
const INLINE = /`([^`\n]+)`|<@([up]):([A-Za-z0-9_-]{1,40})>|(<!here>)|(https?:\/\/[^\s<>"]+)|\*\*(?=\S)([\s\S]*?\S)\*\*|_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const MAX_DEPTH = 4;

/** A link without the punctuation that usually ends the sentence around it. */
function trimUrl(url: string): string {
  for (;;) {
    if (/[.,;:!?'"\]*_]$/.test(url)) url = url.slice(0, -1);
    else if (url.endsWith(')') && url.split('(').length < url.split(')').length) url = url.slice(0, -1);
    else return url;
  }
}

function pushText(out: Inline[], v: string): void {
  const lines = v.split('\n');
  lines.forEach((line, i) => {
    if (i > 0) out.push({ t: 'br' });
    if (!line) return;
    const last = out[out.length - 1];
    if (last?.t === 'text') last.v += line;
    else out.push({ t: 'text', v: line });
  });
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  const re = new RegExp(INLINE.source, INLINE.flags);
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index;
    let end = start + m[0].length;
    let node: Inline | null = null;
    if (m[1] !== undefined) node = { t: 'code', v: m[1] };
    else if (m[2] !== undefined) node = { t: 'mention', kind: m[2] === 'u' ? 'user' : 'player', id: m[3] };
    else if (m[4] !== undefined) node = { t: 'mention', kind: 'here' };
    else if (m[5] !== undefined) {
      const href = trimUrl(m[5]);
      if (href.length > 'https://'.length) {
        node = { t: 'link', href };
        end = start + href.length;
      }
    } else if (m[6] !== undefined) node = depth < MAX_DEPTH ? { t: 'b', c: parseInline(m[6], depth + 1) } : null;
    // _italic_ only at a word's edge, so snake_case_names stay as they are.
    else if (m[7] !== undefined && (start === 0 || !WORD_CHAR.test(s[start - 1]))) node = depth < MAX_DEPTH ? { t: 'i', c: parseInline(m[7], depth + 1) } : null;
    if (!node) {
      // Not formatting after all: keep the first character as text and look again after it.
      re.lastIndex = start + 1;
      continue;
    }
    if (start > at) pushText(out, s.slice(at, start));
    out.push(node);
    at = end;
    re.lastIndex = end;
  }
  if (at < s.length) pushText(out, s.slice(at));
  return out;
}

/** A message's text as paragraphs and code blocks. */
export function parseMessage(text: string): Block[] {
  const blocks: Block[] = [];
  const paragraph = (s: string) => {
    const trimmed = s.replace(/^\n+|\n+$/g, '');
    if (trimmed) blocks.push({ t: 'p', c: parseInline(trimmed) });
  };
  let at = 0;
  for (const m of text.matchAll(CODE_BLOCK)) {
    paragraph(text.slice(at, m.index));
    // A language name on the first line (```js) isn't part of the code.
    const code = m[1].replace(/^[A-Za-z0-9+#.-]{1,20}\n/, '').replace(/^\n+|\n+$/g, '');
    blocks.push({ t: 'pre', v: code });
    at = m.index + m[0].length;
  }
  paragraph(text.slice(at));
  return blocks;
}

function mentionLabel(mentions: ChatMention[], kind: 'user' | 'player' | 'here', id?: string): string {
  const m = findMention(mentions, kind, id);
  return m ? (m.kind === 'here' ? '@here' : `@${m.name}`) : '@unknown';
}

function flatten(nodes: Inline[], mentions: ChatMention[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
          return n.v;
        case 'br':
          return ' ';
        case 'link':
          return n.href;
        case 'mention':
          return mentionLabel(mentions, n.kind, n.id);
        default:
          return flatten(n.c, mentions);
      }
    })
    .join('');
}

/** A message as one line of plain text, e.g. for a notification; at most `max` characters. */
export function plainText(text: string, mentions: ChatMention[], max = 140): string {
  const flat = parseMessage(text)
    .map((b) => (b.t === 'pre' ? b.v : flatten(b.c, mentions)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${[...flat].slice(0, max - 1).join('').trimEnd()}…` : flat;
}

/** A mention picked in the composer: the label shown while typing ("@Ann") and the token sent. */
export interface MentionPick {
  label: string;
  token: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The composer's text with the labels of picked mentions (and any "@here") replaced by their
 * tokens. A label only counts as a whole word, so "@Ann" doesn't turn "@Anna" into a mention.
 */
export function labelsToTokens(text: string, picks: MentionPick[]): string {
  const byLabel = new Map<string, string>([['@here', '<!here>']]);
  for (const p of picks) if (!byLabel.has(p.label)) byLabel.set(p.label, p.token);
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  return text.replace(new RegExp(`(${labels.join('|')})(?![\\p{L}\\p{N}_])`, 'gu'), (label) => byLabel.get(label) ?? label);
}

/** The other way round, to edit a sent message: tokens become labels again. */
export function tokensToLabels(text: string, mentions: ChatMention[]): { text: string; picks: MentionPick[] } {
  const picks: MentionPick[] = [];
  const out = text.replace(/<@([up]):([A-Za-z0-9_-]{1,40})>|<!here>/g, (token, kind?: string, id?: string) => {
    const label = token === '<!here>' ? '@here' : mentionLabel(mentions, kind === 'u' ? 'user' : 'player', id);
    if (label !== '@here' && label !== '@unknown' && !picks.some((p) => p.token === token)) picks.push({ label, token });
    return label;
  });
  return { text: out, picks };
}

const JUMBO = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[‍️⃣\s])+$/u;

/** A short message of only emoji, shown bigger. */
export function isJumbo(text: string): boolean {
  return text.length > 0 && text.length <= 24 && JUMBO.test(text) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text);
}
