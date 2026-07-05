/**
 * Voice cast editor — per-novel view of the characters the evolving
 * glossary has discovered, with their assigned voices. Tapping a
 * character opens a picker over the whole voice bank; manual picks
 * are pinned (they survive glossary evolution), and 'Auto' unpins and
 * reassigns just that character. A preview button synthesizes a
 * sample line in the candidate voice with the real on-device engine.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Divider, Modal, Portal, Text } from 'react-native-paper';
import { Audio } from 'expo-av';

import { Appbar, SafeAreaView } from '@components';
import { useTheme } from '@hooks/persisted';
import {
  AudiobookSettings,
  AUDIOBOOK_SETTINGS,
  sanitizeTTSPrecision,
} from '@hooks/persisted/useAudiobookSettings';
import { getMMKVObject } from '@utils/mmkv/mmkv';
import { showToast } from '@utils/showToast';
import NativeFile from '@specs/NativeFile';
import { AUDIOBOOK_CACHE_STORAGE, AUDIOBOOK_STORAGE } from '@utils/Storages';
import { VoiceCastScreenProps } from '@navigators/types';
import ServiceManager from '@services/ServiceManager';

import { VoiceAssigner } from '@services/audiobook/voiceAssigner';
import { TTSRenderer } from '@services/audiobook/ttsRenderer';
import { formatSetupProgress } from '@services/audiobook/setupProgress';
import {
  DONATION_VOICES,
  EMOTIONAL_SPEAKERS,
  VOICE_BANK_SCHEMA_VERSION,
} from '@services/audiobook/voiceBank';
import type {
  CharacterGlossary,
  VoiceAssignment,
  VoiceMap,
  VoiceTuning,
} from '@services/audiobook/types';

const PREVIEW_LINE = 'We march at dawn, and the stars will guide us home.';

/** Tuning knobs shown per voice. Speed is pitch-corrected playback
 * rate; pitch re-renders the voice higher/lower (a new-sounding
 * voice); volume is attenuation for voices recorded too loud. */
const TUNERS: {
  key: keyof VoiceTuning;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}[] = [
  {
    key: 'speed',
    label: 'Speed',
    min: 0.6,
    max: 1.6,
    step: 0.05,
    format: v => `${v.toFixed(2)}×`,
  },
  {
    key: 'pitch',
    label: 'Pitch',
    min: 0.85,
    max: 1.2,
    step: 0.05,
    format: v => `${v.toFixed(2)}×`,
  },
  {
    key: 'volume',
    label: 'Volume',
    min: 0.4,
    max: 1,
    step: 0.1,
    format: v => `${Math.round(v * 100)}%`,
  },
];

interface CastRow {
  name: string;
  detail: string;
  assignment: VoiceAssignment | undefined;
}

const readJSON = <T,>(path: string): T | null => {
  try {
    if (!NativeFile.exists(path)) {
      return null;
    }
    return JSON.parse(NativeFile.readFile(path)) as T;
  } catch {
    return null;
  }
};

const VoiceCastScreen = ({ navigation, route }: VoiceCastScreenProps) => {
  const theme = useTheme();
  const { novelId, novelName } = route.params;
  const novelDir = `${AUDIOBOOK_STORAGE}/${novelId}`;

  const [glossary, setGlossary] = useState<CharacterGlossary | null>(null);
  const [voiceMap, setVoiceMap] = useState<VoiceMap | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState('');

  const rendererRef = useRef<TTSRenderer | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const previewBusy = useRef(false);

  const assigner = useMemo(() => {
    const settings = getMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);
    return new VoiceAssigner({
      mainCharacterEmotionalSlots: settings?.mainCharacterEmotionalSlots ?? 10,
    });
  }, []);

  useEffect(() => {
    const loadedGlossary = readJSON<CharacterGlossary>(
      `${novelDir}/glossary.json`,
    );
    setGlossary(loadedGlossary);
    const map = readJSON<VoiceMap>(`${novelDir}/voice-map.json`);
    if (map && map.schemaVersion === VOICE_BANK_SCHEMA_VERSION) {
      setVoiceMap(map);
    } else if (loadedGlossary) {
      // Missing or schema-outdated map with a glossary present:
      // rebuild it here (playback would do the same) so the editor
      // isn't blocked behind another prepare/playback run.
      const rebuilt = assigner.buildVoiceMap(loadedGlossary);
      NativeFile.writeFile(
        `${novelDir}/voice-map.json`,
        JSON.stringify(rebuilt, null, 2),
      );
      setVoiceMap(rebuilt);
    } else {
      setVoiceMap(null);
    }
  }, [assigner, novelDir]);

  // Release the preview engine + player when leaving the screen, and
  // stop an in-flight preview from playing over the next screen.
  const unmounted = useRef(false);
  useEffect(() => {
    return () => {
      unmounted.current = true;
      soundRef.current?.unloadAsync().catch(() => {});
      rendererRef.current?.dispose().catch(() => {});
    };
  }, []);

  const persistVoiceMap = useCallback(
    (next: VoiceMap) => {
      NativeFile.writeFile(
        `${novelDir}/voice-map.json`,
        JSON.stringify(next, null, 2),
      );
      setVoiceMap(next);
    },
    [novelDir],
  );

  const rows = useMemo<CastRow[]>(() => {
    if (!glossary && !voiceMap) {
      return [];
    }
    const narrator: CastRow = {
      name: 'narrator',
      detail: glossary
        ? `Narrator (${glossary.narratorGender})`
        : 'Narrator — reads everything until chapters are prepared',
      assignment: voiceMap?.mappings.narrator,
    };
    const ranked = [...(glossary?.characters ?? [])].sort(
      (a, b) => (b.importance ?? 0) - (a.importance ?? 0),
    );
    return [
      narrator,
      ...ranked.map(character => ({
        name: character.name,
        detail: [
          character.gender,
          character.importance != null
            ? `importance ${character.importance}`
            : null,
        ]
          .filter(Boolean)
          .join(' · '),
        assignment: voiceMap?.mappings[character.name],
      })),
    ];
  }, [glossary, voiceMap]);

  const applyVoice = useCallback(
    (characterName: string, assignment: VoiceAssignment) => {
      if (!voiceMap) {
        return;
      }
      persistVoiceMap(
        assigner.overrideVoice(
          voiceMap,
          characterName,
          {
            ...assignment,
            label: `${characterName} (${assignment.label})`,
          },
          glossary ?? undefined,
        ),
      );
      setEditing(null);
    },
    [assigner, glossary, persistVoiceMap, voiceMap],
  );

  const resetVoice = useCallback(
    (characterName: string) => {
      if (!voiceMap) {
        return;
      }
      // Keyless novels have a voice map but no glossary yet — reset
      // still works against an empty cast (narrator self-heals).
      const effectiveGlossary: CharacterGlossary = glossary ?? {
        novelId: String(novelId),
        characters: [],
        narratorGender: 'male',
        createdAt: new Date().toISOString(),
      };
      persistVoiceMap(
        assigner.resetVoice(voiceMap, characterName, effectiveGlossary),
      );
      setEditing(null);
    },
    [assigner, glossary, novelId, persistVoiceMap, voiceMap],
  );

  const setTuning = useCallback(
    (characterName: string, patch: VoiceTuning) => {
      if (!voiceMap) {
        return;
      }
      const clamped: VoiceTuning = {};
      for (const tuner of TUNERS) {
        const value = patch[tuner.key];
        if (value !== undefined) {
          clamped[tuner.key] =
            Math.round(Math.min(tuner.max, Math.max(tuner.min, value)) * 100) /
            100;
        }
      }
      persistVoiceMap(
        assigner.setVoiceTuning(
          voiceMap,
          characterName,
          clamped,
          glossary ?? undefined,
        ),
      );
    },
    [assigner, glossary, persistVoiceMap, voiceMap],
  );

  const previewVoice = useCallback(async (assignment: VoiceAssignment) => {
    if (previewBusy.current) {
      return;
    }
    // A running prepare task may already hold a full model instance;
    // a second one here could OOM low-end devices.
    if (
      ServiceManager.manager
        .getTaskList()
        .some(t => t.task?.name === 'AUDIOBOOK_PIPELINE')
    ) {
      showToast('Preview unavailable while an audiobook is being prepared.');
      return;
    }
    previewBusy.current = true;
    try {
      if (!rendererRef.current) {
        const settings = getMMKVObject<AudiobookSettings>(AUDIOBOOK_SETTINGS);
        rendererRef.current = new TTSRenderer(
          {
            precision: sanitizeTTSPrecision(settings?.ttsPrecision),
            lookaheadSegments: 1,
            mainCharacterEmotionalSlots:
              settings?.mainCharacterEmotionalSlots ?? 10,
          },
          AUDIOBOOK_CACHE_STORAGE,
        );
      }
      // First preview may download the model — surface that.
      await rendererRef.current.initialize(progress =>
        setPreviewStatus(formatSetupProgress(progress)),
      );
      setPreviewStatus('Generating preview…');
      const segment = await rendererRef.current.renderSegment(
        PREVIEW_LINE,
        assignment,
        'neutral',
      );
      setPreviewStatus('');
      if (unmounted.current) {
        // The user already left — don't play over the next screen.
        return;
      }
      await soundRef.current?.unloadAsync().catch(() => {});
      const { sound } = await Audio.Sound.createAsync(
        { uri: `file://${segment.audioPath}` },
        {
          shouldPlay: true,
          rate: segment.speed ?? 1,
          shouldCorrectPitch: true,
          volume: segment.volume ?? 1,
        },
      );
      if (unmounted.current) {
        sound.unloadAsync().catch(() => {});
        return;
      }
      soundRef.current = sound;
    } catch (error) {
      setPreviewStatus('');
      if (!unmounted.current) {
        showToast(
          `Preview failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } finally {
      previewBusy.current = false;
    }
  }, []);

  const pickerOptions = useMemo<VoiceAssignment[]>(
    () => [
      ...EMOTIONAL_SPEAKERS.map(speaker => ({
        kind: 'emotional' as const,
        speakerId: speaker.id,
        label: speaker.label,
      })),
      ...DONATION_VOICES.map(voice => ({
        kind: 'donation' as const,
        voiceId: voice.id,
        label: `${voice.label} (${voice.gender})`,
      })),
    ],
    [],
  );

  const currentOf = (assignment?: VoiceAssignment) =>
    assignment?.kind === 'emotional'
      ? `emotional:${assignment.speakerId}`
      : assignment?.kind === 'donation'
      ? `donation:${assignment.voiceId}`
      : '';

  const keyOf = (assignment: VoiceAssignment) =>
    assignment.kind === 'emotional'
      ? `emotional:${assignment.speakerId}`
      : `donation:${assignment.voiceId}`;

  const editingRow = rows.find(r => r.name === editing);

  return (
    <SafeAreaView excludeTop>
      <Appbar
        title={`Voice cast — ${novelName}`}
        handleGoBack={() => navigation.goBack()}
        theme={theme}
      />
      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Text style={{ color: theme.onSurfaceVariant }}>
            No cast yet. Prepare chapters or start audiobook playback once, then
            come back.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={row => row.name}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => setEditing(item.name)}>
              <View style={styles.rowText}>
                <Text style={{ color: theme.onSurface }}>
                  {item.name === 'narrator' ? 'Narrator' : item.name}
                  {item.assignment?.pinned ? '  📌' : ''}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{ color: theme.onSurfaceVariant }}
                >
                  {item.detail}
                </Text>
              </View>
              <Text
                variant="bodySmall"
                style={[styles.voiceLabel, { color: theme.primary }]}
                numberOfLines={1}
              >
                {item.assignment
                  ? `${item.assignment.label}${
                      item.assignment.kind === 'emotional' ? ' · emotional' : ''
                    }`
                  : 'narrator voice (unassigned)'}
              </Text>
            </Pressable>
          )}
          ItemSeparatorComponent={Divider}
          contentContainerStyle={styles.listContent}
        />
      )}

      <Portal>
        <Modal
          visible={editing !== null}
          onDismiss={() => setEditing(null)}
          contentContainerStyle={[
            styles.modal,
            { backgroundColor: theme.overlay3 ?? theme.surface },
          ]}
        >
          <Text style={[styles.modalTitle, { color: theme.onSurface }]}>
            Voice for {editing === 'narrator' ? 'the narrator' : editing}
          </Text>
          {previewStatus ? (
            <Text variant="bodySmall" style={{ color: theme.onSurfaceVariant }}>
              {previewStatus}
            </Text>
          ) : null}
          {editingRow?.assignment
            ? TUNERS.map(tuner => {
                const current =
                  editingRow.assignment?.[tuner.key] ??
                  (tuner.key === 'volume' ? 1 : 1);
                return (
                  <View key={tuner.key} style={styles.speedRow}>
                    <Text
                      style={[styles.tunerLabel, { color: theme.onSurface }]}
                    >
                      {tuner.label}
                    </Text>
                    <Pressable
                      style={styles.speedButton}
                      onPress={() =>
                        editing &&
                        setTuning(editing, {
                          [tuner.key]: current - tuner.step,
                        })
                      }
                    >
                      <Text
                        style={[styles.speedGlyph, { color: theme.primary }]}
                      >
                        −
                      </Text>
                    </Pressable>
                    <Text style={{ color: theme.onSurface }}>
                      {tuner.format(current)}
                    </Text>
                    <Pressable
                      style={styles.speedButton}
                      onPress={() =>
                        editing &&
                        setTuning(editing, {
                          [tuner.key]: current + tuner.step,
                        })
                      }
                    >
                      <Text
                        style={[styles.speedGlyph, { color: theme.primary }]}
                      >
                        +
                      </Text>
                    </Pressable>
                  </View>
                );
              })
            : null}
          <FlatList
            data={pickerOptions}
            keyExtractor={keyOf}
            style={styles.pickerList}
            renderItem={({ item }) => {
              const selected =
                currentOf(editingRow?.assignment) === keyOf(item);
              return (
                <View style={styles.pickerRow}>
                  <Pressable
                    style={styles.pickerName}
                    onPress={() => editing && applyVoice(editing, item)}
                  >
                    <Text
                      style={{
                        color: selected ? theme.primary : theme.onSurface,
                      }}
                    >
                      {selected ? '✓ ' : ''}
                      {item.label}
                      {item.kind === 'emotional' ? ' · emotional' : ''}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.previewButton}
                    onPress={() =>
                      // Preview the candidate voice with the
                      // character's current tuning applied.
                      previewVoice({
                        ...item,
                        speed: editingRow?.assignment?.speed,
                        pitch: editingRow?.assignment?.pitch,
                        volume: editingRow?.assignment?.volume,
                      })
                    }
                  >
                    <Text style={{ color: theme.primary }}>▶</Text>
                  </Pressable>
                </View>
              );
            }}
          />
          <Pressable
            style={styles.autoButton}
            onPress={() => editing && resetVoice(editing)}
          >
            <Text style={{ color: theme.primary }}>
              Auto (reset to assigned voice)
            </Text>
          </Pressable>
        </Modal>
      </Portal>
    </SafeAreaView>
  );
};

export default VoiceCastScreen;

const styles = StyleSheet.create({
  autoButton: {
    paddingTop: 12,
  },
  empty: {
    padding: 24,
  },
  listContent: {
    paddingBottom: 40,
  },
  modal: {
    borderRadius: 12,
    margin: 24,
    maxHeight: '80%',
    padding: 20,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    paddingBottom: 8,
  },
  pickerList: {
    flexGrow: 0,
  },
  pickerName: {
    flex: 1,
    paddingVertical: 8,
  },
  pickerRow: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  previewButton: {
    padding: 8,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  speedButton: {
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  speedGlyph: {
    fontSize: 20,
  },
  speedRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    paddingVertical: 4,
  },
  tunerLabel: {
    width: 64,
  },
  rowText: {
    flex: 1,
    paddingRight: 12,
  },
  voiceLabel: {
    maxWidth: '45%',
  },
});
