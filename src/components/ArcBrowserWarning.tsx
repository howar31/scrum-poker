import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { isArcBrowser } from '../utils/browserDetect';

export default function ArcBrowserWarning() {
  // Lazy init so the CSS var lookup runs once at first render (client-side),
  // avoiding a cascading setState from useEffect.
  const [show] = useState(() => isArcBrowser());

  if (!show) return null;

  return (
    <div className="w-full bg-amber-100 dark:bg-amber-900/30 border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-200 px-4 py-3 rounded-lg flex gap-3">
      <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
      <div className="text-sm space-y-1">
        <p className="font-bold">Arc Browser detected</p>
        <p>
          Arc's privacy settings may block WebRTC connections. If you can't create
          or join a room, open{' '}
          <code className="font-mono bg-amber-200/60 dark:bg-amber-800/60 px-1 rounded">arc://flags</code>, search{' '}
          <em>"Anonymize local IPs exposed to WebRTC"</em>, set it to{' '}
          <strong>Disabled</strong>, and restart Arc. Chrome, Firefox, and Safari
          work without any changes.
        </p>
      </div>
    </div>
  );
}
