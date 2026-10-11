import { useEffect } from 'react';

const SELECTED = ':scope > .selected, :scope > [aria-checked="true"], :scope > [aria-selected="true"]';

/** Places the shared indicator of every segmented control under its chosen option, so a change of
 *  choice slides instead of jumping. Purely visual: the buttons keep their own state and styles. */
function place(control: HTMLElement) {
  const chosen = control.querySelector<HTMLElement>(SELECTED);
  if (!chosen || !chosen.offsetWidth) { control.classList.remove('has-indicator', 'seg-ready'); return; }
  control.style.setProperty('--seg-x', `${chosen.offsetLeft}px`);
  control.style.setProperty('--seg-y', `${chosen.offsetTop}px`);
  control.style.setProperty('--seg-w', `${chosen.offsetWidth}px`);
  control.style.setProperty('--seg-h', `${chosen.offsetHeight}px`);
  // The first placement appears in place; only later changes animate.
  if (!control.classList.contains('has-indicator')) { control.classList.add('has-indicator'); requestAnimationFrame(() => control.classList.add('seg-ready')); }
}

export function useSegmentedIndicator() {
  useEffect(() => {
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; document.querySelectorAll<HTMLElement>('.segmented').forEach(place); }); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-checked', 'aria-selected'] });
    window.addEventListener('resize', schedule);
    schedule();
    return () => { observer.disconnect(); window.removeEventListener('resize', schedule); cancelAnimationFrame(frame); };
  }, []);
}
