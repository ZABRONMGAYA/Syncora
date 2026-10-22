import { describe, expect, it } from "vitest";

import { type FirstCutSettings, cutOptions } from "../src/state/edit";

const SETTINGS: FirstCutSettings = {
  style: "wedding",
  minShot: null,
  maxShot: null,
  tightenPauses: true,
  useReviewClips: false,
  format: "xmeml",
};

describe("first cut options", () => {
  it("leaves the style's own shot lengths to the engine", () => {
    expect(cutOptions(SETTINGS, {})).toEqual({ tighten_pauses: true, use_review_clips: false });
  });

  it("sends the lengths the editor chose", () => {
    expect(cutOptions({ ...SETTINGS, minShot: 2.5, maxShot: 8 }, {})).toMatchObject({ min_shot_s: 2.5, max_shot_s: 8 });
  });

  it("sends speaker cameras for podcasts only", () => {
    const angles = { S01: "cam-1" };
    expect(cutOptions({ ...SETTINGS, style: "podcast" }, angles).speaker_angles).toEqual(angles);
    expect(cutOptions(SETTINGS, angles).speaker_angles).toBeUndefined();
  });
});
