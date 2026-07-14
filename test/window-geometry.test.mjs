import test from "node:test";
import assert from "node:assert/strict";

import { calculateInitialWindowBounds } from "../src/services/window-geometry.js";

test("window geometry uses 60% width and 80% height of the active work area", () => {
  assert.deepEqual(
    calculateInitialWindowBounds({ x: 0, y: 24, width: 1920, height: 1080 }),
    {
      x: 384,
      y: 132,
      width: 1152,
      height: 864,
      minWidth: 900,
      minHeight: 640,
    },
  );
});

test("window geometry applies pixel minimums without exceeding a smaller work area", () => {
  assert.deepEqual(
    calculateInitialWindowBounds({ x: -800, y: 0, width: 1440, height: 900 }),
    {
      x: -530,
      y: 90,
      width: 900,
      height: 720,
      minWidth: 900,
      minHeight: 640,
    },
  );

  assert.deepEqual(
    calculateInitialWindowBounds({ x: 0, y: 0, width: 800, height: 600 }),
    {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      minWidth: 800,
      minHeight: 600,
    },
  );
});

test("window geometry remains proportional on large displays", () => {
  assert.deepEqual(
    calculateInitialWindowBounds({ x: 100, y: 50, width: 3840, height: 2160 }),
    {
      x: 868,
      y: 266,
      width: 2304,
      height: 1728,
      minWidth: 900,
      minHeight: 640,
    },
  );
});

test("window geometry avoids extreme shapes on portrait and ultrawide displays", () => {
  assert.deepEqual(
    calculateInitialWindowBounds({ x: 0, y: 88, width: 1920, height: 2041 }),
    {
      x: 384,
      y: 629,
      width: 1152,
      height: 960,
      minWidth: 900,
      minHeight: 640,
    },
  );

  assert.deepEqual(
    calculateInitialWindowBounds({ x: 0, y: 0, width: 3440, height: 1400 }),
    {
      x: 824,
      y: 140,
      width: 1792,
      height: 1120,
      minWidth: 900,
      minHeight: 640,
    },
  );
});
