'use client';

import { useState, useEffect, useSyncExternalStore } from 'react';

/**
 * Hook to detect if a media query matches
 * Uses useSyncExternalStore for proper hydration handling
 * @param query - CSS media query string (e.g., '(min-width: 768px)')
 * @returns boolean indicating if the query matches
 */
export function useMediaQuery(query: string): boolean {
  // Use useSyncExternalStore for proper SSR/hydration handling
  const subscribe = (callback: () => void) => {
    if (typeof window === 'undefined') return () => {};
    const mediaQuery = window.matchMedia(query);
    mediaQuery.addEventListener('change', callback);
    return () => mediaQuery.removeEventListener('change', callback);
  };

  const getSnapshot = () => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  };

  const getServerSnapshot = () => false;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Hook to detect desktop mode (tablet and above)
 * Uses 768px as the breakpoint (Tailwind's md breakpoint)
 * Add ?mobile=true to URL to force mobile mode for testing
 */
export function useIsDesktop(): boolean {
  const mediaMatch = useMediaQuery('(min-width: 768px)');
  const [forceMobile, setForceMobile] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setForceMobile(params.get('mobile') === 'true');
  }, []);

  return forceMobile ? false : mediaMatch;
}

/**
 * Hook to detect large desktop (lg breakpoint and above)
 * Uses 1024px as the breakpoint
 */
export function useIsLargeDesktop(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
