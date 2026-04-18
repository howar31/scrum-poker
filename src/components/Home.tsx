import { useState } from 'react';
import { ChevronDown, Plus, LogIn } from 'lucide-react';
import { usePokerStore } from '../store/usePokerStore';
import { peerManager } from '../utils/peerManager';
import { normalizeRoomId } from '../utils/roomId';
import ArcBrowserWarning from './ArcBrowserWarning';

// Read ?room= on initial render so we can branch the UI. Lazy-init so we
// don't need a useEffect and don't hit the react-hooks/set-state-in-effect
// lint rule.
function readRoomFromUrl(): string {
  if (typeof window === 'undefined') return '';
  const raw = new URLSearchParams(window.location.search).get('room');
  return raw ? normalizeRoomId(raw) : '';
}

function NameInput({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-2">Your name</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter your name..."
        autoFocus={autoFocus}
        className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
      />
    </div>
  );
}

function CreateForm({ playerName, onNameChange }: { playerName: string; onNameChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    if (!playerName.trim() || busy) return;
    setBusy(true);
    try {
      await peerManager.createRoom();
    } catch (err) {
      console.error(err);
      usePokerStore.getState().pushToast({
        message: err instanceof Error ? err.message : 'Failed to create room',
        variant: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <NameInput value={playerName} onChange={onNameChange} autoFocus />
      <button
        onClick={handleCreate}
        disabled={!playerName.trim() || busy}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold p-3.5 rounded-lg transition flex items-center justify-center gap-2 shadow-md"
      >
        <Plus className="w-5 h-5" />
        {busy ? 'Creating...' : 'Create New Room'}
      </button>
    </div>
  );
}

function JoinForm({
  playerName,
  onNameChange,
  initialRoomId,
}: {
  playerName: string;
  onNameChange: (v: string) => void;
  initialRoomId: string;
}) {
  const [roomInput, setRoomInput] = useState(initialRoomId);
  const [busy, setBusy] = useState(false);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const roomId = normalizeRoomId(roomInput);
    if (!playerName.trim() || !roomId || busy) return;
    setBusy(true);
    try {
      await peerManager.joinRoom(roomId);
    } catch (err) {
      console.error(err);
      usePokerStore.getState().pushToast({
        message: err instanceof Error ? err.message : 'Failed to join room',
        variant: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleJoin} className="space-y-5">
      <NameInput value={playerName} onChange={onNameChange} autoFocus={!initialRoomId} />
      <div>
        <label className="block text-sm font-medium mb-2">Room ID</label>
        <input
          type="text"
          value={roomInput}
          onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
          placeholder="ABC1234"
          maxLength={10}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 outline-none font-mono tracking-wider"
        />
      </div>
      <button
        type="submit"
        disabled={!playerName.trim() || !roomInput.trim() || busy}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold p-3.5 rounded-lg transition flex items-center justify-center gap-2 shadow-md"
      >
        <LogIn className="w-5 h-5" />
        {busy ? 'Joining...' : 'Join Room'}
      </button>
    </form>
  );
}

export default function Home() {
  const { playerName, setPlayerName } = usePokerStore();
  const [roomFromUrl] = useState(readRoomFromUrl);
  const [showJoinFallback, setShowJoinFallback] = useState(false);

  const hasRoomInUrl = !!roomFromUrl;

  const clearRoomFromUrl = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
    window.location.reload();
  };

  return (
    <div className="flex flex-col items-center justify-center flex-1 max-w-md mx-auto w-full gap-6">
      <ArcBrowserWarning />

      <div className="w-full bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-700">
        {hasRoomInUrl ? (
          <>
            <h2 className="text-xl font-bold mb-1">You're invited</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Joining room <span className="font-mono font-bold">{roomFromUrl}</span>
            </p>
            <JoinForm
              playerName={playerName}
              onNameChange={setPlayerName}
              initialRoomId={roomFromUrl}
            />
            <button
              onClick={clearRoomFromUrl}
              className="mt-6 w-full text-sm text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition"
            >
              Not this room? Create a new one instead →
            </button>
          </>
        ) : (
          <>
            <h2 className="text-xl font-bold mb-1">Start a session</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Create a new room and share the link with your team.
            </p>
            <CreateForm playerName={playerName} onNameChange={setPlayerName} />

            <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowJoinFallback((v) => !v)}
                className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition"
              >
                Or join an existing room with a Room ID
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${showJoinFallback ? 'rotate-180' : ''}`}
                />
              </button>
              {showJoinFallback && (
                <div className="mt-4">
                  <JoinForm
                    playerName={playerName}
                    onNameChange={setPlayerName}
                    initialRoomId=""
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
