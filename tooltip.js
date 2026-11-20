// Tooltips for any element with a data-tip attribute.
//
// Shown on mouse hover (after a short delay) and on keyboard focus, so they
// aren't mouse-only. Escape dismisses them, and the pointer can move onto the
// tooltip without it closing (WCAG 1.4.13). They're hidden from assistive
// technology because every button's accessible name already says the same
// thing, and reading it twice would just add noise.

const HOVER_DELAY = 400;
const HIDE_DELAY = 100;
const GAP = 8;
const EDGE = 8;

const tip = document.createElement('div');
tip.className = 'tooltip';
tip.setAttribute('aria-hidden', 'true');
tip.hidden = true;
document.body.append(tip);

let target = null;
let showTimer = 0;
let hideTimer = 0;

function place() {
  if (!target) return;
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  let top = r.top - t.height - GAP;
  let below = false;
  if (top < EDGE) { top = r.bottom + GAP; below = true; }
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(EDGE, Math.min(left, vw - t.width - EDGE));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
  tip.classList.toggle('tooltip-below', below);
  // Point the arrow at the middle of the button even when the box was clamped.
  tip.style.setProperty('--arrow-x', `${Math.round(r.left + r.width / 2 - left)}px`);
}

function show(el) {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  const text = el.dataset.tip;
  if (!text) return hide();
  target = el;
  tip.textContent = text;
  tip.hidden = false;
  place();
}

export function hideTip() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  tip.hidden = true;
  target = null;
}
const hide = hideTip;

function hideSoon() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, HIDE_DELAY);
}

// Re-reads the text of the open tooltip, e.g. after Play becomes Pause.
export function refreshTip() {
  if (!target) return;
  if (!target.isConnected) return hide();
  tip.textContent = target.dataset.tip || '';
  place();
}

document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  if (tip.contains(e.target)) { clearTimeout(hideTimer); return; }
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  if (el === target) { clearTimeout(hideTimer); return; }
  clearTimeout(showTimer);
  // Moving straight from one button to the next feels sluggish with a delay.
  showTimer = setTimeout(() => show(el), target ? 0 : HOVER_DELAY);
});

document.addEventListener('pointerout', (e) => {
  if (e.pointerType !== 'mouse') return;
  const from = e.target.closest('[data-tip]') || (tip.contains(e.target) ? tip : null);
  if (!from) return;
  const to = e.relatedTarget;
  if (to && (from.contains(to) || tip.contains(to) || (target && target.contains(to)))) return;
  clearTimeout(showTimer);
  if (target) hideSoon();
});

document.addEventListener('focusin', (e) => {
  const el = e.target.closest && e.target.closest('[data-tip]');
  if (el && el.matches(':focus-visible')) show(el);
  else if (target) hide();
});

document.addEventListener('focusout', (e) => {
  if (target && e.target === target) hideSoon();
});

document.addEventListener('pointerdown', () => { if (target) hide(); }, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && target) {
    hide();
    e.stopPropagation();
  }
});

window.addEventListener('scroll', () => { if (target) place(); }, { passive: true });
window.addEventListener('resize', () => { if (target) place(); });
