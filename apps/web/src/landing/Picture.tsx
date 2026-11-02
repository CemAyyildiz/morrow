import type { ComponentProps } from "react";
import type { ImageSet } from "./assets";

/** AVIF, then WebP, then the JPG fallback. */
export function Picture({
  image,
  alt,
  ...img
}: { image: ImageSet; alt: string } & Omit<ComponentProps<"img">, "src" | "alt">) {
  return (
    <picture>
      <source srcSet={image.avif} type="image/avif" />
      <source srcSet={image.webp} type="image/webp" />
      <img src={image.jpg} alt={alt} width={image.width} height={image.height} {...img} />
    </picture>
  );
}
