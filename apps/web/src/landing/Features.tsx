import { useEffect, useRef, useState, type ReactNode } from "react";
import { createAutoplay, type Autoplay } from "./autoplay";
import { landingCopy } from "./copy";

const t = landingCopy.features;
const PANEL_ID = "l-feature-panel";

// "Everything a vault should do": a five-item accordion beside a product panel that changes
// with it. One item is open at a time; it auto-advances every 6 s with a progress line while
// in view, and any click stops that for good (autoplay.ts).
export function Features({ reduced }: { reduced: boolean }) {
  const [open, setOpen] = useState(0);
  const [running, setRunning] = useState(false);
  // Bumped whenever the progress line must start over.
  const [cycle, setCycle] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const autoplay = useRef<Autoplay | null>(null);

  useEffect(() => {
    const controller = createAutoplay({
      count: t.items.length,
      reduced,
      onAdvance: (index) => {
        setOpen(index);
        setCycle((c) => c + 1);
      },
      onRunning: (value) => {
        setRunning(value);
        if (value) setCycle((c) => c + 1);
      },
    });
    autoplay.current = controller;
    const el = list.current;
    const observer =
      el && "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => entries.forEach((entry) => controller.setVisible(entry.isIntersecting)),
            { threshold: 0.4 },
          )
        : null;
    if (el) observer?.observe(el);
    return () => {
      observer?.disconnect();
      controller.dispose();
      autoplay.current = null;
    };
  }, [reduced]);

  return (
    <section className="l-feat" id="why" aria-labelledby="l-feat-title">
      <div>
        <h2 id="l-feat-title">
          {t.title[0]}
          <br />
          {t.title[1]}
        </h2>
        <div className="l-flist" ref={list}>
          {t.items.map((item, index) => (
            <button
              key={item.title}
              type="button"
              className="l-fi"
              aria-expanded={index === open}
              aria-controls={PANEL_ID}
              onClick={() => {
                if (autoplay.current) autoplay.current.choose(index);
                else setOpen(index);
              }}
            >
              <b>{item.title}</b>
              <span className="l-fi-body">{item.body}</span>
              <i
                key={`${index}-${cycle}`}
                className="l-fi-bar"
                aria-hidden="true"
                data-running={running && index === open ? "" : undefined}
              />
            </button>
          ))}
        </div>
      </div>
      <div className="l-panel" id={PANEL_ID}>
        <DelayPanel on={open === 0} />
        <GuardianPanel on={open === 1} />
        <DuressPanel on={open === 2} />
        <ProofPanel on={open === 3} />
        <EscapePanel on={open === 4} />
      </div>
    </section>
  );
}

function Panel({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <div className="l-pv" data-on={on ? "" : undefined} aria-hidden={!on}>
      {children}
    </div>
  );
}

function Rows({
  rows,
  className,
}: {
  rows: readonly (readonly [string, string])[];
  className: string;
}) {
  return (
    <dl className={`l-kv ${className}`}>
      {rows.map(([label, value]) => (
        <Row key={label} label={label} value={value} />
      ))}
    </dl>
  );
}

function Row({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={good ? "l-good" : undefined}>{value}</dd>
    </>
  );
}

function DelayPanel({ on }: { on: boolean }) {
  const d = t.delay;
  return (
    <Panel on={on}>
      <div className="l-lab">{d.label}</div>
      <h3>{d.title}</h3>
      <div className="l-track">
        <div className="l-lab">
          <span>{d.requested}</span>
          <span>{d.left}</span>
        </div>
        <div className="l-ticks" aria-hidden="true">
          {Array.from({ length: 24 }, (_, i) => (
            <i key={i} className={i < 1 ? "l-done" : i === 1 ? "l-now" : undefined} />
          ))}
        </div>
        <div className="l-ends">
          <span>
            {d.today} <b>{d.todayAt}</b>
          </span>
          <span>
            {d.executable} <b>{d.executableAt}</b>
          </span>
        </div>
      </div>
      <Rows rows={d.rows} className="l-kv-delay" />
    </Panel>
  );
}

function GuardianPanel({ on }: { on: boolean }) {
  const g = t.guardian;
  return (
    <Panel on={on}>
      <div className="l-lab">{g.label}</div>
      <h3>{g.title}</h3>
      <div className="l-alert">
        <div className="l-alert-t">
          <span>{g.source}</span>
          <span>{g.when}</span>
        </div>
        <h4>{g.alert}</h4>
        <Rows rows={g.rows} className="l-kv-alert" />
        <div className="l-alert-row">
          <span className="l-r">{g.sendHome}</span>
          <span>{g.itWasDaniel}</span>
        </div>
      </div>
    </Panel>
  );
}

function PinPad({ label }: { label: string }) {
  return (
    <div className="l-pin">
      <div className="l-lab">{label}</div>
      <div className="l-pin-dots" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="l-keys" aria-hidden="true">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((key) => (
          <span key={key}>{key}</span>
        ))}
      </div>
    </div>
  );
}

function DuressPanel({ on }: { on: boolean }) {
  const d = t.duress;
  return (
    <Panel on={on}>
      <div className="l-lab">{d.label}</div>
      <h3>{d.title}</h3>
      <div className="l-pins">
        <PinPad label={d.normal} />
        <PinPad label={d.duress} />
      </div>
      <p className="l-pin-note">{d.note}</p>
    </Panel>
  );
}

function ProofPanel({ on }: { on: boolean }) {
  const p = t.proof;
  return (
    <Panel on={on}>
      <div className="l-lab">{p.label}</div>
      <h3>{p.title}</h3>
      <dl className="l-kv l-kv-proof">
        {p.rows.map(([label, value]) => (
          <Row key={label} label={label} value={value} />
        ))}
        <Row label={p.address[0]} value={p.address[1]} good />
      </dl>
    </Panel>
  );
}

function EscapePanel({ on }: { on: boolean }) {
  const e = t.escape;
  return (
    <Panel on={on}>
      <div className="l-lab">{e.label}</div>
      <h3>{e.title}</h3>
      <div className="l-paths">
        {e.paths.map(([name, who, when]) => (
          <div key={name}>
            <b>{name}</b>
            <span>{who}</span>
            <em>{when}</em>
          </div>
        ))}
      </div>
    </Panel>
  );
}
