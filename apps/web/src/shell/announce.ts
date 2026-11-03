import { createContext, useContext } from "react";

/** Sets the text of the shell's one polite live region. */
export const AnnounceContext = createContext<(text: string) => void>(() => undefined);

/** The shell's announcer; a no-op outside the shell (the landing has its own region). */
export function useAnnounce(): (text: string) => void {
  return useContext(AnnounceContext);
}
