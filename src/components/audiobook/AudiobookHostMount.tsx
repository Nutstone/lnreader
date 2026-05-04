/**
 * AudiobookHostMount — globally renders the Kokoro WebView host AND
 * the mini-player whenever the audiobook player has a chapter loaded.
 *
 * Mounted once near the root of the app (in `Main.tsx`).
 */

import React, { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import KokoroTTSHost from './KokoroTTSHost';
import AudiobookMiniPlayer from './AudiobookMiniPlayer';
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

  return (
    <>
      <KokoroTTSHost active={active} />
      {active ? (
        <View pointerEvents="box-none" style={styles.miniWrap}>
          <AudiobookMiniPlayer />
        </View>
      ) : null}
    </>
  );
};

const styles = StyleSheet.create({
  miniWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    elevation: 8,
  },
});

export default AudiobookHostMount;
