import { useState, useEffect } from 'react';
import { usePokerStore } from '../store/usePokerStore';
import { peerManager } from '../utils/peerManager';

export default function Home() {
  const { playerName, setPlayerName } = usePokerStore();
  const [joinRoomId, setJoinRoomId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
      setJoinRoomId(roomFromUrl);
    }
  }, []);

  const handleCreateRoom = async () => {
    if (!playerName.trim()) return;
    setIsCreating(true);
    try {
      await peerManager.createRoom();
    } catch (err) {
      console.error(err);
      setIsCreating(false);
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playerName.trim() || !joinRoomId.trim()) return;
    setIsJoining(true);
    try {
      await peerManager.joinRoom(joinRoomId.trim());
    } catch (err) {
      console.error(err);
      setIsJoining(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center flex-1 max-w-md mx-auto w-full gap-8">
      <div className="w-full bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-xl space-y-6 border border-gray-100 dark:border-gray-700">
        <h2 className="text-2xl font-bold text-center">Join or Create a Room</h2>
        
        <div>
          <label className="block text-sm font-medium mb-2">Your Name</label>
          <input 
            type="text" 
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            placeholder="Enter your name..."
            className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>

        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <button 
            onClick={handleCreateRoom}
            disabled={!playerName.trim() || isCreating || isJoining}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold p-3 rounded-lg transition"
          >
            {isCreating ? 'Creating...' : 'Create New Room'}
          </button>
        </div>

        <div className="relative flex items-center py-2">
          <div className="flex-grow border-t border-gray-200 dark:border-gray-700"></div>
          <span className="flex-shrink-0 mx-4 text-gray-400 text-sm">OR</span>
          <div className="flex-grow border-t border-gray-200 dark:border-gray-700"></div>
        </div>

        <form onSubmit={handleJoinRoom} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Room ID</label>
            <input 
              type="text" 
              value={joinRoomId}
              onChange={(e) => setJoinRoomId(e.target.value)}
              placeholder="Enter Room ID to join..."
              className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <button 
            type="submit"
            disabled={!playerName.trim() || !joinRoomId.trim() || isCreating || isJoining}
            className="w-full bg-gray-800 dark:bg-gray-700 hover:bg-gray-900 dark:hover:bg-gray-600 disabled:bg-gray-400 text-white font-semibold p-3 rounded-lg transition"
          >
            {isJoining ? 'Joining...' : 'Join Room'}
          </button>
        </form>
      </div>
    </div>
  );
}