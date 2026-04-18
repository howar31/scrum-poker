import { useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ChevronDown, Plus, LogIn, Loader2, X } from 'lucide-react';
import { usePokerStore } from '../store/usePokerStore';
import { peerManager, type JoinRetryProgress } from '../utils/peerManager';
import { normalizeRoomId } from '../utils/roomId';
import ArcBrowserWarning from './ArcBrowserWarning';

// Initial window before offering a "keep trying?" prompt. 30 s covers most
// broker releases; the prompt adds another 30 s on demand, totalling enough
// to outlast PeerJS broker alive_timeout (~60 s).
const INITIAL_JOIN_WINDOW_MS = 30_000;
const EXTEND_JOIN_WINDOW_MS = 30_000;

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

type JoinUiState =
  | { kind: 'idle' }
  | { kind: 'joining'; roomId: string; progress: JoinRetryProgress }
  | { kind: 'prompt-continue'; roomId: string };

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
  const [uiState, setUiState] = useState<JoinUiState>({ kind: 'idle' });
  const cancelRef = useRef<(() => void) | null>(null);

  const runJoin = (roomId: string, windowMs: number) => {
    setUiState({ kind: 'joining', roomId, progress: { kind: 'connecting' } });
    const handle = peerManager.joinRoomWithRetry(roomId, {
      maxDurationMs: windowMs,
      onProgress: (progress) => {
        setUiState((prev) =>
          prev.kind === 'joining' ? { ...prev, progress } : prev
        );
      },
    });
    cancelRef.current = handle.cancel;
    handle.promise.then(
      () => {
        // Success — room state is set in the store, <App> will swap to <Room>.
        // Reset local UI so a remount after leave doesn't freeze on "joining".
        cancelRef.current = null;
        setUiState({ kind: 'idle' });
      },
      (err: Error & { type?: string }) => {
        cancelRef.current = null;
        if (err.type === 'cancelled') {
          setUiState({ kind: 'idle' });
          return;
        }
        if (err.type === 'window-exceeded') {
          setUiState({ kind: 'prompt-continue', roomId });
          return;
        }
        console.error(err);
        usePokerStore.getState().pushToast({
          message: err instanceof Error ? err.message : t('home.failedJoin'),
          variant: 'error',
        });
        setUiState({ kind: 'idle' });
      }
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const roomId = normalizeRoomId(roomInput);
    if (!playerName.trim() || !roomId || uiState.kind !== 'idle') return;
    runJoin(roomId, INITIAL_JOIN_WINDOW_MS);
  };

  const handleCancel = () => {
    cancelRef.current?.();
    cancelRef.current = null;
    setUiState({ kind: 'idle' });
  };

  const handleKeepTrying = () => {
    if (uiState.kind !== 'prompt-continue') return;
    runJoin(uiState.roomId, EXTEND_JOIN_WINDOW_MS);
  };

  if (uiState.kind === 'joining') {
    const msg =
      uiState.progress.kind === 'peer-unavailable'
        ? t('home.joinNotFound', { roomId: uiState.roomId })
        : uiState.progress.kind === 'timeout'
          ? t('home.joinTimeoutRetry')
          : t('home.joinConnecting', { roomId: uiState.roomId });
    return (
      <div
        data-slot="home-join-progress"
        data-progress={uiState.progress.kind}
        className="flex flex-col items-center gap-5 py-4"
      >
        <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
        <p className="text-sm text-center text-gray-600 dark:text-gray-300 leading-relaxed">
          {msg}
        </p>
        <button
          data-slot="home-join-cancel"
          type="button"
          onClick={handleCancel}
          className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-red-500 dark:hover:text-red-400 transition"
        >
          <X className="w-4 h-4" />
          {t('home.joinCancel')}
        </button>
      </div>
    );
  }

  if (uiState.kind === 'prompt-continue') {
    return (
      <div
        data-slot="home-join-prompt"
        className="flex flex-col items-center gap-4 py-4"
      >
        <h3 className="text-base font-semibold">{t('home.joinTimeoutTitle')}</h3>
        <p className="text-sm text-center text-gray-600 dark:text-gray-300 leading-relaxed">
          {t('home.joinTimeoutBody')}
        </p>
        <div className="flex gap-3 w-full">
          <button
            data-slot="home-join-give-up"
            type="button"
            onClick={handleCancel}
            className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
          >
            {t('home.joinTimeoutGiveUp')}
          </button>
          <button
            data-slot="home-join-keep-trying"
            type="button"
            onClick={handleKeepTrying}
            className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition"
          >
            {t('home.joinTimeoutKeepTrying', {
              seconds: Math.round(EXTEND_JOIN_WINDOW_MS / 1000),
            })}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
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
        disabled={!playerName.trim() || !roomInput.trim()}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold p-3.5 rounded-lg transition flex items-center justify-center gap-2 shadow-md"
      >
        <LogIn className="w-5 h-5" />
        {t('home.joinRoom')}
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
