/**
 * VoicePickerSheet — bottom-sheet voice picker for a character.
 *
 * Two tabs:
 *   - Archetype: pick one of the 9 archetypes; we generate a recipe.
 *   - Custom: pick 2-3 specific Kokoro voices with weights.
 *
 * The "Preview" button isn't wired here — previewing requires a live
 * Kokoro WebView host, which is mounted by the player. Hooking that up
 * is a future enhancement.
 */

import React, { useMemo, useState } from 'react';
import { Modal, Portal } from 'react-native-paper';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '@hooks/persisted';
import {
  ARCHETYPES,
  BlendedVoice,
  VoiceArchetype,
  VOICE_CATALOG,
  VoiceMap,
} from '@services/audiobook';
import { buildRecipeForArchetype } from '@services/audiobook/voiceCaster';

interface Props {
  visible: boolean;
  speaker: string;
  voiceMap: VoiceMap | null;
  onDismiss: () => void;
  onApply: (voice: Pick<BlendedVoice, 'components' | 'speed' | 'label'>) => void;
}

const VoicePickerSheet: React.FC<Props> = ({
  visible,
  speaker,
  voiceMap,
  onDismiss,
  onApply,
}) => {
  const theme = useTheme();
  const current = voiceMap?.mappings[speaker];

  const [tab, setTab] = useState<'archetype' | 'custom'>('archetype');
  const [gender, setGender] = useState<'male' | 'female'>('female');
  const [archetype, setArchetype] = useState<VoiceArchetype>('gentle');
  const [customComponents, setCustomComponents] = useState<
    { voiceId: string; weight: number }[]
  >([
    { voiceId: 'af_bella', weight: 50 },
    { voiceId: 'af_nova', weight: 30 },
    { voiceId: 'af_jessica', weight: 20 },
  ]);
  const [speed, setSpeed] = useState(current?.speed ?? 1.0);

  const archetypeRecipe = useMemo(
    () => buildRecipeForArchetype(archetype, gender),
    [archetype, gender],
  );

  const apply = () => {
    if (tab === 'archetype') {
      onApply({
        label: speaker,
        components: archetypeRecipe,
        speed,
      });
    } else {
      onApply({
        label: speaker,
        components: customComponents,
        speed,
      });
    }
  };

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[
          styles.sheet,
          { backgroundColor: theme.surface },
        ]}
      >
        <Text style={[styles.title, { color: theme.onSurface }]}>
          Voice for {speaker}
        </Text>

        <View style={styles.tabs}>
          {(['archetype', 'custom'] as const).map(t => (
            <TouchableOpacity
              key={t}
              onPress={() => setTab(t)}
              style={[
                styles.tab,
                {
                  backgroundColor:
                    tab === t ? theme.primary : theme.surfaceVariant,
                },
              ]}
            >
              <Text
                style={{
                  color: tab === t ? theme.onPrimary : theme.onSurface,
                }}
              >
                {t === 'archetype' ? 'Archetype' : 'Custom blend'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView style={styles.body}>
          <View style={styles.row}>
            <Text style={[styles.label, { color: theme.onSurface }]}>
              Gender
            </Text>
            <View style={styles.chips}>
              {(['male', 'female'] as const).map(g => (
                <TouchableOpacity
                  key={g}
                  onPress={() => setGender(g)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor:
                        gender === g ? theme.primary : theme.surfaceVariant,
                    },
                  ]}
                >
                  <Text
                    style={{
                      color: gender === g ? theme.onPrimary : theme.onSurface,
                    }}
                  >
                    {g}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {tab === 'archetype' ? (
            <View>
              {ARCHETYPES.filter(a => a !== 'system' && a !== 'crowd').map(
                a => (
                  <TouchableOpacity
                    key={a}
                    onPress={() => setArchetype(a)}
                    style={[
                      styles.archetypeRow,
                      {
                        backgroundColor:
                          archetype === a
                            ? theme.primary
                            : theme.surfaceVariant,
                      },
                    ]}
                  >
                    <Text
                      style={{
                        color:
                          archetype === a ? theme.onPrimary : theme.onSurface,
                        fontSize: 15,
                      }}
                    >
                      {a}
                    </Text>
                  </TouchableOpacity>
                ),
              )}
              <Text style={[styles.preview, { color: theme.onSurfaceVariant }]}>
                Preview blend:{' '}
                {archetypeRecipe.map(c => `${c.voiceId}:${c.weight}`).join(', ')}
              </Text>
            </View>
          ) : (
            <View>
              {customComponents.map((c, i) => (
                <View
                  key={i}
                  style={[
                    styles.customRow,
                    {
                      borderColor: theme.outline,
                    },
                  ]}
                >
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {VOICE_CATALOG.filter(v => v.gender === gender).map(v => (
                      <TouchableOpacity
                        key={v.voiceId}
                        onPress={() => {
                          const next = [...customComponents];
                          next[i] = { ...next[i], voiceId: v.voiceId };
                          setCustomComponents(next);
                        }}
                        style={[
                          styles.voiceChip,
                          {
                            backgroundColor:
                              c.voiceId === v.voiceId
                                ? theme.primary
                                : theme.surface,
                            borderColor: theme.outline,
                          },
                        ]}
                      >
                        <Text
                          style={{
                            color:
                              c.voiceId === v.voiceId
                                ? theme.onPrimary
                                : theme.onSurface,
                            fontSize: 12,
                          }}
                        >
                          {v.voiceId}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                  <Text style={{ color: theme.onSurfaceVariant }}>
                    Weight: {c.weight}
                  </Text>
                  <View style={styles.weightRow}>
                    {[10, 20, 30, 40, 50, 60, 70, 80].map(w => (
                      <TouchableOpacity
                        key={w}
                        onPress={() => {
                          const next = [...customComponents];
                          next[i] = { ...next[i], weight: w };
                          setCustomComponents(next);
                        }}
                        style={[
                          styles.weightChip,
                          {
                            backgroundColor:
                              c.weight === w
                                ? theme.primary
                                : theme.surfaceVariant,
                          },
                        ]}
                      >
                        <Text
                          style={{
                            color:
                              c.weight === w
                                ? theme.onPrimary
                                : theme.onSurface,
                            fontSize: 12,
                          }}
                        >
                          {w}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              ))}
              <Text style={[styles.preview, { color: theme.onSurfaceVariant }]}>
                Weights are normalised to sum 100 on apply.
              </Text>
            </View>
          )}

          <View style={styles.row}>
            <Text style={[styles.label, { color: theme.onSurface }]}>
              Speed
            </Text>
            <View style={styles.chips}>
              {[0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2].map(s => (
                <TouchableOpacity
                  key={s}
                  onPress={() => setSpeed(s)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor:
                        Math.abs(speed - s) < 0.01
                          ? theme.primary
                          : theme.surfaceVariant,
                    },
                  ]}
                >
                  <Text
                    style={{
                      color:
                        Math.abs(speed - s) < 0.01
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
        </ScrollView>

        <View style={styles.bottomBtns}>
          <TouchableOpacity onPress={onDismiss} style={styles.cancelBtn}>
            <Text style={{ color: theme.onSurface }}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={apply}
            style={[styles.applyBtn, { backgroundColor: theme.primary }]}
          >
            <Text style={{ color: theme.onPrimary, fontWeight: '600' }}>
              Apply
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </Portal>
  );
};

const styles = StyleSheet.create({
  sheet: {
    margin: 16,
    borderRadius: 12,
    padding: 16,
    maxHeight: '85%',
  },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  tab: { flex: 1, padding: 10, borderRadius: 8, alignItems: 'center' },
  body: { maxHeight: 400 },
  row: { marginBottom: 12 },
  label: { fontSize: 14, marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  archetypeRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 6,
  },
  preview: { fontSize: 11, marginTop: 8 },
  customRow: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    marginBottom: 6,
  },
  voiceChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginRight: 6,
    borderWidth: 1,
  },
  weightRow: { flexDirection: 'row', gap: 4, marginTop: 4 },
  weightChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  bottomBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 16,
  },
  cancelBtn: { paddingHorizontal: 14, paddingVertical: 10 },
  applyBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
});

export default VoicePickerSheet;
