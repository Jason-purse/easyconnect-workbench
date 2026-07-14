const WINDOW_WIDTH_RATIO = 0.6;
const WINDOW_HEIGHT_RATIO = 0.8;
const MIN_WINDOW_WIDTH = 900;
const MIN_WINDOW_HEIGHT = 640;
const MIN_WINDOW_ASPECT_RATIO = 1.2;
const MAX_WINDOW_ASPECT_RATIO = 1.6;

export function calculateInitialWindowBounds(workArea) {
  const minWidth = Math.min(MIN_WINDOW_WIDTH, workArea.width);
  const minHeight = Math.min(MIN_WINDOW_HEIGHT, workArea.height);
  let width = Math.min(
    workArea.width,
    Math.max(minWidth, Math.round(workArea.width * WINDOW_WIDTH_RATIO)),
  );
  let height = Math.min(
    workArea.height,
    Math.max(minHeight, Math.round(workArea.height * WINDOW_HEIGHT_RATIO)),
  );

  if (width / height < MIN_WINDOW_ASPECT_RATIO) {
    height = Math.max(minHeight, Math.round(width / MIN_WINDOW_ASPECT_RATIO));
  } else if (width / height > MAX_WINDOW_ASPECT_RATIO) {
    width = Math.max(minWidth, Math.round(height * MAX_WINDOW_ASPECT_RATIO));
  }

  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
    minWidth,
    minHeight,
  };
}
