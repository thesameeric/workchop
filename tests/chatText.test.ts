import { describe, expect, it } from 'vitest';
import {
  channelNameError,
  cleanMessageText,
  cleanTopic,
  dmKey,
  dmPartner,
  isReactionEmoji,
  normalizeChannelName,
  parseMentionTokens,
  toggleReaction,
  type ChatMention,
} from '../shared/chat';
import { isJumbo, labelsToTokens, parseInline, parseMessage, plainText, tokensToLabels } from '../shared/chatText';

describe('message formatting', () => {
  it('parses bold, italic, code, links and line breaks', () => {
    expect(parseInline('a **bold** and _italic_ `x*y` text')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'b', c: [{ t: 'text', v: 'bold' }] },
      { t: 'text', v: ' and ' },
      { t: 'i', c: [{ t: 'text', v: 'italic' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'x*y' },
      { t: 'text', v: ' text' },
    ]);
    expect(parseInline('line one\nline two')).toEqual([{ t: 'text', v: 'line one' }, { t: 'br' }, { t: 'text', v: 'line two' }]);
    expect(parseInline('**see _this_ `now`**')).toEqual([
      { t: 'b', c: [{ t: 'text', v: 'see ' }, { t: 'i', c: [{ t: 'text', v: 'this' }] }, { t: 'text', v: ' ' }, { t: 'code', v: 'now' }] },
    ]);
  });

  it('leaves snake_case, lone markers and code contents alone', () => {
    expect(parseInline('my_var_name and 2 * 3 ** 4')).toEqual([{ t: 'text', v: 'my_var_name and 2 * 3 ** 4' }]);
    expect(parseInline('`**not bold**`')).toEqual([{ t: 'code', v: '**not bold**' }]);
    expect(parseInline('** spaced **')).toEqual([{ t: 'text', v: '** spaced **' }]);
  });

  it('links http(s) URLs only, without the punctuation after them', () => {
    expect(parseInline('Docs: https://example.com/a_b_c?x=1. More (https://en.wikipedia.org/wiki/Foo_(bar)), ok')).toEqual([
      { t: 'text', v: 'Docs: ' },
      { t: 'link', href: 'https://example.com/a_b_c?x=1' },
      { t: 'text', v: '. More (' },
      { t: 'link', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { t: 'text', v: '), ok' },
    ]);
    expect(parseInline('javascript:alert(1) and ftp://x.org')).toEqual([{ t: 'text', v: 'javascript:alert(1) and ftp://x.org' }]);
    // HTML is just text.
    expect(parseInline('<b>hi</b> <img src=x onerror=alert(1)>')).toEqual([{ t: 'text', v: '<b>hi</b> <img src=x onerror=alert(1)>' }]);
  });

  it('finds mentions', () => {
    expect(parseInline('hi <@u:abc123> and <@p:Xy_9-Z> <!here>!')).toEqual([
      { t: 'text', v: 'hi ' },
      { t: 'mention', kind: 'user', id: 'abc123' },
      { t: 'text', v: ' and ' },
      { t: 'mention', kind: 'player', id: 'Xy_9-Z' },
      { t: 'text', v: ' ' },
      { t: 'mention', kind: 'here' },
      { t: 'text', v: '!' },
    ]);
    expect(parseMentionTokens('<@u:a> <@u:a> <!here> <@p:b> <@x:c>')).toEqual([
      { kind: 'user', id: 'a' },
      { kind: 'here' },
      { kind: 'player', id: 'b' },
    ]);
  });

  it('splits code blocks from paragraphs, dropping a language name', () => {
    expect(parseMessage('Try this:\n```js\nconst a = 1;\n  **b**\n```\nthen _go_')).toEqual([
      { t: 'p', c: [{ t: 'text', v: 'Try this:' }] },
      { t: 'pre', v: 'const a = 1;\n  **b**' },
      { t: 'p', c: [{ t: 'text', v: 'then ' }, { t: 'i', c: [{ t: 'text', v: 'go' }] }] },
    ]);
    expect(parseMessage('```inline```')).toEqual([{ t: 'pre', v: 'inline' }]);
    expect(parseMessage('unclosed ``` block')).toEqual([{ t: 'p', c: [{ t: 'text', v: 'unclosed ``` block' }] }]);
  });

  it('gives a plain one-line preview', () => {
    const mentions: ChatMention[] = [{ kind: 'user', id: 'u1', name: 'Mia' }, { kind: 'here' }];
    expect(plainText('**Hey** <@u:u1>, <!here> <@u:gone>\n`npm test` ok', mentions)).toBe('Hey @Mia, @here @unknown npm test ok');
    expect(plainText('x'.repeat(200), [], 10)).toBe('xxxxxxxxx…');
  });

  it('stays quick on long, unusual messages, and leaves overlong links as text', () => {
    const tricky = ['http://a' + ')'.repeat(3990), '**x '.repeat(1000), '**a'.repeat(1333), '**_**_**_**_'.repeat(333), ('http://a(' + ')'.repeat(10)).repeat(200)];
    const started = performance.now();
    for (const text of tricky) {
      parseMessage(text);
      plainText(text, []);
    }
    // Each took up to hundreds of milliseconds when link endings were trimmed one ")" at a time.
    expect(performance.now() - started).toBeLessThan(150);
    expect(parseInline('see http://a.io/x)))')).toEqual([{ t: 'text', v: 'see ' }, { t: 'link', href: 'http://a.io/x' }, { t: 'text', v: ')))' }]);
    const long = `https://example.com/${'a'.repeat(2100)}`;
    expect(parseInline(`${long} **ok**`)).toEqual([{ t: 'text', v: `${long} ` }, { t: 'b', c: [{ t: 'text', v: 'ok' }] }]);
    expect(parseInline('**a** b **c**')).toEqual([{ t: 'b', c: [{ t: 'text', v: 'a' }] }, { t: 'text', v: ' b ' }, { t: 'b', c: [{ t: 'text', v: 'c' }] }]);
    expect(parseInline('**no end')).toEqual([{ t: 'text', v: '**no end' }]);
  });

  it('spots emoji-only messages', () => {
    expect(isJumbo('🎉')).toBe(true);
    expect(isJumbo('👍🏽 ❤️')).toBe(true);
    expect(isJumbo('🎉 yay')).toBe(false);
    expect(isJumbo('123')).toBe(false);
  });
});

describe('mention labels in the composer', () => {
  it('turn into tokens as whole words only', () => {
    const picks = [
      { label: '@Ann', token: '<@u:ann>' },
      { label: '@Ann Lee', token: '<@u:annlee>' },
    ];
    expect(labelsToTokens('@Ann Lee and @Ann, but not @Anna or me@Ann_x; @here!', picks)).toBe('<@u:annlee> and <@u:ann>, but not @Anna or me@Ann_x; <!here>!');
  });

  it('come back from tokens to edit a message', () => {
    const mentions: ChatMention[] = [{ kind: 'user', id: 'ann', name: 'Ann' }, { kind: 'player', id: 'p1', name: 'Gus' }, { kind: 'here' }];
    const back = tokensToLabels('<@u:ann> <@p:p1> <!here> <@u:x> <@u:ann>', mentions);
    expect(back.text).toBe('@Ann @Gus @here @unknown @Ann');
    expect(back.picks).toEqual([
      { label: '@Ann', token: '<@u:ann>' },
      { label: '@Gus', token: '<@p:p1>' },
    ]);
    expect(labelsToTokens(back.text, back.picks)).toBe('<@u:ann> <@p:p1> <!here> @unknown <@u:ann>');
  });
});

describe('chat rules', () => {
  it('normalize and check channel names', () => {
    expect(normalizeChannelName('  #Design Team ')).toBe('design-team');
    expect(channelNameError('design-team')).toBeNull();
    expect(channelNameError('a_b-1')).toBeNull();
    expect(channelNameError('')).toMatch(/name/);
    expect(channelNameError('héllo')).toMatch(/lowercase/);
    expect(channelNameError('-_-')).toMatch(/letter or number/);
    expect(channelNameError('x'.repeat(33))).toMatch(/32/);
  });

  it('clean message text and topics', () => {
    expect(cleanMessageText(' a\r\nb\u0000c\td ')).toBe('a\nbc\td');
    expect(cleanMessageText(42)).toBe('');
    expect(cleanMessageText('😀'.repeat(3000))).toHaveLength(4000);
    expect(cleanTopic(' One\ntwo   three ')).toBe('One two three');
  });

  it('accept emoji reactions only', () => {
    for (const ok of ['👍', '❤️', '👍🏽', '🇫🇷', '👨‍👩‍👧']) expect(isReactionEmoji(ok)).toBe(true);
    for (const bad of ['a', '1', ':)', '👍x', '', ' 👍', '<b>']) expect(isReactionEmoji(bad)).toBe(false);
  });

  it('toggle reactions per person', () => {
    const ann = { id: 'u:ann', name: 'Ann' };
    const bob = { id: 'p:bob', name: 'Bob' };
    let r = toggleReaction([], '👍', ann)!;
    r = toggleReaction(r, '👍', bob)!;
    r = toggleReaction(r, '🎉', bob)!;
    expect(r).toEqual([
      { emoji: '👍', by: [ann, bob] },
      { emoji: '🎉', by: [bob] },
    ]);
    r = toggleReaction(r, '👍', ann)!;
    r = toggleReaction(r, '🎉', bob)!;
    expect(r).toEqual([{ emoji: '👍', by: [bob] }]);
    const full = Array.from({ length: 20 }, (_, i) => ({ emoji: String(i), by: [ann] }));
    expect(toggleReaction(full, '👍', ann)).toBeNull();
  });

  it('key direct messages by the two people', () => {
    expect(dmKey('b', 'a')).toBe('a:b');
    expect(dmKey('a', 'b')).toBe('a:b');
    expect(dmPartner('a:b', 'a')).toBe('b');
    expect(dmPartner('a:b', 'b')).toBe('a');
  });
});
