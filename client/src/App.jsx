import JoinScreen from './components/JoinScreen.jsx';
import WorldCanvas from './components/WorldCanvas.jsx';
import { useSocket } from './hooks/useSocket.js';
import { useMovement } from './hooks/useMovement.js';
import { drawWorld } from './canvas/renderer.js';
import { describeServerError } from './join/joinForm.js';

export default function App() {
  const { world, status, error, joinedInfo, join, emitMove, mic } = useSocket();
  // Movement input + per-frame controller. Its `update` runs inside the
  // canvas's single rAF loop and never touches React state, so walking
  // around causes zero re-renders.
  const movement = useMovement({ world, emitMove });

  // Until the server confirms `joined`, stay on the join screen so its
  // validation and server errors (room_not_found, invalid payload,
  // connection failure) are what the user sees. The movement listeners
  // are already attached but ignore keys while the form has focus.
  if (!joinedInfo) {
    return <JoinScreen onJoin={join} status={status} error={error} notice={mic.notice} />;
  }

  // In the world there is no join screen left to report problems, so the HUD
  // does it: a lost connection (Socket.io is reconnecting on its own) and any
  // server rejection, in the same words the join screen uses.
  const notice =
    status === 'disconnected'
      ? 'Connection lost — reconnecting…'
      : error
        ? describeServerError(error)
        : null;

  return (
    <>
      <WorldCanvas
        world={world}
        renderFrame={drawWorld}
        updateFrame={movement.update}
        onWorldClick={movement.handleWorldClick}
      />
      <div className="world-hud">
        {joinedInfo.roomName} · joined as {joinedInfo.name}
        {' · WASD / arrows to walk · click the floor to walk there'}
        {notice ? (
          <span className="hud-notice" role="status">
            {notice}
          </span>
        ) : null}
      </div>
    </>
  );
}
