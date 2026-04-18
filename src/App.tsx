import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { usePokerStore } from './store/usePokerStore';
import Home from './components/Home';
import Room from './components/Room';
import Toast from './components/Toast';
import { peerManager } from './utils/peerManager';
import { Sparkles, Moon, Sun, Link2, LogOut, Languages } from 'lucide-react';

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
      <header className="px-4 py-3 flex flex-wrap justify-between items-center gap-3 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3 md:gap-4 min-w-0 flex-1">
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

        <div className="flex gap-1 md:gap-2 items-center flex-shrink-0">
          <button
            onClick={toggleLanguage}
            className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition flex items-center gap-1 text-xs font-semibold"
            title={t('app.switchLanguage')}
            aria-label={t('app.switchLanguage')}
          >
            <Languages className="w-5 h-5" />
            <span>{currentLangLabel}</span>
          </button>
          <button
            onClick={() => setAnimationsEnabled(!animationsEnabled)}
            className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition"
            title={animationsEnabled ? t('app.disableAnimations') : t('app.enableAnimations')}
            aria-label={animationsEnabled ? t('app.disableAnimations') : t('app.enableAnimations')}
          >
            <Sparkles className={`w-5 h-5 ${!animationsEnabled ? 'opacity-40' : ''}`} />
          </button>
          <button
            onClick={toggleTheme}
            className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition"
            title={t('app.toggleTheme')}
            aria-label={t('app.toggleTheme')}
          >
            {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
          {roomId && (
            <button
              onClick={handleLeave}
              className="flex items-center gap-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 px-3 py-2 rounded-lg transition font-medium text-sm"
              title={t('app.leaveRoom')}
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">{t('app.leave')}</span>
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col p-4 md:p-8 max-w-6xl mx-auto w-full">
        {roomId ? <Room /> : <Home />}
      </main>
      <Toast />
    </div>
  );
}

export default App;
