import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  return (
    <div>
      <label className="block text-sm font-medium mb-2">{t('home.yourName')}</label>
      <input
        data-slot="home-name"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('home.namePlaceholder')}
        autoFocus={autoFocus}
        className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
      />
    </div>
  );
}

function CreateForm({ playerName, onNameChange }: { playerName: string; onNameChange: (v: string) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    if (!playerName.trim() || busy) return;
    setBusy(true);
    try {
      await peerManager.createRoom();
    } catch (err) {
      console.error(err);
      usePokerStore.getState().pushToast({
        message: err instanceof Error ? err.message : t('home.failedCreate'),
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
        data-slot="home-create"
        onClick={handleCreate}
        disabled={!playerName.trim() || busy}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold p-3.5 rounded-lg transition flex items-center justify-center gap-2 shadow-md"
      >
        <Plus className="w-5 h-5" />
        {busy ? t('home.creating') : t('home.createRoom')}
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
  const { t } = useTranslation();
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
        message: err instanceof Error ? err.message : t('home.failedJoin'),
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
        <label className="block text-sm font-medium mb-2">{t('home.roomIdLabel')}</label>
        <input
          data-slot="home-room-id"
          type="text"
          value={roomInput}
          onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
          placeholder={t('home.roomIdPlaceholder')}
          maxLength={10}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 outline-none font-mono tracking-wider"
        />
      </div>
      <button
        data-slot="home-join"
        type="submit"
        disabled={!playerName.trim() || !roomInput.trim() || busy}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold p-3.5 rounded-lg transition flex items-center justify-center gap-2 shadow-md"
      >
        <LogIn className="w-5 h-5" />
        {busy ? t('home.joining') : t('home.joinRoom')}
      </button>
    </form>
  );
}

export default function Home() {
  const { t } = useTranslation();
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
            <h2 className="text-xl font-bold mb-1">{t('home.invitedTitle')}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              <Trans
                i18nKey="home.invitedSubtitle"
                values={{ roomId: roomFromUrl }}
                components={{ b: <span className="font-mono font-bold" /> }}
              />
            </p>
            <JoinForm
              playerName={playerName}
              onNameChange={setPlayerName}
              initialRoomId={roomFromUrl}
            />
            <button
              data-slot="home-not-this-room"
              onClick={clearRoomFromUrl}
              className="mt-6 w-full text-sm text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition"
            >
              {t('home.notThisRoom')}
            </button>
          </>
        ) : (
          <>
            <h2 className="text-xl font-bold mb-1">{t('home.startTitle')}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              {t('home.startSubtitle')}
            </p>
            <CreateForm playerName={playerName} onNameChange={setPlayerName} />

            <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
              <button
                data-slot="home-join-fallback-toggle"
                onClick={() => setShowJoinFallback((v) => !v)}
                className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition"
              >
                {t('home.fallbackToggle')}
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
