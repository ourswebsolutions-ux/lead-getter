// Light/dark theme. The user's choice is kept in localStorage; without one,
// the operating system's preference is followed (and tracked live).

const KEY = 'lead-finder-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function storedTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function apply(theme, animate) {
  const root = document.documentElement;
  if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('theme-anim');
    clearTimeout(apply.t);
    apply.t = setTimeout(() => root.classList.remove('theme-anim'), 380);
  }
  root.dataset.theme = theme;
  window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

// Called before the first render, so the right theme paints immediately.
export function initTheme() {
  apply(storedTheme() || (media.matches ? 'dark' : 'light'), false);
  media.addEventListener('change', (e) => {
    if (!storedTheme()) apply(e.matches ? 'dark' : 'light', true);
  });
}

export function setTheme(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable: the choice still applies for this session.
  }
  apply(theme, true);
}
