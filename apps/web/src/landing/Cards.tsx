import type { ReactNode } from "react";
import { landingCopy } from "./copy";

const t = landingCopy.cards;

// "Built for the worst night": four cream cards, each a small composition of floating product
// fragments (decorative) over a title and a line of copy. One column on phones. The blurred
// "ghost" fragments hold text-free lines (`l-gl`) instead of text: under the blur they look
// the same, and no deliberately unreadable text is left on the page (story 9.5).
export function Cards() {
  return (
    <section className="l-cards" aria-labelledby="l-cards-title">
      <h2 id="l-cards-title">
        {t.title[0]}
        <br />
        {t.title[1]}
      </h2>
      <Card heading={t.alerts.heading} body={t.alerts.body}>
        <div className="l-frag l-f-alert">
          <div className="l-mono l-mono-mu">{t.alerts.source}</div>
          <div className="l-strong">{t.alerts.title}</div>
        </div>
        <div className="l-frag l-ghost l-f-alert-ghost">
          <div className="l-mono l-mono-mu">
            <span className="l-gl l-gl-src" />
          </div>
          <div className="l-strong">
            <span className="l-gl l-gl-title" />
          </div>
        </div>
        <div className="l-frag l-f-send">{t.alerts.action}</div>
      </Card>
      <Card heading={t.proof.heading} body={t.proof.body}>
        <div className="l-frag l-frag-dark l-mono l-f-hash">
          {t.proof.hash}
          <br />
          {t.proof.address}
        </div>
        <div className="l-frag l-f-match">{t.proof.match}</div>
        <div className="l-frag l-ghost l-mono l-f-code">
          <span className="l-gl l-gl-code" />
        </div>
      </Card>
      <Card heading={t.kit.heading} body={t.kit.body}>
        <div className="l-frag l-f-kit">
          <svg width="28" height="34" viewBox="0 0 28 34">
            <path d="M2 2h16l8 8v22H2z" fill="#16151A" />
            <path d="M18 2v8h8" fill="#6B6760" />
          </svg>
          <div>
            <b>{t.kit.file}</b>
            <div className="l-mono l-mono-mu">{t.kit.size}</div>
          </div>
        </div>
        <div className="l-frag l-mono l-f-escape">{t.kit.escape}</div>
        <div className="l-frag l-ghost l-mono l-f-nonear">
          <span className="l-gl l-gl-nonear" />
        </div>
      </Card>
      <Card heading={t.pin.heading} body={t.pin.body}>
        <div className="l-frag l-frag-dark l-f-pin">
          <div className="l-mono l-mono-mu">{t.pin.label}</div>
          <div className="l-f-dots">
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="l-frag l-frag-dark l-ghost l-f-pin-ghost">
          <div className="l-mono l-mono-mu">
            <span className="l-gl l-gl-pin" />
          </div>
        </div>
      </Card>
    </section>
  );
}

function Card({ heading, body, children }: { heading: string; body: string; children: ReactNode }) {
  return (
    <div>
      <div className="l-cv" aria-hidden="true">
        {children}
      </div>
      <h3 className="l-ct">{heading}</h3>
      <p className="l-cd">{body}</p>
    </div>
  );
}
