import React from 'react';

function ConnectionStatus({ connected }) {
  return (
    <div className="connection-status">
      <div className={`connection-indicator ${connected ? 'connected' : ''}`}></div>
      <span>{connected ? 'Connected' : 'Disconnected'}</span>
    </div>
  );
}

export default ConnectionStatus;