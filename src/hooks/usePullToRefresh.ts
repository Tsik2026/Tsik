import { useEffect } from 'react';

/** Жест «потянуть вниз» вверху страницы → onRefresh; прогресс уходит в событие komfin:ptr */
export function usePullToRefresh(onRefresh: () => void, threshold = 72) {
  useEffect(() => {
    let startY = 0;
    let dy = 0;
    let pulling = false;

    const onStart = (e: TouchEvent) => {
      if (window.scrollY <= 0 && e.touches.length === 1) {
        startY = e.touches[0].clientY;
        dy = 0;
        pulling = true;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!pulling) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      window.dispatchEvent(new CustomEvent('komfin:ptr', { detail: { dy } }));
    };
    const onEnd = () => {
      if (!pulling) return;
      pulling = false;
      const pulled = dy;
      dy = 0;
      window.dispatchEvent(new CustomEvent('komfin:ptr', { detail: { dy: 0 } }));
      if (pulled >= threshold && window.scrollY <= 0) onRefresh();
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [onRefresh, threshold]);
}
