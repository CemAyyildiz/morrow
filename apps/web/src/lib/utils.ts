import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the DESIGN.md scales, so `text-numeral` (a size) and `text-ok`
// (a color) are not treated as one conflicting class.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "display",
        "section",
        "numeral-hero",
        "numeral",
        "body",
        "label",
        "mono",
        "marquee",
        "wordmark",
      ],
      radius: ["device"],
      spacing: ["gutter", "gutter-mobile", "card-pad", "card-pad-mobile", "stack"],
      breakpoint: ["desktop"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
