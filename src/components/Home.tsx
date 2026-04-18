import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ChevronDown, Plus, LogIn, Loader2, X, AlertCircle } from 'lucide-react';
import { usePokerStore } from '../store/usePokerStore';
import { peerManager, type JoinRetryProgress } from '../utils/peerManager';
import { normalizeRoomId } from '../utils/roomId';
import ArcBrowserWarning from './ArcBrowserWarning';

// How long we wait before surfacing the "still haven't reached it" banner.
// The retry loop itself never pauses — it keeps hammering the broker in the
// background until it succeeds or the user clicks Give up. This prompt is a
// non-blocking UX hint so the user knows things are taking longer than
// usual and can bail out.
const LONG_WAIT_PROMPT_MS = 30_000;

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
  | {
      kind: 'joining';
      roomId: string;
      progress: JoinRetryProgress;
      longWait: boolean;
    };

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
  const longWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up timers / cancel any in-flight retry when the form unmounts.
  useEffect(() => {
    return () => {
      if (longWaitTimerRef.current) clearTimeout(longWaitTimerRef.current);
      // Do NOT auto-cancel here: a successful join unmounts us via the
      // store transition, and cancelling would destroy the just-connected
      // peer. Cancellation only happens via the Give up button.
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const roomId = normalizeRoomId(roomInput);
    if (!playerName.trim() || !roomId || uiState.kind !== 'idle') return;

    setUiState({ kind: 'joining', roomId, progress: { kind: 'connecting' }, longWait: false });

    // Retry loop runs without a hard window — keeps trying until success or
    // Give up. The long-wait banner is a separate side-effect that appears
    // after LONG_WAIT_PROMPT_MS without interrupting the retry.
    const handle = peerManager.joinRoomWithRetry(roomId, {
      onProgress: (progress) => {
        setUiState((prev) =>
          prev.kind === 'joining' ? { ...prev, progress } : prev
        );
      },
    });
    cancelRef.current = handle.cancel;

    longWaitTimerRef.current = setTimeout(() => {
      longWaitTimerRef.current = null;
      setUiState((prev) => (prev.kind === 'joining' ? { ...prev, longWait: true } : prev));
    }, LONG_WAIT_PROMPT_MS);

    handle.promise.then(
      () => {
        // Success — <App> swaps Home for Room when store.roomId updates.
        cancelRef.current = null;
        if (longWaitTimerRef.current) {
          clearTimeout(longWaitTimerRef.current);
          longWaitTimerRef.current = null;
        }
        setUiState({ kind: 'idle' });
      },
      (err: Error & { type?: string }) => {
        cancelRef.current = null;
        if (longWaitTimerRef.current) {
          clearTimeout(longWaitTimerRef.current);
          longWaitTimerRef.current = null;
        }
        if (err.type === 'cancelled') {
          setUiState({ kind: 'idle' });
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

  const handleGiveUp = () => {
    cancelRef.current?.();
    cancelRef.current = null;
    if (longWaitTimerRef.current) {
      clearTimeout(longWaitTimerRef.current);
      longWaitTimerRef.current = null;
    }
    setUiState({ kind: 'idle' });
  };

  const handleDismissLongWait = () => {
    // Hide the banner, retry keeps running in the background.
    setUiState((prev) => (prev.kind === 'joining' ? { ...prev, longWait: false } : prev));
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
        data-long-wait={uiState.longWait}
        className="flex flex-col items-center gap-5 py-4"
      >
        {uiState.longWait && (
          <div
            data-slot="home-join-long-wait"
            className="w-full flex items-start gap-3 p-3 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200"
          >
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="flex-1 text-sm leading-relaxed">
              <p className="font-semibold">{t('home.joinTimeoutTitle')}</p>
              <p className="mt-1 opacity-90">{t('home.joinTimeoutBody')}</p>
            </div>
            <button
              data-slot="home-join-keep-trying"
              type="button"
              onClick={handleDismissLongWait}
              aria-label={t('home.joinTimeoutKeepTrying')}
              title={t('home.joinTimeoutKeepTrying')}
              className="flex-shrink-0 p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
        <p className="text-sm text-center text-gray-600 dark:text-gray-300 leading-relaxed">
          {msg}
        </p>
        <div className="flex gap-3">
          <button
            data-slot="home-join-cancel"
            type="button"
            onClick={handleGiveUp}
            className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-red-500 dark:hover:text-red-400 transition"
          >
            <X className="w-4 h-4" />
            {uiState.longWait ? t('home.joinTimeoutGiveUp') : t('home.joinCancel')}
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
