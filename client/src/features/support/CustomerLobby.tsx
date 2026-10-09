import { useState } from 'react';
import { normalizeEmail } from '../../../../shared/account';
import { randomAvatar } from '../../../../shared/avatar';
import { MAX_CUSTOMER_EMAIL, MAX_CUSTOMER_NAME, MAX_FIRST_MESSAGE } from '../../../../shared/support';
import type { OfficeInfo } from '../../../../shared/workspace';
import { finePointer } from '../../lib/touch';
import { AvatarPreview } from '../../ui/AvatarEditor';
import { ShuffleIcon, SupportIcon } from '../../ui/icons';
import { DeviceCheck, useJoin } from '../../ui/Lobby';
import { forgetMe, forgetOpen, loadSaved, prepareVisit, type Question } from './state';

/** Why a question can't be sent yet, or null. */
export function questionProblem(q: Question): string | null {
  if (!q.name) return 'Tell us your name.';
  if (q.email && !normalizeEmail(q.email)) return 'That email address doesn’t look right.';
  if (!q.message) return 'Tell us what you need help with.';
  return null;
}

/**
 * The name, email and question fields (the lobby's, and the office's "Another question?"). With
 * `autoFocus`, the name (or the question, when the name is known) takes the focus, except on touch
 * screens, where that pops up the keyboard.
 */
export function QuestionFields({ q, onChange, autoFocus }: { q: Question; onChange: (q: Question) => void; autoFocus?: boolean }) {
  const focus = !!autoFocus && finePointer();
  return (
    <>
      <label className="field">
        <span>Your name</span>
        <input value={q.name} onChange={(e) => onChange({ ...q, name: e.target.value })} maxLength={MAX_CUSTOMER_NAME} autoComplete="name" autoFocus={focus && !q.name} />
      </label>
      <label className="field">
        <span>
          Email <span className="field-optional">optional, so we can follow up</span>
        </span>
        <input type="email" value={q.email} onChange={(e) => onChange({ ...q, email: e.target.value })} maxLength={MAX_CUSTOMER_EMAIL} autoComplete="email" />
      </label>
      <label className="field">
        <span>How can we help?</span>
        <textarea
          value={q.message}
          onChange={(e) => onChange({ ...q, message: e.target.value })}
          maxLength={MAX_FIRST_MESSAGE}
          rows={4}
          placeholder="A few words about what you need"
          autoFocus={focus && !!q.name}
        />
      </label>
    </>
  );
}

export const cleanQuestion = (q: Question): Question => ({ name: q.name.trim(), email: q.email.trim(), message: q.message.trim() });

/**
 * The lobby of a support workspace's customers (its guests): your question, a random character and the
 * mic check, then into the queue. Back with a ticket that was open, it's one click to see where it stands.
 */
export function CustomerLobby({ info }: { info: OfficeInfo }) {
  const [saved, setSaved] = useState(() => loadSaved(info.id));
  const [resume, setResume] = useState(!!saved.open);
  const [q, setQ] = useState<Question>({ name: saved.name, email: saved.email, message: '' });
  const [remember, setRemember] = useState(saved.remember);
  // Back here, you look as you did last time.
  const [avatar, setAvatar] = useState(() => saved.avatar ?? randomAvatar());
  const [problem, setProblem] = useState<string | null>(null);
  const clean = cleanQuestion(q);
  const { join, joining, error } = useJoin(info, () => prepareVisit(info.id, resume ? null : clean, avatar, remember));

  // Someone else on this computer: nothing of theirs stays (their key, name, email or question).
  const startOver = () => {
    forgetMe(info.id);
    setSaved(loadSaved(info.id));
    setResume(false);
    setQ({ name: '', email: '', message: '' });
    setRemember(false);
    setAvatar(randomAvatar());
  };
  const notYou = (saved.name || saved.open) && (
    <button type="button" className="link-btn" onClick={startOver}>
      Not you? Start over
    </button>
  );

  return (
    <form
      className="lobby-body support-lobby"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const why = resume ? null : questionProblem(clean);
        setProblem(why);
        if (!why) void join();
      }}
    >
      <section className="card support-ask">
        <header className="support-ask-head">
          <span className="support-ask-icon">
            <SupportIcon size={24} />
          </span>
          <div>
            <h2>{resume ? `Welcome back${saved.name ? `, ${saved.name.split(' ')[0]}` : ''}` : `Hi! Welcome to ${info.name}`}</h2>
            <p className="muted">
              {resume
                ? 'Come back in to see where your question stands.'
                : 'Tell us what you need, then look around while you wait. When it’s your turn, we’ll walk you to a desk.'}
            </p>
          </div>
        </header>
        {resume ? (
          <div className="support-lobby-links">
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                forgetOpen(info.id);
                setResume(false);
              }}
            >
              Ask something else instead
            </button>
            {notYou}
          </div>
        ) : (
          <>
            <QuestionFields
              q={q}
              onChange={(next) => {
                setQ(next);
                setProblem(null);
              }}
              autoFocus
            />
            <label className="support-remember">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>
                Remember me on this device
                <span className="muted small">Leave it off on a shared computer: your name and email are forgotten when we’re done.</span>
              </span>
            </label>
            {notYou && <div className="support-lobby-links">{notYou}</div>}
          </>
        )}
        {problem && (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}
        <div className="support-look">
          <AvatarPreview avatar={avatar} height={150} />
          <div>
            <strong>You’ll look like this</strong>
            <p className="muted small">Others will see you as a visitor number; staff see your name.</p>
            <button type="button" className="btn small" onClick={() => setAvatar(randomAvatar())}>
              <ShuffleIcon size={16} /> New look
            </button>
          </div>
        </div>
      </section>
      <DeviceCheck
        joinLabel={resume ? 'Continue' : 'Join the queue'}
        canJoin
        joining={joining}
        error={error}
        note="Staff hear you once you’re called. Other visitors never do."
      />
    </form>
  );
}
