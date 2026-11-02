// Every landing asset goes through Vite, so it ships content-hashed under /assets. Stills and
// tiles come as AVIF and WebP with a JPG fallback; the encode commands are in the story 9.1
// spec (Implementation Notes).
import heroGoldAvif from "@/assets/landing/hero-gold.avif";
import heroGoldJpg from "@/assets/landing/hero-gold.jpg";
import heroGoldWebp from "@/assets/landing/hero-gold.webp";
import heroPoster from "@/assets/landing/hero-poster.jpg";
import heroAvif from "@/assets/landing/hero.avif";
import heroJpg from "@/assets/landing/hero.jpg";
import heroMp4 from "@/assets/landing/hero.mp4";
import heroWebp from "@/assets/landing/hero.webp";
import cloudsAvif from "@/assets/landing/tiles/clouds.avif";
import cloudsJpg from "@/assets/landing/tiles/clouds.jpg";
import cloudsWebp from "@/assets/landing/tiles/clouds.webp";
import drawerAvif from "@/assets/landing/tiles/drawer.avif";
import drawerJpg from "@/assets/landing/tiles/drawer.jpg";
import drawerWebp from "@/assets/landing/tiles/drawer.webp";
import emmaAvif from "@/assets/landing/tiles/emma.avif";
import emmaJpg from "@/assets/landing/tiles/emma.jpg";
import emmaWebp from "@/assets/landing/tiles/emma.webp";
import nightphoneAvif from "@/assets/landing/tiles/nightphone.avif";
import nightphoneJpg from "@/assets/landing/tiles/nightphone.jpg";
import nightphoneWebp from "@/assets/landing/tiles/nightphone.webp";
import timelockAvif from "@/assets/landing/tiles/timelock.avif";
import timelockJpg from "@/assets/landing/tiles/timelock.jpg";
import timelockWebp from "@/assets/landing/tiles/timelock.webp";
import vaultdoorAvif from "@/assets/landing/tiles/vaultdoor.avif";
import vaultdoorJpg from "@/assets/landing/tiles/vaultdoor.jpg";
import vaultdoorWebp from "@/assets/landing/tiles/vaultdoor.webp";

export interface ImageSet {
  avif: string;
  webp: string;
  jpg: string;
  width: number;
  height: number;
}

export const HERO: ImageSet = {
  avif: heroAvif,
  webp: heroWebp,
  jpg: heroJpg,
  width: 5504,
  height: 3072,
};
export const HERO_GOLD: ImageSet = {
  avif: heroGoldAvif,
  webp: heroGoldWebp,
  jpg: heroGoldJpg,
  width: 5504,
  height: 3072,
};
export const HERO_VIDEO = heroMp4;
export const HERO_POSTER = heroPoster;

const tile = (avif: string, webp: string, jpg: string): ImageSet => ({
  avif,
  webp,
  jpg,
  width: 900,
  height: 900,
});

export type TileName = "timelock" | "emma" | "vaultdoor" | "nightphone" | "drawer" | "clouds";

export interface Tile {
  name: TileName;
  image: ImageSet;
}

export const TILE: Readonly<Record<TileName, Tile>> = {
  timelock: { name: "timelock", image: tile(timelockAvif, timelockWebp, timelockJpg) },
  emma: { name: "emma", image: tile(emmaAvif, emmaWebp, emmaJpg) },
  vaultdoor: { name: "vaultdoor", image: tile(vaultdoorAvif, vaultdoorWebp, vaultdoorJpg) },
  nightphone: { name: "nightphone", image: tile(nightphoneAvif, nightphoneWebp, nightphoneJpg) },
  drawer: { name: "drawer", image: tile(drawerAvif, drawerWebp, drawerJpg) },
  clouds: { name: "clouds", image: tile(cloudsAvif, cloudsWebp, cloudsJpg) },
};
