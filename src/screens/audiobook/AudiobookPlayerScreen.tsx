/**
 * AudiobookPlayerScreen — full player with transport, segment list,
 * speed selector, and sleep timer.
 */

import React, { useEffect, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Appbar, SafeAreaView } from '@components';
import { useTheme } from '@hooks/persisted';
import {
  audiobookPlayer,
  PlayerState,
} from '@services/audiobook';
import { INITIAL_PLAYER_STATE } from '@services/audiobook/types';

const SPEEDS = [0.7, 0.85, 1.0, 1.15, 1.25, 1.5, 1.75, 2.0];
const TIMERS = [
  { label: 'Off', minutes: null },
  { label: '5 min', minutes: 5 },
  { label: '10 min', minutes: 10 },
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '45 min', minutes: 45 },
  { label: '1 hour', minutes: 60 },
];

const AudiobookPlayerScreen = ({ navigation }: { navigation: any }) => {
  const theme = useTheme();
  const [state, setState] = useState<PlayerState>(INITIAL_PLAYER_STATE);

  useEffect(() => audiobookPlayer.subscribe(setState), []);

  return (
    <SafeAreaView excludeTop>
      <Appbar
        title="Listening"
        handleGoBack={() => navigation.goBack()}
        theme={theme}
      />
      <ScrollView
        style={[{ backgroundColor: theme.background }, styles.flex]}
        contentContainerStyle={styles.padding}
      >
        <View style={styles.header}>
          <Text style={[styles.novelName, { color: theme.onSurface }]}>
            {state.novelName ?? '—'}
          </Text>
          <Text style={[styles.chapterName, { color: theme.onSurfaceVariant }]}>
            {state.chapterName ?? `Chapter ${state.chapterId ?? ''}`}
          </Text>
        </View>

        <View style={styles.nowPlaying}>
          <Text style={[styles.speaker, { color: theme.primary }]}>
            {state.currentSpeaker ?? '—'}
          </Text>
          <Text
            numberOfLines={4}
            style={[styles.text, { color: theme.onSurface }]}
          >
            {state.currentText ?? ''}
          </Text>
        </View>

        <View style={styles.progressRow}>
          <Text style={[styles.time, { color: theme.onSurfaceVariant }]}>
            {formatTime(state.totalPositionMs + state.positionMs)}
          </Text>
          <View style={[styles.bar, { backgroundColor: theme.surfaceVariant }]}>
            <View
              style={[
                styles.barFill,
                {
                  width: `${
                    state.totalDurationMs > 0
                      ? Math.min(
                          100,
                          ((state.totalPositionMs + state.positionMs) /
                            state.totalDurationMs) *
                            100,
                        )
                      : 0
                  }%`,
                  backgroundColor: theme.primary,
                },
              ]}
            />
          </View>
          <Text style={[styles.time, { color: theme.onSurfaceVariant }]}>
            {formatTime(state.totalDurationMs)}
          </Text>
        </View>

        <View style={styles.transport}>
          <Btn
            label="⏮"
            onPress={() => audiobookPlayer.previousSegment()}
            theme={theme}
          />
          <Btn
            label="⏪30"
            onPress={() => audiobookPlayer.skipBackward(30)}
            theme={theme}
          />
          <Btn
            label={state.status === 'playing' ? '⏸' : '▶'}
            onPress={() =>
              state.status === 'playing'
                ? audiobookPlayer.pause()
                : audiobookPlayer.resume()
            }
            theme={theme}
            primary
          />
          <Btn
            label="⏩30"
            onPress={() => audiobookPlayer.skipForward(30)}
            theme={theme}
          />
          <Btn
            label="⏭"
            onPress={() => audiobookPlayer.nextSegment()}
            theme={theme}
          />
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.onSurface }]}>
            Speed
          </Text>
          <View style={styles.chipRow}>
            {SPEEDS.map(s => (
              <TouchableOpacity
                key={s}
                onPress={() => audiobookPlayer.setSpeed(s)}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      Math.abs(state.speed - s) < 0.01
                        ? theme.primary
                        : theme.surfaceVariant,
                  },
                ]}
              >
                <Text
                  style={{
                    color:
                      Math.abs(state.speed - s) < 0.01
                        ? theme.onPrimary
                        : theme.onSurface,
                  }}
                >
                  {s.toFixed(2)}×
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.onSurface }]}>
            Sleep timer
          </Text>
          <View style={styles.chipRow}>
            {TIMERS.map(t => (
              <TouchableOpacity
                key={t.label}
                onPress={() => audiobookPlayer.setSleepTimer(t.minutes)}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      (t.minutes === null && !state.sleepTimerEndsAt) ||
                      (t.minutes !== null &&
                        state.sleepTimerEndsAt &&
                        Math.abs(
                          state.sleepTimerEndsAt -
                            (Date.now() + t.minutes * 60_000),
                        ) < 5_000)
                        ? theme.primary
                        : theme.surfaceVariant,
                  },
                ]}
              >
                <Text
                  style={{
                    color:
                      (t.minutes === null && !state.sleepTimerEndsAt) ||
                      (t.minutes !== null &&
                        state.sleepTimerEndsAt &&
                        Math.abs(
                          state.sleepTimerEndsAt -
                            (Date.now() + t.minutes * 60_000),
                        ) < 5_000)
                        ? theme.onPrimary
                        : theme.onSurface,
                  }}
                >
                  {t.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {state.sleepTimerEndsAt ? (
            <Text style={[styles.timerNote, { color: theme.onSurfaceVariant }]}>
              Stops in{' '}
              {formatTime(Math.max(0, state.sleepTimerEndsAt - Date.now()))}
            </Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.onSurface }]}>
            Status
          </Text>
          <Text style={{ color: theme.onSurfaceVariant }}>
            Segment {state.segmentIndex + 1} / {state.totalSegments}
            {state.status === 'rendering' ? ' · rendering ahead…' : ''}
          </Text>
          {state.error ? (
            <Text style={{ color: theme.error ?? '#cc3333' }}>
              {state.error.message}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const Btn: React.FC<{
  label: string;
  onPress: () => void;
  theme: ReturnType<typeof useTheme>;
  primary?: boolean;
}> = ({ label, onPress, theme, primary }) => (
  <TouchableOpacity
    onPress={onPress}
    style={[
      styles.tBtn,
      {
        backgroundColor: primary ? theme.primary : theme.surfaceVariant,
      },
    ]}
  >
    <Text
      style={{
        fontSize: 18,
        color: primary ? theme.onPrimary : theme.onSurface,
      }}
    >
      {label}
    </Text>
  </TouchableOpacity>
);

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0)
    {return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;}
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  padding: { padding: 16, paddingBottom: 80 },
  header: { marginBottom: 16 },
  novelName: { fontSize: 18, fontWeight: '700' },
  chapterName: { fontSize: 14, marginTop: 4 },
  nowPlaying: { marginVertical: 16 },
  speaker: { fontSize: 16, fontWeight: '600' },
  text: { fontSize: 15, marginTop: 6, lineHeight: 22 },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 8,
  },
  bar: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  barFill: { height: 4 },
  time: { fontSize: 12, minWidth: 48 },
  transport: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 16,
    paddingHorizontal: 8,
  },
  tBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { marginTop: 24 },
  sectionTitle: { fontSize: 14, fontWeight: '600', marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  timerNote: { marginTop: 8, fontSize: 12 },
});

export default AudiobookPlayerScreen;
