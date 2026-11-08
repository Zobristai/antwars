// The front page's hero (Field guide): its one still frame of a stored match. The frame is tick 13441 of
// the public replay below, the peak of its two-sided fight: the 3D board seen low from the west, read signed out through
// the client's own capture mode, with no labels. From a 2880 × 1620 master, a 2880 × 1280 desktop crop and a
// 1053 × 1620 phone crop; each file here is one of those crops as an opaque WebP, at full size or resampled to the width
// it names.

/** One encoded size of a crop. */
export interface HeroFile {
  readonly src: string;
  /** Pixel width; the height follows from the crop's proportions. */
  readonly width: number;
}
/** One crop of the frame, in the sizes the browser chooses from. */
export interface HeroCrop {
  /** The crop's full pixel size: the largest file's, and the proportions every file keeps. */
  readonly width: number;
  readonly height: number;
  /** Smallest first. */
  readonly files: readonly HeroFile[];
}
export interface HeroFrame {
  /** The recording's public replay id (its UTC start stamp and sequence), which also dates it. */
  readonly replayId: string;
  /** The recording's map, as its record names it. */
  readonly map: string;
  readonly desktop: HeroCrop;
  readonly phone: HeroCrop;
}

export const HERO: HeroFrame = {
  replayId: "2026-10-28T02-56-44-192Z-130372309286179",
  map: "Isthmus",
  desktop: {
    width: 2880, height: 1280,
    files: [
      { src: new URL("./hero-desktop-1440.webp", import.meta.url).href, width: 1440 },
      { src: new URL("./hero-desktop-2880.webp", import.meta.url).href, width: 2880 },
    ],
  },
  phone: {
    width: 1053, height: 1620,
    files: [
      { src: new URL("./hero-phone-702.webp", import.meta.url).href, width: 702 },
      { src: new URL("./hero-phone-1053.webp", import.meta.url).href, width: 1053 },
    ],
  },
};
