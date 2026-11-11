import type { ComponentProps } from "react";
import type { ImageSet } from "./assets";

/**
 * AVIF, then WebP, then the JPG fallback. With `image` null the element is drawn with no
 * source yet (nothing is requested, and an empty `alt` so no alt text is drawn in its place)
 * and gets its sources once `image` is set: the hero's stills wait this way. Pass `width` and
 * `height` for such an image.
 */
export function Picture({
  image,
  alt,
  ...img
}: { image: ImageSet | null; alt: string } & Omit<ComponentProps<"img">, "src" | "alt">) {
  return (
    <picture>
      {image && <source srcSet={image.avif} type="image/avif" />}
      {image && <source srcSet={image.webp} type="image/webp" />}
      <img
        src={image?.jpg}
        alt={image ? alt : ""}
        width={image?.width}
        height={image?.height}
        {...img}
      />
    </picture>
  );
}
