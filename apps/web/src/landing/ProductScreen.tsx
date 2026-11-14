import type { Ref } from "react";
import { useAppData } from "@/app/data";
import { AttemptLog } from "@/components/AttemptLog";
import { XRaySteps } from "@/components/XRaySteps";
import { Sidebar } from "@/shell/Sidebar";
import { ChallengeScreen } from "@/views/ChallengeView";
import type { DemoView } from "./demo";

interface ProductProps {
  demo: DemoView;
  onTry?: (() => void) | undefined;
  /** "Download keys" leads to the real Challenge screen. */
  onDownload?: (() => void) | undefined;
  tryRef?: Ref<HTMLButtonElement> | undefined;
}

// The real product inside the hero: the shell's sidebar and the Challenge screen, at the
// fixed 1440 × 930 the product is designed at. `.frame-desktop` makes every `desktop:` style
// apply whatever the viewport (theme.css), so the laptop shows the desktop layout on phones.
export function DesktopProduct({ demo, onTry, onDownload, tryRef }: ProductProps) {
  const { config } = useAppData();
  return (
    <div className="frame-desktop l-frame">
      <Sidebar activeId="challenge" config={config} decorative />
      <div className="l-frame-main">
        <ChallengeScreen
          data={demo.data}
          headingLevel={2}
          illustration={demo.illustration}
          onTry={onTry}
          onDownload={onDownload}
          tryRef={tryRef}
        >
          <div className="l-frame-bottom">
            <AttemptLog rows={demo.rows} />
            <XRaySteps steps={demo.steps} />
          </div>
        </ChallengeScreen>
      </div>
    </div>
  );
}

// The same screen re-flowed for phones, where the dive ends: no sidebar, one column, the log
// hidden and the X-Ray kept (EXPERIENCE.md, Responsive).
export function PhoneProduct({ demo, onTry, onDownload, tryRef }: ProductProps) {
  return (
    <div className="l-mob-main">
      <ChallengeScreen
        data={demo.data}
        headingLevel={2}
        illustration={demo.illustration}
        onTry={onTry}
        onDownload={onDownload}
        tryRef={tryRef}
      >
        <AttemptLog rows={demo.rows} />
        <XRaySteps steps={demo.steps} />
      </ChallengeScreen>
    </div>
  );
}
