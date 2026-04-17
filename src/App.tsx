import { useEffect } from 'react';
import { usePokerStore } from './store/usePokerStore';
import Home from './components/Home';
import Room from './components/Room';
import { Settings, Moon, Sun } from 'lucide-react';

function App() {
  const { roomId, theme, toggleTheme, animationsEnabled, setAnimationsEnabled } = usePokerStore();

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

  return (
    <div className="min-h-screen flex flex-col bg-[var(--color-background-light)] dark:bg-[var(--color-background-dark)] text-[var(--color-text-light)] dark:text-[var(--color-text-dark)] transition-colors duration-200">
      <header className="p-4 flex justify-between items-center border-b border-gray-200 dark:border-gray-800">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-500 to-indigo-600 bg-clip-text text-transparent">
          Scrum Poker
        </h1>
        <div className="flex gap-4 items-center">
          <button 
            onClick={() => setAnimationsEnabled(!animationsEnabled)}
            className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition"
            title={animationsEnabled ? "Disable Animations" : "Enable Animations"}
          >
            <Settings className={`w-5 h-5 ${!animationsEnabled ? 'opacity-50' : ''}`} />
          </button>
          <button 
            onClick={toggleTheme}
            className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition"
            title="Toggle Theme"
          >
            {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col p-4 md:p-8 max-w-6xl mx-auto w-full">
        {roomId ? <Room /> : <Home />}
      </main>
    </div>
  );
}

export default App;