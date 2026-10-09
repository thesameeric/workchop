import { useEffect, useState } from 'react';
import type { VerifyAnswer } from '../../../../shared/billing';
import { errorText } from '../../lib/account';
import { ApiError } from '../../lib/api';
import { goHome, navigate } from '../../lib/router';
import { canSignIn, useStore } from '../../state/store';
import { SignInOptions } from '../../ui/Account';
import { LobbyMessage } from '../../ui/Lobby';
import { verifyPayment } from './api';

// /billing/return: where Paystack sends people after paying (?reference=…&trxref=…). The server
// checks the payment with Paystack; a payment Paystack hasn't confirmed yet is asked about again for a
// minute (its webhook settles it later either way).

const POLL_MS = 3000;
const WAIT_MS = 60_000;
/** Paid: the workspace opens after this long. */
const OPEN_MS = 1500;

export function ReturnPage() {
  const ready = useStore((s) => s.accountReady);
  const accountId = useStore((s) => s.account?.id ?? null);
  const signIn = useStore(canSignIn);
  const params = new URLSearchParams(location.search);
  const reference = params.get('reference') ?? params.get('trxref');
  const here = location.pathname + location.search;
  const [answer, setAnswer] = useState<VerifyAnswer | null>(null);
  const [asking, setAsking] = useState(true);
  // 'sign-in', or what went wrong.
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Asked again after signing in here, and with "Check again".
  useEffect(() => {
    if (!reference || !ready) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setAsking(true);
    setProblem(null);
    const check = async () => {
      try {
        const a = await verifyPayment(reference);
        if (!alive) return;
        setAnswer(a);
        if (a.status === 'pending' && Date.now() - started < WAIT_MS) timer = setTimeout(() => void check(), POLL_MS);
        else setAsking(false);
      } catch (err) {
        if (!alive) return;
        setAsking(false);
        setProblem(err instanceof ApiError && err.status === 401 ? 'sign-in' : errorText(err));
      }
    };
    void check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [reference, ready, accountId, attempt]);

  const paidFor = answer?.status === 'succeeded' ? answer.officeId : undefined;
  useEffect(() => {
    if (!paidFor) return;
    const timer = setTimeout(() => navigate(`/o/${paidFor}`, { replace: true }), OPEN_MS);
    return () => clearTimeout(timer);
  }, [paidFor]);

  /** Back to the workspace's Billing, or home when we don't know which (or may not say). */
  const back = (officeId: string | undefined, primary = true) => (
    <button className={`btn wide${primary ? ' primary' : ''}`} onClick={() => (officeId ? navigate(`/o/${officeId}?billing`, { replace: true }) : goHome('/', { replace: true }))}>
      {officeId ? 'Back to workspace' : 'Back home'}
    </button>
  );
  const again = (
    <button className="btn wide" onClick={() => setAttempt((n) => n + 1)}>
      Check again
    </button>
  );

  if (!reference) return <LobbyMessage title="No payment here" text="This page shows how a payment went, but its address doesn’t name one.">{back(undefined)}</LobbyMessage>;
  if (problem === 'sign-in') {
    return (
      <LobbyMessage title="Sign in to finish" text="Sign in with the account you paid from to see how the payment went.">
        {signIn ? (
          <div className="lobby-sign-in">
            <SignInOptions next={here} />
          </div>
        ) : (
          back(undefined)
        )}
      </LobbyMessage>
    );
  }
  if (problem) {
    return (
      <LobbyMessage title="Couldn’t check the payment" text={problem}>
        <div className="lobby-message-actions">
          {again}
          {back(answer?.officeId, false)}
        </div>
      </LobbyMessage>
    );
  }
  if (!answer || (answer.status === 'pending' && asking)) return <LobbyMessage title="Checking your payment…" text="This takes a few seconds." />;
  if (answer.status === 'succeeded') {
    return (
      <LobbyMessage title="Payment received" text={answer.officeId ? `Thank you! Opening ${answer.officeName ?? 'your workspace'}…` : 'Thank you!'}>
        {!answer.officeId && back(undefined)}
      </LobbyMessage>
    );
  }
  if (answer.status === 'pending') {
    return (
      <LobbyMessage title="Waiting for Paystack" text="Paystack hasn’t confirmed the payment yet. It can take a few minutes; your workspace updates by itself once it does.">
        <div className="lobby-message-actions">
          {again}
          {back(answer.officeId, false)}
        </div>
      </LobbyMessage>
    );
  }
  return (
    <LobbyMessage
      title={answer.status === 'failed' ? 'Payment didn’t go through' : 'Payment not finished'}
      text="Nothing was charged. You can try again from Billing in your workspace."
    >
      {back(answer.officeId)}
    </LobbyMessage>
  );
}
