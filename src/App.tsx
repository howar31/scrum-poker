import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePokerStore } from './store/usePokerStore';
import Home from './components/Home';
import Room from './components/Room';
import Toast from './components/Toast';
import MigrationOverlay from './components/MigrationOverlay';
import { peerManager } from './utils/peerManager';
import { Sparkles, Moon, Sun, Link2, LogOut, Languages, MoreVertical } from 'lucide-react';

function App() {
  const { t, i18n } = useTranslation();
  const {
    roomId,
    isConnected,
    theme,
    toggleTheme,
    animationsEnabled,
    setAnimationsEnabled,
    pushToast,
  } = usePokerStore();

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (roomId) {
      url.searchParams.set('room', roomId);
    } else {
      url.searchParams.delete('room');
    }
    window.history.replaceState({}, '', url.toString());
  }, [roomId]);

  // Prevent accidental refresh / tab close while inside a room. Modern
  // browsers show their own "Leave site?" dialog — the custom string is
  // ignored but returnValue must be set for the prompt to appear.
  useEffect(() => {
    if (!roomId) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [roomId]);

  // Centralised close so outside-click, Escape, and the leave confirmation
  // all go through the same path that also disarms the leave-confirm state.
  const closeMenu = () => {
    setMenuOpen(false);
    setConfirmingLeave(false);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const handleCopyId = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId);
    pushToast({ message: t('app.roomIdCopied'), variant: 'success' });
  };

  const handleCopyLink = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(window.location.href);
    pushToast({ message: t('app.linkCopied'), variant: 'success' });
  };

  const handleLeave = () => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    if (!confirmingLeave) {
      // First click: arm confirmation. Auto-cancel after 3s of inaction so
      // the dangerous state doesn't stay primed indefinitely.
      setConfirmingLeave(true);
      confirmTimerRef.current = setTimeout(() => setConfirmingLeave(false), 3000);
      return;
    }
    closeMenu();
    peerManager.leave();
    usePokerStore.getState().leaveRoom();
  };

  const toggleLanguage = () => {
    const next = i18n.resolvedLanguage === 'zh-TW' ? 'en' : 'zh-TW';
    i18n.changeLanguage(next);
  };

  const currentLangLabel = i18n.resolvedLanguage === 'zh-TW' ? '中' : 'EN';

  return (
    <div className="min-h-screen flex flex-col bg-[var(--color-background-light)] dark:bg-[var(--color-background-dark)] text-[var(--color-text-light)] dark:text-[var(--color-text-dark)] transition-colors duration-200">
      <header className="px-4 py-3 flex justify-between items-center gap-3 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-2 md:gap-4 min-w-0 flex-1">
          <h1 className="text-xl md:text-2xl font-bold bg-gradient-to-r from-blue-500 to-indigo-600 bg-clip-text text-transparent flex-shrink-0">
            {t('app.title')}
          </h1>

          {roomId && (
            <div className="flex items-center gap-1 min-w-0">
              <button
                onClick={handleCopyId}
                className="px-2.5 py-1.5 rounded-md font-mono font-bold text-sm md:text-base tracking-wider bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition"
                title={t('app.copyRoomId')}
              >
                {roomId}
              </button>
              <button
                onClick={handleCopyLink}
                className="p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition"
                title={t('app.copyLink')}
                aria-label={t('app.copyLink')}
              >
                <Link2 className="w-4 h-4" />
              </button>
              <span
                className={`inline-block w-2 h-2 rounded-full ml-1 ${
                  isConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'
                }`}
                title={isConnected ? t('app.connected') : t('app.disconnected')}
                aria-label={isConnected ? t('app.connected') : t('app.disconnected')}
              />
            </div>
          )}
        </div>

        <div className="flex gap-1 items-center flex-shrink-0">
          <div ref={menuRef} className="relative">
            <button
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
              className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition"
              title={t('app.menu')}
              aria-label={t('app.menu')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <MoreVertical className="w-5 h-5" />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 z-40"
              >
                <button
                  role="menuitem"
                  onClick={toggleLanguage}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                >
                  <span className="flex items-center gap-2">
                    <Languages className="w-4 h-4" />
                    {t('app.language')}
                  </span>
                  <span className="font-semibold text-xs text-gray-500 dark:text-gray-400">
                    {currentLangLabel}
                  </span>
                </button>

                <button
                  role="menuitem"
                  onClick={() => setAnimationsEnabled(!animationsEnabled)}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                >
                  <span className="flex items-center gap-2">
                    <Sparkles className={`w-4 h-4 ${!animationsEnabled ? 'opacity-40' : ''}`} />
                    {t('app.animations')}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {animationsEnabled ? t('app.on') : t('app.off')}
                  </span>
                </button>

                <button
                  role="menuitem"
                  onClick={toggleTheme}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                >
                  <span className="flex items-center gap-2">
                    {theme === 'dark' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                    {t('app.theme')}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {theme === 'dark' ? t('app.dark') : t('app.light')}
                  </span>
                </button>

                {roomId && (
                  <>
                    <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
                    <button
                      role="menuitem"
                      onClick={handleLeave}
                      className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium transition ${
                        confirmingLeave
                          ? 'bg-red-500 text-white hover:bg-red-600'
                          : 'text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <LogOut className="w-4 h-4" />
                        {t('app.leaveRoom')}
                      </span>
                      {confirmingLeave && (
                        <span className="text-xs opacity-90">{t('app.leaveConfirm')}</span>
                      )}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col p-4 md:p-8 max-w-6xl mx-auto w-full">
        {roomId ? <Room /> : <Home />}
      </main>
      <MigrationOverlay />
      <Toast />
    </div>
  );
}

export default App;
