import { useState, useEffect, useRef } from 'react';
import { clearHermesStorage } from '@/lib/client-storage';

function clearHermesLocalCache(storage: Storage = localStorage) {
  clearHermesStorage(storage);
}

export function useSettings() {
  const [isLoaded, setIsLoaded] = useState(false);
  const loadStateTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    loadStateTimeoutRef.current = window.setTimeout(() => {
      loadStateTimeoutRef.current = null;
      setIsLoaded(true);
    }, 0);

    return () => {
      if (loadStateTimeoutRef.current !== null) {
        window.clearTimeout(loadStateTimeoutRef.current);
        loadStateTimeoutRef.current = null;
      }
    };
  }, []);

  const clearCacheAndReload = () => {
    clearHermesLocalCache();
    window.location.reload();
  };

  return {
    clearCacheAndReload,
    isLoaded,
  };
}
