// Arc hides itself in navigator.userAgent (presents as Chrome), but injects
// CSS variables like --arc-palette-title on the :root element. Checking for
// the presence of this variable is the most reliable detection method.
export function isArcBrowser(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--arc-palette-title')
    .trim();
  return value.length > 0;
}
