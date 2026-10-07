import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage } from '../../../shared/types';
import { colorFor } from '../lib/color';
import { getSession } from '../lib/session';
import { setState, useStore } from '../state/store';

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scopeLabel(m: ChatMessage, selfId: string | null, names: Record<string, string>): string | null {
  if (m.scope === 'nearby') return 'nearby';
  if (m.scope === 'dm') return m.from === selfId ? `to ${names[m.to ?? ''] ?? 'someone'}` : 'direct';
  return null;
}

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const selfId = useStore((s) => s.selfId);
  const players = useStore((s) => s.players);
  const target = useStore((s) => s.chatTarget);
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const names = Object.fromEntries(Object.entries(players).map(([id, p]) => [id, p.name]));

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chat.length]);

  useEffect(() => {
    input.current?.focus();
  }, [target]);

  // A DM target that left falls back to everyone.
  useEffect(() => {
    if (target.scope === 'dm' && target.to && !players[target.to]) setState({ chatTarget: { scope: 'all' } });
  }, [players, target]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    getSession()?.chat(body, target);
    setText('');
  };

  const targetValue = target.scope === 'dm' ? `dm:${target.to}` : target.scope;
  return (
    <div className="panel-body chat">
      <div className="chat-list" ref={list}>
        {chat.length === 0 && <p className="muted center">No messages yet. Say hi 👋</p>}
        {chat.map((m) => {
          const label = scopeLabel(m, selfId, names);
          return (
            <div key={m.id} className={`chat-msg${m.from === selfId ? ' own' : ''}`}>
              <div className="chat-meta">
                <span className="chat-name" style={{ color: colorFor(m.name) }}>
                  {m.from === selfId ? 'You' : m.name}
                </span>
                {label && <span className={`chat-scope ${m.scope}`}>{label}</span>}
                <span className="muted">{time(m.ts)}</span>
              </div>
              <div className="chat-text">{m.text}</div>
            </div>
          );
        })}
      </div>
      <form className="chat-form" onSubmit={send}>
        <select
          value={targetValue}
          onChange={(e) => {
            const v = e.target.value;
            setState({ chatTarget: v.startsWith('dm:') ? { scope: 'dm', to: v.slice(3) } : { scope: v as 'all' | 'nearby' } });
          }}
          aria-label="Send to"
        >
          <option value="all">Everyone</option>
          <option value="nearby">Nearby</option>
          {Object.entries(players).map(([id, p]) => (
            <option key={id} value={`dm:${id}`}>
              {p.name}
            </option>
          ))}
        </select>
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Message…" maxLength={1000} />
        <button className="btn primary" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
