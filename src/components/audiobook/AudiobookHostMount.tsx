/**
 * Mounts the hidden Kokoro WebView whenever the audiobook player has a
 * chapter loaded. Unmounts when the player goes idle / errors, freeing
 * the ~250 MB WebView RAM.
 */

import React, { useEffect, useState } from 'react';
import KokoroTTSHost from './KokoroTTSHost';
import { audiobookPlayer, PlayerState } from '@services/audiobook';
import { INITIAL_PLAYER_STATE } from '@services/audiobook/types';

const AudiobookHostMount: React.FC = () => {
  const [state, setState] = useState<PlayerState>(INITIAL_PLAYER_STATE);

  useEffect(() => audiobookPlayer.subscribe(setState), []);

  const active =
    state.status === 'loading' ||
    state.status === 'rendering' ||
    state.status === 'playing' ||
    state.status === 'paused';

  return <KokoroTTSHost active={active} />;
};

export default AudiobookHostMount;
