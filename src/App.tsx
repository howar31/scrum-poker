import { useEffect } from 'react';
import { usePokerStore } from './store/usePokerStore';
import Home from './components/Home';
import Room from './components/Room';
import Toast from './components/Toast';
import { peerManager } from './utils/peerManager';
import { Sparkles, Moon, Sun, Link2, LogOut } from 'lucide-react';

function App() {
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
    pushToast({ message: 'Room ID copied', variant: 'success' });
  };

  const handleCopyLink = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(window.location.href);
    pushToast({ message: 'Invite link copied', variant: 'success' });
  };

  const handleLeave = () => {
    peerManager.leave();
    usePokerStore.getState().leaveRoom();
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--color-background-light)] dark:bg-[var(--color-background-dark)] text-[var(--color-text-light)] dark:text-[var(--color-text-dark)] transition-colors duration-200">
      <header className="px-4 py-3 flex flex-wrap justify-between items-center gap-3 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3 md:gap-4 min-w-0 flex-1">
          <h1 className="text-xl md:text-2xl font-bold bg-gradient-to-r from-blue-500 to-indigo-600 bg-clip-text text-transparent flex-shrink-0">
            Scrum Poker
          </h1>

          {roomId && (
            <div className="flex items-center gap-1 min-w-0">
              <button
                onClick={handleCopyId}
                className="px-2.5 py-1.5 rounded-md font-mono font-bold text-sm md:text-base tracking-wider bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition"
                title="Click to copy Room ID"
              >
                {roomId}
              </button>
              <button
                onClick={handleCopyLink}
                className="p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition"
                title="Copy invite link"
                aria-label="Copy invite link"
              >
                <Link2 className="w-4 h-4" />
              </button>
              <span
                className={`inline-block w-2 h-2 rounded-full ml-1 ${
                  isConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'
                }`}
                title={isConnected ? 'Connected' : 'Disconnected'}
                aria-label={isConnected ? 'Connected' : 'Disconnected'}
              />
            </div>
          )}
        </div>

        <div className="flex gap-1 md:gap-2 items-center flex-shrink-0">
          <button
            onClick={() => setAnimationsEnabled(!animationsEnabled)}
            className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition"
            title={animationsEnabled ? 'Disable animations' : 'Enable animations'}
            aria-label={animationsEnabled ? 'Disable animations' : 'Enable animations'}
          >
            <Sparkles className={`w-5 h-5 ${!animationsEnabled ? 'opacity-40' : ''}`} />
          </button>
          <button
            onClick={toggleTheme}
            className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition"
            title="Toggle theme"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
          {roomId && (
            <button
              onClick={handleLeave}
              className="flex items-center gap-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 px-3 py-2 rounded-lg transition font-medium text-sm"
              title="Leave room"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Leave</span>
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
