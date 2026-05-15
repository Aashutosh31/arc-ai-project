import { useEffect, useMemo, useState } from 'react';

const getViewportWidth = () => {
  if (typeof window === 'undefined') return 1440;
  return window.innerWidth || document.documentElement.clientWidth || 1440;
};

const classifyWorkspaceMode = (width) => {
  if (width >= 1400) return 'desktop-wide';
  if (width >= 1000) return 'desktop-compact';
  if (width >= 700) return 'tablet';
  return 'mobile';
};

export const useWorkspaceViewport = () => {
  const [viewportWidth, setViewportWidth] = useState(getViewportWidth);

  useEffect(() => {
    const handleResize = () => setViewportWidth(getViewportWidth());
    handleResize();
    window.addEventListener('resize', handleResize, { passive: true });
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return useMemo(() => {
    const workspaceMode = classifyWorkspaceMode(viewportWidth);
    return {
      viewportWidth,
      workspaceMode,
      isDesktopWide: workspaceMode === 'desktop-wide',
      isDesktopCompact: workspaceMode === 'desktop-compact',
      isTablet: workspaceMode === 'tablet',
      isMobile: workspaceMode === 'mobile'
    };
  }, [viewportWidth]);
};
