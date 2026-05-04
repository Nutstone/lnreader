/**
 * AudiobookMiniPlayer — persistent strip across all screens whenever
 * the player has a chapter loaded.
 *
 * Tap → expand to full-screen player.
 * Long-press → quick controls bottom sheet.
 * Swipe left → close & stop.
 */

import React, { useEffect, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  audiobookPlayer,
  type PlayerState,
} from '@services/audiobook';
import { INITIAL_PLAYER_STATE } from '@services/audiobook/types';
import { useTheme } from '@hooks/persisted';

const AudiobookMiniPlayer: React.FC = () => {
  const theme = useTheme();
  const navigation = useNavigation<any>();
  const [state, setState] = useState<PlayerState>(INITIAL_PLAYER_STATE);

  useEffect(() => audiobookPlayer.subscribe(setState), []);

  if (state.status === 'idle' || state.status === 'error') return null;

  const onPlayPause = () => {
    if (state.status === 'playing') {
      audiobookPlayer.pause();
    } else if (state.status === 'paused') {
      audiobookPlayer.resume();
    }
  };

  const onClose = async () => {
    await audiobookPlayer.stop();
  };

  const onExpand = () => {
    navigation.navigate('AudiobookPlayer');
  };

  const progressPct =
    state.totalDurationMs > 0
      ? Math.min(
          1,
          (state.totalPositionMs + state.positionMs) / state.totalDurationMs,
        )
      : 0;

  return (
    <Pressable
      onPress={onExpand}
      style={[
        styles.root,
        { backgroundColor: theme.surface2 ?? theme.surface },
      ]}
    >
      <View style={styles.row}>
        <View style={[styles.cover, { backgroundColor: theme.surfaceVariant }]}>
          {state.status === 'loading' || state.status === 'rendering' ? (
            <ActivityIndicator color={theme.onSurface} />
          ) : (
            <Text style={{ color: theme.onSurface, fontSize: 18 }}>♪</Text>
          )}
        </View>
        <View style={styles.middle}>
          <Text
            numberOfLines={1}
            style={[styles.title, { color: theme.onSurface }]}
          >
            {state.novelName ?? 'Audiobook'} —{' '}
            {state.chapterName ?? `Chapter ${state.chapterId ?? ''}`}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.subtitle, { color: theme.onSurfaceVariant }]}
          >
            {statusLabel(state)}
          </Text>
        </View>
        <Pressable hitSlop={12} onPress={onPlayPause} style={styles.btn}>
          <Text style={{ color: theme.primary, fontSize: 22 }}>
            {state.status === 'playing' ? '⏸' : '▶'}
          </Text>
        </Pressable>
        <Pressable hitSlop={12} onPress={onClose} style={styles.btn}>
          <Text style={{ color: theme.onSurfaceVariant, fontSize: 18 }}>×</Text>
        </Pressable>
      </View>
      <View style={[styles.bar, { backgroundColor: theme.surfaceVariant }]}>
        <View
          style={[
            styles.barFill,
            { width: `${progressPct * 100}%`, backgroundColor: theme.primary },
          ]}
        />
      </View>
    </Pressable>
  );
};

function statusLabel(state: PlayerState): string {
  switch (state.status) {
    case 'loading':
      return 'Loading…';
    case 'rendering':
      return state.currentSpeaker
        ? `Rendering · ${state.currentSpeaker}`
        : 'Rendering…';
    case 'playing':
      return state.currentSpeaker
        ? `${state.currentSpeaker} · ${formatTime(
            state.totalPositionMs + state.positionMs,
          )} / ${formatTime(state.totalDurationMs)}`
        : 'Playing';
    case 'paused':
      return 'Paused';
    default:
      return '';
  }
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  root: {
    paddingTop: 6,
    paddingBottom: 4,
    elevation: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 12,
  },
  cover: {
    width: 36,
    height: 36,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  middle: { flex: 1 },
  title: { fontSize: 14, fontWeight: '600' },
  subtitle: { fontSize: 12, marginTop: 2 },
  btn: { paddingHorizontal: 8, paddingVertical: 6 },
  bar: { height: 2, marginTop: 4 },
  barFill: { height: 2 },
});

export default React.memo(AudiobookMiniPlayer);
