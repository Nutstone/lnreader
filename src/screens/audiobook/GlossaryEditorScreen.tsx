/**
 * GlossaryEditorScreen — review the cast before / after annotation.
 *
 * Shows narrator + every character with their assigned voice.
 * Tap a character → voice picker bottom sheet.
 * Edit name/aliases/personality → backed by the glossary JSON file.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Appbar, Button, SafeAreaView } from '@components';
import { useTheme } from '@hooks/persisted';
import {
  AudiobookPipeline,
  Character,
  CharacterGlossary,
  VoiceCaster,
  VoiceMap,
} from '@services/audiobook';
import { useAudiobookSettings } from '@hooks/persisted/useAudiobookSettings';
import { showToast } from '@utils/showToast';
import VoicePickerSheet from '@components/audiobook/VoicePickerSheet';

interface RouteParams {
  novelId: string;
  novelName: string;
}

const GlossaryEditorScreen = ({ navigation, route }: any) => {
  const theme = useTheme();
  const { novelId, novelName } = route.params as RouteParams;
  const settings = useAudiobookSettings();
  const [glossary, setGlossary] = useState<CharacterGlossary | null>(null);
  const [voiceMap, setVoiceMap] = useState<VoiceMap | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  const pipeline = useMemo(
    () =>
      new AudiobookPipeline({
        novelId,
        llm: {
          provider: settings.llmProvider,
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
          enablePromptCaching: settings.enablePromptCaching,
        },
        tts: {
          playbackSpeed: 1.0,
          emotionShaping: settings.emotionShaping,
          lookaheadSegments: settings.lookaheadSegments,
        },
      }),
    [
      novelId,
      settings.llmProvider,
      settings.apiKey,
      settings.baseUrl,
      settings.model,
      settings.enablePromptCaching,
      settings.emotionShaping,
      settings.lookaheadSegments,
    ],
  );

  useEffect(() => {
    let mounted = true;
    Promise.all([pipeline.getGlossary(), pipeline.getVoiceMap()]).then(
      ([g, v]) => {
        if (!mounted) return;
        setGlossary(g);
        setVoiceMap(v);
      },
    );
    return () => {
      mounted = false;
    };
  }, [pipeline]);

  const updateCharacter = useCallback(
    (name: string, patch: Partial<Character>) => {
      if (!glossary) return;
      const next: CharacterGlossary = {
        ...glossary,
        characters: glossary.characters.map(c =>
          c.name === name ? { ...c, ...patch, userOverridden: true } : c,
        ),
        updatedAt: new Date().toISOString(),
      };
      setGlossary(next);
      pipeline.setGlossary(next);
    },
    [glossary, pipeline],
  );

  const deleteCharacter = useCallback(
    (name: string) => {
      if (!glossary) return;
      Alert.alert('Remove character?', `${name} will use the narrator voice.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            const next: CharacterGlossary = {
              ...glossary,
              characters: glossary.characters.filter(c => c.name !== name),
              updatedAt: new Date().toISOString(),
            };
            setGlossary(next);
            pipeline.setGlossary(next);
            if (voiceMap && voiceMap.mappings[name]) {
              const rest = { ...voiceMap.mappings };
              delete rest[name];
              const nextMap: VoiceMap = {
                ...voiceMap,
                mappings: rest,
                updatedAt: new Date().toISOString(),
              };
              setVoiceMap(nextMap);
              pipeline.setVoiceMap(nextMap);
            }
          },
        },
      ]);
    },
    [glossary, pipeline, voiceMap],
  );

  const rebuild = useCallback(async () => {
    if (!glossary) return;
    Alert.alert(
      'Re-cast voices?',
      'Voices will be re-assigned automatically; user overrides will be lost.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Re-cast',
          style: 'destructive',
          onPress: async () => {
            const newMap = new VoiceCaster().buildVoiceMap(glossary);
            setVoiceMap(newMap);
            await pipeline.setVoiceMap(newMap);
            showToast('Voices re-cast');
          },
        },
      ],
    );
  }, [glossary, pipeline]);

  if (!glossary) {
    return (
      <SafeAreaView excludeTop>
        <Appbar
          title="Cast"
          handleGoBack={() => navigation.goBack()}
          theme={theme}
        />
        <View style={styles.center}>
          <Text style={{ color: theme.onSurfaceVariant }}>
            No glossary yet. Process the novel through the audiobook
            pipeline first.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView excludeTop>
      <Appbar
        title={`Cast · ${novelName}`}
        handleGoBack={() => navigation.goBack()}
        theme={theme}
      />
      <ScrollView
        style={[{ backgroundColor: theme.background }, styles.flex]}
        contentContainerStyle={styles.padding}
      >
        <Text style={[styles.intro, { color: theme.onSurfaceVariant }]}>
          Tap a character to change their voice. The narrator reads
          everything that isn't dialogue.
        </Text>

        <CharacterRow
          character={null}
          label={`Narrator · ${glossary.narratorGender}`}
          voiceLabel={blendLabel(voiceMap?.mappings.narrator)}
          theme={theme}
          onEditVoice={() => setPicking('narrator')}
        />

        <Text style={[styles.section, { color: theme.onSurface }]}>
          Characters ({glossary.characters.length})
        </Text>

        {glossary.characters.map(c => (
          <CharacterRow
            key={c.name}
            character={c}
            label={c.name}
            voiceLabel={blendLabel(voiceMap?.mappings[c.name])}
            theme={theme}
            isEditing={editing === c.name}
            onToggleEdit={() => setEditing(editing === c.name ? null : c.name)}
            onChange={patch => updateCharacter(c.name, patch)}
            onDelete={() => deleteCharacter(c.name)}
            onEditVoice={() => setPicking(c.name)}
          />
        ))}

        <View style={styles.actions}>
          <Button title="Re-cast voices" mode="outlined" onPress={rebuild} />
          <Button
            title="Done"
            mode="contained"
            onPress={() => navigation.goBack()}
          />
        </View>
      </ScrollView>

      <VoicePickerSheet
        visible={picking !== null}
        speaker={picking ?? ''}
        voiceMap={voiceMap}
        onDismiss={() => setPicking(null)}
        onApply={async voice => {
          if (!voiceMap || !picking) return;
          const updated = new VoiceCaster().overrideVoice(voiceMap, picking, voice);
          setVoiceMap(updated);
          await pipeline.setVoiceMap(updated);
          setPicking(null);
        }}
      />
    </SafeAreaView>
  );
};

const CharacterRow: React.FC<{
  character: Character | null;
  label: string;
  voiceLabel: string;
  theme: ReturnType<typeof useTheme>;
  isEditing?: boolean;
  onToggleEdit?: () => void;
  onChange?: (patch: Partial<Character>) => void;
  onDelete?: () => void;
  onEditVoice: () => void;
}> = ({
  character,
  label,
  voiceLabel,
  theme,
  isEditing,
  onToggleEdit,
  onChange,
  onDelete,
  onEditVoice,
}) => (
  <View
    style={[
      styles.row,
      { backgroundColor: theme.surface, borderColor: theme.outline },
    ]}
  >
    <View style={styles.rowHeader}>
      <Text style={[styles.rowLabel, { color: theme.onSurface }]}>{label}</Text>
      <View style={styles.rowBtns}>
        <TouchableOpacity onPress={onEditVoice}>
          <Text style={[styles.rowAction, { color: theme.primary }]}>
            Voice
          </Text>
        </TouchableOpacity>
        {character ? (
          <>
            <TouchableOpacity onPress={onToggleEdit}>
              <Text
                style={[styles.rowAction, { color: theme.onSurfaceVariant }]}
              >
                {isEditing ? 'Close' : 'Edit'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onDelete}>
              <Text
                style={[
                  styles.rowAction,
                  { color: theme.error ?? '#cc3333' },
                ]}
              >
                Remove
              </Text>
            </TouchableOpacity>
          </>
        ) : null}
      </View>
    </View>
    <Text style={[styles.rowVoice, { color: theme.onSurfaceVariant }]}>
      {voiceLabel}
    </Text>
    {character?.description ? (
      <Text
        numberOfLines={2}
        style={[styles.rowDesc, { color: theme.onSurfaceVariant }]}
      >
        {character.description}
      </Text>
    ) : null}
    {character && isEditing ? (
      <View style={styles.editPanel}>
        <Field
          label="Aliases (comma-separated)"
          value={character.aliases.join(', ')}
          onChangeText={t =>
            onChange?.({
              aliases: t
                .split(',')
                .map(s => s.trim())
                .filter(Boolean),
            })
          }
          theme={theme}
        />
        <Field
          label="Personality"
          value={character.personality.join(', ')}
          onChangeText={t =>
            onChange?.({
              personality: t
                .split(',')
                .map(s => s.trim())
                .filter(Boolean),
            })
          }
          theme={theme}
        />
        <Field
          label="Voice hints"
          value={character.voiceHints.join(', ')}
          onChangeText={t =>
            onChange?.({
              voiceHints: t
                .split(',')
                .map(s => s.trim())
                .filter(Boolean),
            })
          }
          theme={theme}
        />
        <Field
          label="Pronunciation override"
          value={character.pronunciation ?? ''}
          placeholder="Leave empty to use the name"
          onChangeText={t => onChange?.({ pronunciation: t })}
          theme={theme}
        />
        <Field
          label="Description"
          value={character.description}
          multiline
          onChangeText={t => onChange?.({ description: t })}
          theme={theme}
        />
        <View style={styles.genderRow}>
          {(['male', 'female', 'neutral'] as const).map(g => (
            <TouchableOpacity
              key={g}
              onPress={() => onChange?.({ gender: g })}
              style={[
                styles.gChip,
                {
                  backgroundColor:
                    character.gender === g
                      ? theme.primary
                      : theme.surfaceVariant,
                },
              ]}
            >
              <Text
                style={{
                  color:
                    character.gender === g ? theme.onPrimary : theme.onSurface,
                }}
              >
                {g}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    ) : null}
  </View>
);

const Field: React.FC<{
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onChangeText: (t: string) => void;
  theme: ReturnType<typeof useTheme>;
}> = ({ label, value, placeholder, multiline, onChangeText, theme }) => (
  <View style={styles.field}>
    <Text style={[styles.fieldLabel, { color: theme.onSurfaceVariant }]}>
      {label}
    </Text>
    <TextInput
      style={[
        styles.input,
        {
          color: theme.onSurface,
          borderColor: theme.outline,
          backgroundColor: theme.surfaceVariant,
        },
      ]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.onSurfaceVariant}
      multiline={multiline}
    />
  </View>
);

function blendLabel(voice?: { components: { voiceId: string; weight: number }[]; speed: number }) {
  if (!voice) return 'No voice assigned';
  const top = [...voice.components].sort((a, b) => b.weight - a.weight)[0];
  return `${top.voiceId} primary · ${voice.speed.toFixed(2)}× speed`;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  padding: { padding: 16, paddingBottom: 80 },
  intro: { fontSize: 13, marginBottom: 16 },
  section: {
    fontSize: 14,
    fontWeight: '700',
    marginTop: 24,
    marginBottom: 8,
  },
  row: {
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowLabel: { fontSize: 16, fontWeight: '600' },
  rowBtns: { flexDirection: 'row', gap: 12 },
  rowAction: { fontSize: 13, fontWeight: '600' },
  rowVoice: { fontSize: 12, marginTop: 4 },
  rowDesc: { fontSize: 12, marginTop: 6 },
  editPanel: { marginTop: 12, gap: 8 },
  field: { marginBottom: 4 },
  fieldLabel: { fontSize: 12, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
  },
  genderRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  gChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
    gap: 8,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});

export default GlossaryEditorScreen;
