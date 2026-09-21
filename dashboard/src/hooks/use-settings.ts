import { useState, useEffect, useRef } from 'react';
import { clearHermesStorage } from '@/lib/client-storage';
import { clientLog } from '@/lib/client/logger';

// Default settings values
export const DEFAULT_SETTINGS = {
  enableChatAutoScroll: true,
  enableStreamingAnimations: true,
  expandThinkingBlocks: false,
  reducedMotion: false,
  sessionExpiryHours: 24,
  memoryContextLimit: 2200,
  userContextLimit: 1375,
};

export type Settings = typeof DEFAULT_SETTINGS;

function clearHermesLocalCache(storage: Storage = localStorage) {
  clearHermesStorage(storage);
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);
  const loadSettingsTimeoutRef = useRef<number | null>(null);
  const loadStateTimeoutRef = useRef<number | null>(null);
  const syncTimeoutRef = useRef<number | null>(null);

  // Load from LocalStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('hermes_os_settings');
      if (stored) {
        loadSettingsTimeoutRef.current = window.setTimeout(() => {
          loadSettingsTimeoutRef.current = null;
          try {
            const parsed = JSON.parse(stored);
            setSettings((prev) => ({ ...prev, ...parsed }));
          } catch (e) {
            clientLog.error('Failed to load Hivra settings from localStorage', e, {
              source: 'use-settings',
              failureType: 'settings_local_storage_parse_failed',
            });
            try {
              localStorage.removeItem('hermes_os_settings');
            } catch (removeError) {
              clientLog.error('Failed to clear corrupted Hivra settings from localStorage', removeError, {
                source: 'use-settings',
                failureType: 'settings_local_storage_clear_failed',
              });
            }
          }
        }, 0);
      }
    } catch (e) {
      clientLog.error('Failed to load Hivra settings from localStorage', e, {
        source: 'use-settings',
        failureType: 'settings_local_storage_read_failed',
      });
    }

    loadStateTimeoutRef.current = window.setTimeout(() => {
      loadStateTimeoutRef.current = null;
      setIsLoaded(true);
    }, 0);

    return () => {
      if (loadSettingsTimeoutRef.current !== null) {
        window.clearTimeout(loadSettingsTimeoutRef.current);
        loadSettingsTimeoutRef.current = null;
      }

      if (loadStateTimeoutRef.current !== null) {
        window.clearTimeout(loadStateTimeoutRef.current);
        loadStateTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (syncTimeoutRef.current !== null) {
        window.clearTimeout(syncTimeoutRef.current);
        syncTimeoutRef.current = null;
      }
    };
  }, []);

  // Update Settings with partial payload
  const updateSettings = (partial: Partial<Settings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...partial };
      try {
        localStorage.setItem('hermes_os_settings', JSON.stringify(updated));
      } catch (e) {
        clientLog.error('Failed to save Hivra settings to localStorage', e, {
          source: 'use-settings',
          failureType: 'settings_local_storage_write_failed',
        });
      }

      // If any of the global context limits are updated, persist them to Cloud metadata
      if (
        'sessionExpiryHours' in partial ||
        'memoryContextLimit' in partial ||
        'userContextLimit' in partial
      ) {
        if (syncTimeoutRef.current) {
          window.clearTimeout(syncTimeoutRef.current);
        }
        
        syncTimeoutRef.current = window.setTimeout(() => {
          syncTimeoutRef.current = null;
          fetch('/api/settings/global', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionExpiryHours: updated.sessionExpiryHours,
              memoryContextLimit: updated.memoryContextLimit,
              userContextLimit: updated.userContextLimit,
            }),
          }).catch((err) => {
            clientLog.error('Failed to sync global context settings to Cloud', err, {
              source: 'use-settings',
              failureType: 'settings_cloud_sync_failed',
            });
          });
        }, 800);
      }

      return updated;
    });
  };

  const clearCacheAndReload = () => {
    clearHermesLocalCache();
    window.location.reload();
  };

  return {
    settings,
    updateSettings,
    clearCacheAndReload,
    isLoaded,
  };
}
